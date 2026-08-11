package dev.yammer.core

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import kotlin.math.ceil

/**
 * Scores wake-word classifiers over the shared feature pipeline.
 *
 * Ported from `openwakeword/model.py`. Owns one [AudioFeatures] — the
 * melspectrogram and embedding models are shared by every wake word, which is
 * what keeps a second wake word nearly free — and one small classifier per word.
 *
 * [predict] is the library's `Model.predict(threshold=, debounce_time=)`: it
 * returns scores that have already been through warmup zeroing and the
 * refractory debounce, so a caller sees a threshold crossing at most once per
 * spoken word.
 */
class WakeWordModel(
    private val env: OrtEnvironment,
    models: ModelSource,
    classifiers: Map<String, String>,
    val audioFeatures: AudioFeatures = AudioFeatures(env, models),
) : WakeWordScorer, AutoCloseable {

    private val sessions: Map<String, OrtSession> =
        classifiers.mapValues { (_, file) -> env.loadSession(models, file) }

    /**
     * The bundled models do not agree on what their input is called — it is
     * `x.1` for `hey_jarvis` and `onnx::Flatten_0` for `alexa`, both of which
     * are whatever the exporter happened to emit. Hardcoding either works for
     * exactly one model.
     */
    private val inputNames: Map<String, String> =
        sessions.mapValues { (_, session) -> session.inputNames.first() }

    private val predictions: Map<String, ArrayDeque<Float>> =
        classifiers.keys.associateWith { ArrayDeque<Float>() }

    /** The wake words this instance scores, in the order it reports them. */
    val names: Set<String> get() = sessions.keys

    /** Raw model outputs alongside what gating left of them. */
    data class Prediction(val raw: Map<String, Float>, val gated: Map<String, Float>)

    override fun predict(
        block: ShortArray,
        thresholds: Map<String, Double>,
        refractorySeconds: Double,
    ): Map<String, Float> = process(block, thresholds, refractorySeconds).gated

    /** [predict], but also returning the ungated scores — used by the tests. */
    fun process(
        block: ShortArray,
        thresholds: Map<String, Double>,
        refractorySeconds: Double,
    ): Prediction {
        audioFeatures.process(block)
        val raw = score(audioFeatures.features())
        return Prediction(raw, gate(raw, thresholds, debounceFrames(refractorySeconds)))
    }

    /** Scores one (1, 16, 96) feature vector against every classifier. */
    fun score(features: FloatArray): Map<String, Float> {
        require(features.size == AudioFeatures.CLASSIFIER_FRAMES * AudioFeatures.EMBEDDING_DIMS) {
            "expected ${AudioFeatures.CLASSIFIER_FRAMES * AudioFeatures.EMBEDDING_DIMS} " +
                "feature values, got ${features.size}"
        }
        val shape = longArrayOf(
            1,
            AudioFeatures.CLASSIFIER_FRAMES.toLong(),
            AudioFeatures.EMBEDDING_DIMS.toLong(),
        )
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(features), shape).use { tensor ->
            sessions.mapValues { (name, session) ->
                session.run(mapOf(inputNames.getValue(name) to tensor)).use { result ->
                    result.flat(0).data[0]
                }
            }
        }
    }

    /**
     * Warmup zeroing and the refractory debounce, in openWakeWord's order.
     *
     * Two details that are easy to get wrong and give no other signal:
     *
     * - The debounce window is checked against the prediction buffer, and the
     *   **gated** score is what gets appended to it. A suppressed detection
     *   therefore does not extend its own refractory period.
     * - Warmup is counted per model in frames scored, not in samples seen.
     */
    fun gate(
        raw: Map<String, Float>,
        thresholds: Map<String, Double>,
        debounceFrames: Int,
    ): Map<String, Float> {
        val gated = LinkedHashMap<String, Float>(raw.size)
        for ((name, score) in raw) {
            val history = predictions.getValue(name)
            val threshold = thresholds.getValue(name)
            var value = if (history.size < WARMUP_FRAMES) 0.0f else score
            if (value != 0.0f && value >= threshold) {
                val from = maxOf(0, history.size - debounceFrames)
                if ((from until history.size).any { history[it] >= threshold }) value = 0.0f
            }
            gated[name] = value
        }
        for ((name, value) in gated) {
            val history = predictions.getValue(name)
            history.addLast(value)
            while (history.size > PREDICTION_BUFFER_MAX) history.removeFirst()
        }
        return gated
    }

    /**
     * Clears the prediction buffers and the feature pipeline.
     *
     * Unlike the library's `Model.reset()`, this is cheap: the silence seed is
     * computed once at construction and copied back, rather than re-embedded
     * from four seconds of fresh random audio every time.
     */
    override fun reset() {
        predictions.values.forEach { it.clear() }
        audioFeatures.reset()
    }

    override fun close() {
        sessions.values.forEach { it.close() }
        audioFeatures.close()
    }

    companion object {
        /** Model outputs are forced to zero until this many frames are scored. */
        const val WARMUP_FRAMES = 5
        const val PREDICTION_BUFFER_MAX = 30

        /** How many scored frames a refractory period covers. 1.5 s -> 19. */
        fun debounceFrames(refractorySeconds: Double): Int =
            ceil(refractorySeconds / AudioFeatures.BLOCK_SECONDS).toInt()

        /** The filename openWakeWord gives a bundled model. */
        fun bundledFile(name: String): String = "${name}_v0.1.onnx"
    }
}
