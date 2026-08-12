package dev.yammer.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The turn state machine, driven block by block.
 *
 * Everything the client does is a function of two streams — capture blocks and
 * server frames — and everything the server can see is what came back out of
 * [Transport]. So the fakes here are the whole environment: scripted wake-word
 * and VAD scores in, recorded frames and earcons out. No audio, no models, no
 * socket.
 *
 * That is deliberate rather than convenient. The pipeline that turns audio into
 * a wake-word score is already pinned to a fixture by `WakeWordDetectorTest`;
 * what is untested until here is the part that decides what a *detection means*,
 * and the cases that matter in that layer — a second start word mid-utterance, a
 * permission ask arriving while the user is still talking — are ones real audio
 * cannot reliably arrange.
 */
class YammerClientTest {

    private var wakeConfig = WakeWordConfig()
    private var vadConfig = VadConfig()

    private val wake = ScriptedWake()
    private val voice = ScriptedVoice()
    private val transport = FakeTransport()
    private val speaker = RecordingSpeaker()

    /** Built on first use, so a test can adjust the config above before connecting. */
    private val client: YammerClient by lazy {
        YammerClient(
            ClientConfig(token = TOKEN, wake = wakeConfig, vad = vadConfig),
            WakeWordDetector(wakeConfig, wake),
            SpeechGate(vadConfig, voice),
            speaker,
        )
    }

    // --- connection --------------------------------------------------------

    @Test
    fun `hello is the first frame and carries the token`() {
        client.onOpen(transport)

        assertEquals(listOf("hello"), transport.types())
        val hello = transport.frame(0)
        assertEquals(TOKEN, hello.text("token"))
        assertEquals(2, hello.number("proto")?.toInt())
        assertEquals(CLIENT_ID, hello.text("client"))
        assertTrue(transport.binaries.isEmpty())
        assertNull(speaker.format, "playback cannot open before the server declares its rate")
    }

    /**
     * Kokoro's 24 kHz is a fallback, not an assumption. A client that ignored
     * this would play every reply — and every earcon — at the wrong speed.
     */
    @Test
    fun `hello_ok sets the playback format the server declared`() {
        connect(rate = 22_050)

        assertEquals(AudioFormat("pcm_s16le", 22_050, 1), speaker.format)
        assertEquals(22_050, client.speechFormat.rate)
        assertTrue(client.connected)

        say(Wake.START)
        assertContentEquals(Earcons.pcm(Earcons.Earcon.START_RECORD, 22_050), speaker.played.last())
    }

    @Test
    fun `a control frame before hello_ok is a protocol violation`() {
        client.onOpen(transport)
        client.onText("""{"t":"turn.accepted","turn":1}""")

        assertEquals(CloseCode.PROTOCOL_VIOLATION, transport.closed?.first)
        assertEquals(listOf(Earcons.Earcon.ERROR), earcons())
        assertEquals(YammerClient.State.IDLE, client.state)
    }

    @Test
    fun `a binary frame before hello_ok is a protocol violation`() {
        client.onOpen(transport)
        client.onBinary(Protocol.encodeAudioFrame(0, byteArrayOf(0, 0)))

        assertEquals(CloseCode.PROTOCOL_VIOLATION, transport.closed?.first)
        assertEquals(listOf(Earcons.Earcon.ERROR), earcons())
    }

    @Test
    fun `a close releases the speaker and returns to idle`() {
        connect()
        say(Wake.START)
        client.onClosed(CloseCode.ALREADY_CONNECTED, "client already connected")

        assertEquals(YammerClient.State.IDLE, client.state)
        assertEquals(1, speaker.closes)
        assertTrue(!client.connected)
    }

    // --- recording ---------------------------------------------------------

    @Test
    fun `the start word begins turn 1 and plays the start earcon`() {
        connect()
        transport.clear()

        say(Wake.START)

        assertEquals(listOf("utterance.begin"), transport.types())
        assertEquals(1L, transport.frame(0).number("turn"))
        assertEquals(1L, client.turn)
        assertEquals(YammerClient.State.RECORDING, client.state)
        assertEquals(listOf(Earcons.Earcon.START_RECORD), earcons())
    }

    /**
     * The block a wake word was found in holds the word itself, so buffering it
     * would put "hey jarvis" at the front of every prompt.
     */
    @Test
    fun `the block containing the wake word is not buffered`() {
        wakeConfig = WakeWordConfig(stopTrimSeconds = 0.0)
        connect()

        say(Wake.START)
        val spoken = listOf(quiet(), quiet(), quiet())
        say(Wake.STOP)

        assertContentEquals(spoken.flatMap { it.toList() }, sentAudio().toList())
    }

    @Test
    fun `the stop word trims the tail and closes the utterance`() {
        connect()
        say(Wake.START)
        val spoken = List(20) { quiet() }
        transport.clear()
        speaker.clear()

        say(Wake.STOP)

        // 0.7 s at 16 kHz is 11200 samples, rounded down to 8 whole 1280-sample
        // capture blocks. The trim comes off the *tail*: the first 12 blocks
        // survive intact and the last 8 are gone.
        val kept = spoken.take(12).flatMap { it.toList() }
        assertContentEquals(kept, sentAudio().toList())
        assertEquals(listOf("utterance.end"), transport.types())
        assertEquals(1L, transport.frame(0).number("turn"))
        assertEquals(YammerClient.State.WAITING, client.state)
        assertEquals(listOf(Earcons.Earcon.STOP_RECORD), earcons())
    }

    /** 15360 samples is 8192 + 7168: the second frame is a partial one. */
    @Test
    fun `the buffer goes out in 16 KiB frames`() {
        connect()
        say(Wake.START)
        repeat(20) { quiet() }
        transport.clear()

        say(Wake.STOP)

        assertEquals(
            listOf(4 + 8192 * 2, 4 + 7168 * 2),
            transport.binaries.map { it.size },
        )
        transport.binaries.forEach { assertEquals(1L, Protocol.decodeAudioFrame(it).turn) }
    }

    /**
     * Two wake words spoken back to back leave less audio than the trim. Sending
     * nothing is right — but `utterance.end` still has to go, or the server sits
     * on an open turn that only a disconnect closes.
     */
    @Test
    fun `an utterance shorter than the trim sends no audio but still ends`() {
        connect()
        say(Wake.START)
        repeat(4) { quiet() }
        transport.clear()

        say(Wake.STOP)

        assertTrue(transport.binaries.isEmpty())
        assertEquals(listOf("utterance.end"), transport.types())
        assertEquals(YammerClient.State.WAITING, client.state)
    }

    /** "Wait, let me say that again." */
    @Test
    fun `the start word mid-recording cancels and re-arms`() {
        wakeConfig = WakeWordConfig(stopTrimSeconds = 0.0)
        connect()
        say(Wake.START)
        repeat(3) { quiet() }
        transport.clear()

        say(Wake.START)

        assertEquals(listOf("utterance.cancel", "utterance.begin"), transport.types())
        assertEquals(1L, transport.frame(0).number("turn"))
        assertEquals("restart", transport.frame(0).text("reason"))
        assertEquals(2L, transport.frame(1).number("turn"))
        assertEquals(2L, client.turn)

        // The discarded audio must not reappear in the new utterance.
        val second = listOf(quiet(), quiet())
        transport.clear()
        say(Wake.STOP)
        assertContentEquals(second.flatMap { it.toList() }, sentAudio().toList())
    }

    /**
     * The server rejects a second turn too, but only after a round trip. Doing it
     * locally is what makes the busy earcon land while the user is still drawing
     * breath rather than a sentence later.
     */
    @Test
    fun `the start word while a turn is in flight is rejected locally`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        transport.clear()
        speaker.clear()

        say(Wake.START)

        assertTrue(transport.types().isEmpty(), "nothing may reach the server")
        assertEquals(listOf(Earcons.Earcon.BUSY), earcons())
        assertEquals(YammerClient.State.WAITING, client.state)
        assertEquals(1L, client.turn)
    }

    @Test
    fun `the stop word outside recording does nothing`() {
        connect()
        transport.clear()

        say(Wake.STOP)

        assertTrue(transport.types().isEmpty())
        assertTrue(speaker.played.isEmpty())
        assertEquals(YammerClient.State.IDLE, client.state)
    }

    @Test
    fun `turn_rejected discards the buffer and returns to idle`() {
        wakeConfig = WakeWordConfig(stopTrimSeconds = 0.0)
        connect()
        say(Wake.START)
        repeat(3) { quiet() }
        transport.clear()
        speaker.clear()

        client.onText("""{"t":"turn.rejected","turn":1,"reason":"busy"}""")

        assertEquals(YammerClient.State.IDLE, client.state)
        assertEquals(listOf(Earcons.Earcon.BUSY), earcons())

        // Nothing buffered survives into the next utterance.
        say(Wake.START)
        val second = listOf(quiet())
        transport.clear()
        say(Wake.STOP)
        assertContentEquals(second.flatMap { it.toList() }, sentAudio().toList())
    }

    // --- permission answers ------------------------------------------------

    @Test
    fun `permission_ask opens the answer window and plays the earcon`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        speaker.clear()

        ask()

        assertEquals(YammerClient.State.ANSWERING, client.state)
        assertEquals(listOf(Earcons.Earcon.PERMISSION), earcons())
    }

    /**
     * A reprompt re-arms the window without replaying the earcon over the top of
     * the supervisor asking the question a second time.
     */
    @Test
    fun `a reprompt re-arms without a second earcon`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        speaker.clear()

        ask(attempt = 1)

        assertEquals(YammerClient.State.ANSWERING, client.state)
        assertTrue(earcons().isEmpty())
    }

    /** "Hey jarvis" is not an answer to "approve or deny". */
    @Test
    fun `wake words are suspended while answering`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        transport.clear()
        val before = wake.calls

        say(Wake.START)
        say(Wake.STOP)

        assertEquals(before, wake.calls, "the detector must not even be consulted")
        assertTrue(transport.types().isEmpty())
        assertEquals(YammerClient.State.ANSWERING, client.state)
    }

    @Test
    fun `an answer carries its pre-roll and closes on trailing silence`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        transport.clear()

        // Onset needs 2 voiced blocks; the pre-roll keeps the last 5 seen,
        // including the two that opened the window.
        val before = List(3) { silence() }
        val onset = List(2) { speech() }
        val rest = List(10) { silence() }

        assertEquals(listOf("answer.begin", "answer.end"), transport.types())
        assertEquals(REQUEST_ID, transport.frame(0).text("id"))
        assertEquals(1L, transport.frame(0).number("turn"))

        // 0.4 s of pre-roll is five blocks, which is exactly `before + onset`.
        // Every block appears once: the block that triggered onset is already in
        // the pre-roll, and appending it again would duplicate 80 ms.
        val expected = (before + onset + rest).flatMap { it.toList() }
        assertContentEquals(expected, sentAudio().toList())
        assertEquals(YammerClient.State.ANSWERING, client.state, "the window closes on resolved, not on silence")
    }

    /**
     * Barge-in. The supervisor is mid-question when the user answers, so what is
     * already queued has to go — otherwise they hear the rest of a question they
     * have just answered.
     */
    @Test
    fun `answering over the supervisor flushes playback`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()

        assertEquals(0, speaker.flushes)
        repeat(2) { speech() }
        assertEquals(1, speaker.flushes)
    }

    @Test
    fun `an empty window reports a timeout and re-arms`() {
        vadConfig = VadConfig(answerSeconds = 0.4)
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        transport.clear()

        repeat(5) { silence() }
        assertEquals(listOf("answer.timeout"), transport.types())
        assertEquals(REQUEST_ID, transport.frame(0).text("id"))

        // The counter resets, so a server that reprompts gets told again.
        repeat(5) { silence() }
        assertEquals(listOf("answer.timeout", "answer.timeout"), transport.types())
        assertTrue(transport.binaries.isEmpty(), "silence is not audio")
    }

    @Test
    fun `permission_resolved closes the window and resets both detectors`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        val wakeResets = wake.resets
        val voiceResets = voice.resets

        client.onText("""{"t":"permission.resolved","turn":1,"id":"$REQUEST_ID","response":"once"}""")

        assertEquals(YammerClient.State.WAITING, client.state)
        // The supervisor's own voice is in the wake-word buffer by now.
        assertEquals(wakeResets + 1, wake.resets)
        assertTrue(voice.resets > voiceResets)
    }

    /** Nobody answered. The error earcon is the only signal the user gets. */
    @Test
    fun `a timed-out permission plays the error earcon`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        speaker.clear()

        client.onText("""{"t":"permission.resolved","turn":1,"id":"$REQUEST_ID","response":"timeout"}""")

        assertEquals(listOf(Earcons.Earcon.ERROR), earcons())
        assertEquals(YammerClient.State.WAITING, client.state)
    }

    // --- playback ----------------------------------------------------------

    @Test
    fun `speech for a stale turn is dropped`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        speaker.clear()

        client.onBinary(Protocol.encodeAudioFrame(99, byteArrayOf(1, 0, 2, 0)))
        assertTrue(speaker.played.isEmpty())

        client.onBinary(Protocol.encodeAudioFrame(1, byteArrayOf(1, 0, 2, 0)))
        assertContentEquals(shortArrayOf(1, 2), speaker.played.single())
    }

    @Test
    fun `supervisor speech is dropped once the answer has started`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()
        speaker.clear()

        client.onBinary(Protocol.encodeAudioFrame(1, byteArrayOf(1, 0)))
        assertEquals(1, speaker.played.size, "before onset the question still plays")

        repeat(2) { speech() }
        speaker.clear()
        client.onBinary(Protocol.encodeAudioFrame(1, byteArrayOf(1, 0)))
        assertTrue(speaker.played.isEmpty())
    }

    // --- turn end ----------------------------------------------------------

    @Test
    fun `turn_end returns to idle and resets the detector`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        val resets = wake.resets

        client.onText("""{"t":"turn.end","turn":1,"outcome":"forwarded"}""")

        assertEquals(YammerClient.State.IDLE, client.state)
        assertEquals(resets + 1, wake.resets)
    }

    /** A supervisor failure ends the turn with an answer window still open. */
    @Test
    fun `turn_end while answering tears the window down`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        ask()

        client.onText("""{"t":"turn.end","turn":1,"outcome":"error"}""")

        assertEquals(YammerClient.State.IDLE, client.state)

        // And the window is really gone: capture goes back to wake words.
        transport.clear()
        say(Wake.START)
        assertEquals(listOf("utterance.begin"), transport.types())
        assertEquals(2L, client.turn)
    }

    @Test
    fun `an error plays the error earcon without ending the turn`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        speaker.clear()

        client.onText("""{"t":"error","turn":1,"code":"stt_empty","message":"I didn't catch that."}""")

        assertEquals(listOf(Earcons.Earcon.ERROR), earcons())
        // turn.end is what returns to idle; the spoken explanation comes first.
        assertEquals(YammerClient.State.WAITING, client.state)
    }

    @Test
    fun `advisory and unknown messages are ignored`() {
        connect()
        say(Wake.START)
        say(Wake.STOP)
        transport.clear()
        speaker.clear()

        client.onText("""{"t":"turn.status","turn":1,"state":"transcribing"}""")
        client.onText("""{"t":"transcript","turn":1,"text":"add a test"}""")
        client.onText("""{"t":"speech.begin","turn":1,"seg":0,"voice":"agent"}""")
        client.onText("""{"t":"speech.end","turn":1,"seg":0}""")
        client.onText("""{"t":"turn.progress","turn":1,"percent":40}""")

        assertTrue(transport.types().isEmpty())
        assertTrue(speaker.played.isEmpty())
        assertEquals(YammerClient.State.WAITING, client.state)
    }

    // --- harness -----------------------------------------------------------

    private var blockId = 0

    /** A capture block whose every sample is its own serial number. */
    private fun block(): ShortArray {
        val id = (++blockId).toShort()
        return ShortArray(AudioFeatures.BLOCK_SAMPLES) { id }
    }

    private fun connect(rate: Int = 24_000) {
        client.onOpen(transport)
        client.onText(
            """{"t":"hello.ok","proto":2,"server":"yammer-server/0.1.0",""" +
                """"audio":{"codec":"pcm_s16le","rate":$rate,"channels":1}}"""
        )
    }

    private fun say(which: Wake) {
        wake.next = which
        client.onCaptureBlock(block())
    }

    private fun quiet(): ShortArray = block().also { client.onCaptureBlock(it) }

    private fun speech(): ShortArray {
        voice.probability = 1.0
        return block().also { client.onCaptureBlock(it) }
    }

    private fun silence(): ShortArray {
        voice.probability = 0.0
        return block().also { client.onCaptureBlock(it) }
    }

    private fun ask(attempt: Int = 0) {
        client.onText(
            """{"t":"permission.ask","turn":1,"id":"$REQUEST_ID","attempt":$attempt,""" +
                """"question":"Say approve or deny."}"""
        )
    }

    /** Every binary frame's payload, concatenated, as samples. */
    private fun sentAudio(): ShortArray {
        val parts = transport.binaries.map { Protocol.samplesFromBytes(Protocol.decodeAudioFrame(it).pcm) }
        val out = ShortArray(parts.sumOf { it.size })
        var at = 0
        for (part in parts) {
            part.copyInto(out, at)
            at += part.size
        }
        return out
    }

    private fun earcons(): List<Earcons.Earcon> = speaker.earcons(client.speechFormat.rate)

    private companion object {
        const val TOKEN = "s3cret-token"
        const val REQUEST_ID = "per_ff18c0de"
    }
}

// --- fakes -----------------------------------------------------------------

private class FakeTransport : Transport {
    val texts = mutableListOf<String>()
    val binaries = mutableListOf<ByteArray>()
    var closed: Pair<Int, String>? = null

    override fun send(text: String) { texts.add(text) }
    override fun send(bytes: ByteArray) { binaries.add(bytes) }
    override fun close(code: Int, reason: String) { closed = code to reason }

    fun types(): List<String> = texts.map { frameAt(it).text("t")!! }
    fun frame(index: Int): JsonObject = frameAt(texts[index])

    fun clear() {
        texts.clear()
        binaries.clear()
    }

    private fun frameAt(raw: String) = Json.parseToJsonElement(raw).jsonObject
}

private fun JsonObject.text(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.number(key: String): Long? = this[key]?.jsonPrimitive?.content?.toLongOrNull()
