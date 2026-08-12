package dev.yammer.core

/**
 * Wake-word detection.
 *
 * Port of `client/src/yammer_client/wakeword.py`. Two distinct words bracket an
 * utterance: one starts recording, one stops it. Detection scans continuously
 * and can fire on the word appearing anywhere in the stream — it is not anchored
 * to utterance start.
 *
 * The stop word is authoritative: the server never decides on its own when an
 * utterance is finished.
 */

enum class Wake { START, STOP }

data class Detection(val which: Wake, val score: Float)

class WakeWordError(message: String) : Exception(message)

data class WakeWordConfig(
    val startModel: String = "hey_jarvis",
    val stopModel: String = "alexa",
    val startThreshold: Double = 0.5,
    val stopThreshold: Double = 0.5,
    /**
     * How much audio [YammerClient] drops from the end of the buffer when the
     * stop word fires. openWakeWord reports that a word was detected, not where
     * it began, so this is a fixed trim rather than a precise boundary: too
     * small and the stop word reaches OpenCode as part of the prompt, too large
     * and it eats the end of the sentence.
     */
    val stopTrimSeconds: Double = 0.7,
    /** Suppresses repeat fires from one spoken wake word. */
    val refractorySeconds: Double = 1.5,
)

/**
 * What [WakeWordDetector] needs from a scorer: gated scores per model.
 *
 * An interface rather than a direct dependency on [WakeWordModel] so the
 * detector's arbitration can be tested against scripted scores. Reproducing a
 * near-simultaneous match of two wake words with real audio is not something a
 * test can arrange.
 */
interface WakeWordScorer {
    fun predict(
        block: ShortArray,
        thresholds: Map<String, Double>,
        refractorySeconds: Double,
    ): Map<String, Float>

    fun reset()
}

/** Feeds capture blocks to a [WakeWordScorer] and reports threshold crossings. */
class WakeWordDetector(
    private val config: WakeWordConfig,
    private val scorer: WakeWordScorer,
) {
    private val startKey = modelKey(config.startModel)
    private val stopKey = modelKey(config.stopModel)
    private val thresholds = mapOf(
        startKey to config.startThreshold,
        stopKey to config.stopThreshold,
    )

    init {
        if (startKey == stopKey) {
            throw WakeWordError(
                "start and stop wake words must be different models, both resolve to '$startKey'"
            )
        }
    }

    /** Scores one capture block. Returns a detection on a threshold crossing. */
    fun process(block: ShortArray): Detection? {
        val scores = scorer.predict(block, thresholds, config.refractorySeconds)
        val start = scores[startKey] ?: 0.0f
        val stop = scores[stopKey] ?: 0.0f

        // Check the higher score first so that if both cross in the same block
        // (a rare near-simultaneous match) the stronger one wins rather than
        // start always taking precedence.
        return if (start >= stop) {
            when {
                start >= config.startThreshold -> Detection(Wake.START, start)
                stop >= config.stopThreshold -> Detection(Wake.STOP, stop)
                else -> null
            }
        } else {
            when {
                stop >= config.stopThreshold -> Detection(Wake.STOP, stop)
                start >= config.startThreshold -> Detection(Wake.START, start)
                else -> null
            }
        }
    }

    /**
     * Clears internal buffers, e.g. after a turn ends.
     *
     * Without this, audio from before the reset can still contribute to a
     * detection afterwards.
     */
    fun reset() = scorer.reset()

    companion object {
        /**
         * The key a model is reported under.
         *
         * Bundled models are keyed by their name, custom models by the filename
         * stem — the same rule openWakeWord applies, kept so that a custom
         * `hey_yammer.onnx` behaves identically on both clients.
         */
        fun modelKey(identifier: String): String {
            val looksLikeFile = '/' in identifier ||
                identifier.endsWith(".onnx") ||
                identifier.endsWith(".tflite")
            if (!looksLikeFile) return identifier
            return identifier.substringAfterLast('/').substringBeforeLast('.')
        }

        /** The asset each configured model resolves to. */
        fun modelFile(identifier: String): String =
            if ('/' in identifier || identifier.endsWith(".onnx")) {
                identifier
            } else {
                WakeWordModel.bundledFile(identifier)
            }
    }
}
