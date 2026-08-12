package dev.yammer.core

/**
 * The environment [YammerClient] runs in, faked.
 *
 * Shared between the scripted state-machine tests and the end-to-end run against
 * the real server, so both are driven the same way and a behaviour asserted in
 * one is expressed the same in the other.
 */

/**
 * Wake-word scores on demand.
 *
 * [WakeWordScorer] exists for exactly this: reproducing a start word arriving
 * three blocks into an utterance is a matter of setting a field here, and not
 * something any recording could be relied on to do.
 */
internal class ScriptedWake : WakeWordScorer {
    var next: Wake? = null
    var calls = 0
    var resets = 0

    override fun predict(
        block: ShortArray,
        thresholds: Map<String, Double>,
        refractorySeconds: Double,
    ): Map<String, Float> {
        calls++
        val fire = next
        next = null
        return mapOf(
            "hey_jarvis" to if (fire == Wake.START) 0.9f else 0.0f,
            "alexa" to if (fire == Wake.STOP) 0.9f else 0.0f,
        )
    }

    override fun reset() { resets++ }
}

internal class ScriptedVoice : VoiceScorer {
    var probability = 0.0
    var resets = 0

    override fun predict(block: ShortArray): Double = probability
    override fun reset() { resets++ }
}

internal class RecordingSpeaker : Speaker {
    var format: AudioFormat? = null
    val played = mutableListOf<ShortArray>()
    var flushes = 0
    var closes = 0

    /** When the last buffer arrived, for waiting out a server that is still talking. */
    @Volatile
    var lastPlayedAt = 0L
        private set

    @Synchronized
    override fun open(format: AudioFormat) { this.format = format }

    @Synchronized
    override fun play(pcm: ShortArray) {
        played.add(pcm)
        lastPlayedAt = System.nanoTime()
    }

    @Synchronized
    override fun flush() { flushes++ }

    @Synchronized
    override fun close() { closes++ }

    @Synchronized
    fun clear() { played.clear() }

    /** Which of the five each played buffer was, by content. */
    @Synchronized
    fun earcons(rate: Int): List<Earcons.Earcon> = played.mapNotNull { pcm ->
        Earcons.Earcon.entries.firstOrNull { Earcons.pcm(it, rate).contentEquals(pcm) }
    }

    /** Everything that was not an earcon: the server's own speech. */
    @Synchronized
    fun speech(rate: Int): List<ShortArray> = played.filter { pcm ->
        Earcons.Earcon.entries.none { Earcons.pcm(it, rate).contentEquals(pcm) }
    }
}

/**
 * The client's log, kept.
 *
 * Several of the client's reactions are *only* a log line by design — a
 * `transcript` is logged rather than spoken, and a close code becomes a sentence
 * from `CLOSE_REASONS`. Asserting on those lines is asserting on the behaviour,
 * not on the logging.
 */
internal class RecordingLog(private val echo: Boolean = false) : ClientLog {
    private val lines = mutableListOf<String>()

    @Synchronized
    private fun add(level: String, message: String) {
        lines.add(message)
        if (echo) println("$level $message")
    }

    override fun debug(message: String) = add("DEBUG", message)
    override fun info(message: String) = add("INFO ", message)
    override fun warn(message: String) = add("WARN ", message)

    @Synchronized
    fun any(fragment: String): Boolean = lines.any { fragment in it }

    @Synchronized
    fun all(): List<String> = lines.toList()
}
