package dev.yammer.core

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer

/**
 * Silero VAD, framed the way `client/src/yammer_client/vad.py` frames it.
 *
 * The bundled copy is Silero **v4**, which takes a configurable frame size and
 * requires the input to be an exact multiple of it — the 512-sample framing v5
 * insists on does not apply. Capture blocks are 1280 samples, so 320 (20 ms)
 * divides evenly.
 *
 * The LSTM state carries across frames, which is the whole point: probabilities
 * depend on what came before. [reset] is therefore mandatory between answer
 * windows, not an optimization.
 */
class SileroVad(
    private val env: OrtEnvironment,
    models: ModelSource,
    private val frameSamples: Int = FRAME_SAMPLES,
) : VoiceScorer, AutoCloseable {

    private val session: OrtSession = env.loadSession(models, VAD_MODEL)

    /** Constant, so it is built once rather than per 20 ms frame. */
    private val sampleRate: OnnxTensor =
        OnnxTensor.createTensor(env, AudioFeatures.SAMPLE_RATE.toLong())

    private var h = FloatArray(STATE_SIZE)
    private var c = FloatArray(STATE_SIZE)

    /** Speech probability per 20 ms frame of [block]. */
    fun frames(block: ShortArray): DoubleArray {
        require(block.size % frameSamples == 0) {
            "block of ${block.size} samples is not a multiple of $frameSamples"
        }
        val out = DoubleArray(block.size / frameSamples)
        for (frame in out.indices) {
            val offset = frame * frameSamples
            // The divisor is 32767, not 32768, and the division happens in
            // double before the narrowing — inaudible either way, but not
            // irrelevant to a golden-vector comparison.
            val chunk = FloatArray(frameSamples) { (block[offset + it] / 32767.0).toFloat() }
            out[frame] = runFrame(chunk).toDouble()
        }
        return out
    }

    /** Mean speech probability across [block]. */
    override fun predict(block: ShortArray): Double = frames(block).average()

    override fun reset() {
        h = FloatArray(STATE_SIZE)
        c = FloatArray(STATE_SIZE)
    }

    private fun runFrame(chunk: FloatArray): Float {
        val stateShape = longArrayOf(STATE_LAYERS, 1, STATE_DIMS)
        OnnxTensor.createTensor(env, FloatBuffer.wrap(chunk), longArrayOf(1, chunk.size.toLong()))
            .use { input ->
                OnnxTensor.createTensor(env, FloatBuffer.wrap(h), stateShape).use { hIn ->
                    OnnxTensor.createTensor(env, FloatBuffer.wrap(c), stateShape).use { cIn ->
                        val inputs = mapOf(
                            "input" to input,
                            "h" to hIn,
                            "c" to cIn,
                            "sr" to sampleRate,
                        )
                        session.run(inputs).use { result ->
                            val probability = result.flat(0).data[0]
                            h = result.flat(1).data
                            c = result.flat(2).data
                            return probability
                        }
                    }
                }
            }
    }

    override fun close() {
        sampleRate.close()
        session.close()
    }

    companion object {
        const val VAD_MODEL = "silero_vad.onnx"

        /** 20 ms. Divides 1280 evenly; fine enough to catch onset quickly. */
        const val FRAME_SAMPLES = 320

        private const val STATE_LAYERS = 2L
        private const val STATE_DIMS = 64L
        private const val STATE_SIZE = (STATE_LAYERS * STATE_DIMS).toInt()
    }
}
