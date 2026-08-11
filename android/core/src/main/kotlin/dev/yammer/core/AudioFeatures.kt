package dev.yammer.core

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer

/**
 * openWakeWord's streaming feature pipeline: PCM in, embedding frames out.
 *
 * Ported from `openwakeword/utils.py` by way of the reference implementation in
 * `client/tools/make_golden_vectors.py`, which was checked block-for-block
 * against the library before this file existed. Every constant below is one the
 * library picked; none of them are tunable, and a wrong one produces plausible
 * scores that simply never cross threshold. That is why this class is pinned to
 * `fixtures/wakeword/golden.json` rather than eyeballed.
 *
 * The chain per 80 ms block is: melspectrogram over the block plus a lookback →
 * append to a rolling mel buffer → one embedding frame from the trailing 76 mel
 * frames → append to a rolling feature buffer, whose last 16 frames are what a
 * wake-word classifier scores.
 *
 * Not thread-safe: one instance belongs to one capture loop.
 */
class AudioFeatures(
    private val env: OrtEnvironment,
    models: ModelSource,
) : AutoCloseable {

    private val melspec: OrtSession = env.loadSession(models, MELSPEC_MODEL)
    private val embedding: OrtSession = env.loadSession(models, EMBEDDING_MODEL)

    /**
     * The last (up to) 1760 samples handed to [process].
     *
     * openWakeWord keeps ten seconds of raw audio; only this much is ever read,
     * and on a phone the rest is a megabyte of nothing.
     */
    private val rawTail = ShortArray(BLOCK_SAMPLES + MELSPEC_LOOKBACK)
    private var rawFilled = 0

    private val melBuffer = ArrayDeque<FloatArray>()
    private val featureBuffer = ArrayDeque<FloatArray>()

    /**
     * Embeddings of four seconds of silence, computed once at construction.
     *
     * openWakeWord seeds this buffer with four seconds of *random* audio, which
     * makes its first ~16 blocks unreproducible; the fixture pins silence
     * instead and so does this. Caching the result is what makes [reset] free:
     * the library recomputes the seed on every reset — one melspectrogram over
     * 64000 samples plus a 41-window embedding batch — which is far too
     * expensive to do at the end of every turn.
     */
    private val seedFeatures: Array<FloatArray>

    /** Number of embedding frames the silence seed produces. Fixture: 41. */
    val seedFrames: Int get() = seedFeatures.size

    val melBufferFrames: Int get() = melBuffer.size
    val featureBufferFrames: Int get() = featureBuffer.size

    init {
        seedFeatures = embed(seedWindows())
        resetBuffers()
    }

    /**
     * Feeds one capture block and returns the mel frames it produced.
     *
     * The block must be exactly [BLOCK_SAMPLES]. openWakeWord accepts arbitrary
     * lengths by carrying a remainder between calls; the client only ever hands
     * it whole 80 ms blocks, so that machinery is omitted rather than ported
     * untested — `AudioIo` has to hold up its end.
     */
    fun process(block: ShortArray): Array<FloatArray> {
        require(block.size == BLOCK_SAMPLES) {
            "expected $BLOCK_SAMPLES samples, got ${block.size}"
        }

        pushRaw(block)

        // The melspectrogram runs over the new block plus three hops of the
        // preceding audio, so the windows straddling the block boundary see real
        // audio instead of padding. On the very first block there is no
        // preceding audio, so this yields 5 frames rather than 8 — a real edge
        // case the fixture records, not an off-by-one to "fix".
        val melFrames = melspectrogram(rawTail, rawFilled)
        for (frame in melFrames) melBuffer.addLast(frame)
        while (melBuffer.size > MEL_BUFFER_MAX_FRAMES) melBuffer.removeFirst()

        // One embedding frame per block, over the trailing 76 mel frames. The
        // buffer starts pre-filled to exactly 76, so this is never short — the
        // check mirrors the library, which guards against the same thing.
        if (melBuffer.size >= MEL_WINDOW_FRAMES) {
            val start = melBuffer.size - MEL_WINDOW_FRAMES
            val window = Array(MEL_WINDOW_FRAMES) { melBuffer[start + it] }
            featureBuffer.addLast(embed(arrayOf(window))[0])
        }
        while (featureBuffer.size > FEATURE_BUFFER_MAX_FRAMES) featureBuffer.removeFirst()

        return melFrames
    }

    /**
     * The classifier input: the trailing [CLASSIFIER_FRAMES] embedding frames,
     * flattened row-major into the (1, 16, 96) tensor the models expect.
     */
    fun features(): FloatArray {
        val start = featureBuffer.size - CLASSIFIER_FRAMES
        require(start >= 0) { "feature buffer holds ${featureBuffer.size} frames" }
        val out = FloatArray(CLASSIFIER_FRAMES * EMBEDDING_DIMS)
        for (i in 0 until CLASSIFIER_FRAMES) {
            featureBuffer[start + i].copyInto(out, i * EMBEDDING_DIMS)
        }
        return out
    }

    /**
     * Returns to the just-constructed state.
     *
     * Called between turns: without it, audio from before a turn can still
     * contribute to a detection after it.
     */
    fun reset() = resetBuffers()

    private fun resetBuffers() {
        rawFilled = 0
        melBuffer.clear()
        repeat(MEL_WINDOW_FRAMES) { melBuffer.addLast(FloatArray(MEL_BINS) { MEL_BUFFER_INIT }) }
        featureBuffer.clear()
        for (frame in seedFeatures) featureBuffer.addLast(frame)
    }

    /** Keeps the most recent [rawTail] samples, shifting the older ones down. */
    private fun pushRaw(block: ShortArray) {
        val overflow = rawFilled + block.size - rawTail.size
        if (overflow > 0) {
            rawTail.copyInto(rawTail, 0, overflow, rawFilled)
            rawFilled -= overflow
        }
        block.copyInto(rawTail, rawFilled)
        rawFilled += block.size
    }

    // -- model wrappers --

    /** PCM (int16) -> mel frames of [MEL_BINS] bins each, transformed. */
    internal fun melspectrogram(samples: ShortArray, count: Int = samples.size): Array<FloatArray> {
        val input = FloatArray(count) { samples[it].toFloat() }
        val shape = longArrayOf(1, count.toLong())
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(input), shape).use { tensor ->
            melspec.run(mapOf(MELSPEC_INPUT to tensor)).use { result ->
                val out = result.flat(0)
                val frames = out.data.size / MEL_BINS
                Array(frames) { f ->
                    FloatArray(MEL_BINS) { b -> melspecTransform(out.data[f * MEL_BINS + b]) }
                }
            }
        }
    }

    /** (batch, 76, 32) -> (batch, 96). */
    internal fun embed(windows: Array<Array<FloatArray>>): Array<FloatArray> {
        val batch = windows.size
        val input = FloatArray(batch * MEL_WINDOW_FRAMES * MEL_BINS)
        var at = 0
        for (window in windows) {
            require(window.size == MEL_WINDOW_FRAMES) {
                "expected $MEL_WINDOW_FRAMES mel frames, got ${window.size}"
            }
            for (frame in window) {
                frame.copyInto(input, at)
                at += MEL_BINS
            }
        }
        val shape = longArrayOf(batch.toLong(), MEL_WINDOW_FRAMES.toLong(), MEL_BINS.toLong(), 1)
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(input), shape).use { tensor ->
            embedding.run(mapOf(EMBEDDING_INPUT to tensor)).use { result ->
                val out = result.flat(0)
                Array(batch) { i ->
                    out.data.copyOfRange(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS)
                }
            }
        }
    }

    /**
     * Batch-embeds four seconds of silence the way the library's constructor
     * does: one melspectrogram over the whole clip, then every 76-frame window
     * at a stride of 8, all pushed through the embedding model at once.
     */
    private fun seedWindows(): Array<Array<FloatArray>> {
        val spec = melspectrogram(ShortArray(SEED_SAMPLES))
        val windows = ArrayList<Array<FloatArray>>()
        var i = 0
        while (i + MEL_WINDOW_FRAMES <= spec.size) {
            windows.add(Array(MEL_WINDOW_FRAMES) { spec[i + it] })
            i += MEL_WINDOW_STEP
        }
        return windows.toTypedArray()
    }

    override fun close() {
        melspec.close()
        embedding.close()
    }

    companion object {
        const val SAMPLE_RATE = 16_000

        /** 80 ms — the granularity openWakeWord accumulates to. */
        const val BLOCK_SAMPLES = 1280

        /** Three hops of preceding audio, so the boundary windows are real. */
        const val MELSPEC_LOOKBACK = 160 * 3

        const val MEL_BINS = 32

        /** `melspectrogram_buffer` starts as ones((76, 32)). */
        const val MEL_BUFFER_INIT = 1.0f
        const val MEL_BUFFER_MAX_FRAMES = 970
        const val MEL_WINDOW_FRAMES = 76
        const val MEL_WINDOW_STEP = 8

        const val EMBEDDING_DIMS = 96
        const val FEATURE_BUFFER_MAX_FRAMES = 120

        /** The classifier sees the last 16 embedding frames. */
        const val CLASSIFIER_FRAMES = 16

        /** Seeded with silence, not random audio — see [seedFeatures]. */
        const val SEED_SAMPLES = SAMPLE_RATE * 4

        const val MELSPEC_MODEL = "melspectrogram.onnx"
        const val EMBEDDING_MODEL = "embedding_model.onnx"

        private const val MELSPEC_INPUT = "input"
        private const val EMBEDDING_INPUT = "input_1"

        /** Seconds of audio in one capture block. */
        const val BLOCK_SECONDS = BLOCK_SAMPLES.toDouble() / SAMPLE_RATE

        /**
         * openWakeWord's default `melspec_transform`.
         *
         * Brings the ONNX melspectrogram model's output into the range Google's
         * original TensorFlow `speech_embedding` graph was trained against.
         * Omitting it is the single easiest way to get a pipeline that runs and
         * never fires.
         */
        fun melspecTransform(value: Float): Float = value / 10.0f + 2.0f
    }
}
