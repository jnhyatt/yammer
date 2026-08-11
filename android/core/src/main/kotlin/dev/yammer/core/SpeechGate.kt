package dev.yammer.core

import kotlin.math.max

/**
 * Voice activity detection for the permission answer window.
 *
 * Port of `client/src/yammer_client/vad.py`. Answers to a permission prompt are
 * not wake-word bracketed — saying "hey jarvis approve alexa" is absurd, and the
 * fixed stop-word trim would swallow a one-word answer whole. So the window is
 * delimited by speech itself: it opens when the server asks, starts capturing
 * when the user starts talking, and closes on trailing silence.
 *
 * **This deliberately does not replace the two-wake-word bracket on the main
 * utterance path.** Adaptive end-of-utterance detection is a non-goal, and for
 * good reason — VAD thresholds are twitchy in a way wake words are not. Its
 * scope here is one short answer to a direct question.
 */

data class VadConfig(
    /** Speech probability that counts as voiced. */
    val threshold: Double = 0.5,
    /** Consecutive voiced blocks needed to start capturing. */
    val onsetBlocks: Int = 2,
    /** Trailing silence that ends an answer. */
    val silenceSeconds: Double = 0.8,
    /** Audio kept from *before* onset. */
    val prerollSeconds: Double = 0.4,
    /** No speech at all for this long reports "no answer". */
    val answerSeconds: Double = 10.0,
)

/**
 * What [SpeechGate] needs from a VAD: one probability per capture block.
 *
 * [SileroVad] is the implementation; the interface exists so the gate's state
 * machine can be driven from scripted probabilities, where onset and offset
 * timing are exactly controllable.
 */
interface VoiceScorer {
    fun predict(block: ShortArray): Double
    fun reset()
}

/** What one block did to the gate. */
enum class Speech { NONE, START, END }

/**
 * Tracks speech onset and offset across a stream of capture blocks.
 *
 * Onset needs several consecutive speech blocks so a cough or a key press
 * doesn't open the window; offset needs a longer run of silence so a pause
 * between "approve" and nothing doesn't close it early.
 */
class SpeechGate(
    private val config: VadConfig,
    private val vad: VoiceScorer,
) {
    /**
     * Onset detection lags by design, so a one-word answer would lose its first
     * syllable without this. Everything here is prepended to the buffer when
     * speech starts.
     */
    private val prerollBlocks = max(1, (config.prerollSeconds / AudioFeatures.BLOCK_SECONDS).toInt())
    private val prerollBuffer = ArrayDeque<ShortArray>()

    var speaking: Boolean = false
        private set

    private var speechRun = 0
    private var silenceRun = 0

    /** Audio captured just before onset. Consumed when the window opens. */
    fun preroll(): ShortArray {
        val out = ShortArray(prerollBuffer.sumOf { it.size })
        var at = 0
        for (block in prerollBuffer) {
            block.copyInto(out, at)
            at += block.size
        }
        return out
    }

    fun score(block: ShortArray): Double = vad.predict(block)

    /** Feeds one capture block. */
    fun process(block: ShortArray): Speech {
        val voiced = score(block) >= config.threshold

        if (!speaking) {
            prerollBuffer.addLast(block)
            while (prerollBuffer.size > prerollBlocks) prerollBuffer.removeFirst()
            speechRun = if (voiced) speechRun + 1 else 0
            if (speechRun >= config.onsetBlocks) {
                speaking = true
                silenceRun = 0
                return Speech.START
            }
            return Speech.NONE
        }

        if (voiced) {
            silenceRun = 0
            return Speech.NONE
        }

        silenceRun += 1
        if (silenceRun * AudioFeatures.BLOCK_SECONDS >= config.silenceSeconds) {
            speaking = false
            speechRun = 0
            return Speech.END
        }
        return Speech.NONE
    }

    /** Clears state between answer windows. */
    fun reset() {
        speaking = false
        speechRun = 0
        silenceRun = 0
        prerollBuffer.clear()
        vad.reset()
    }
}
