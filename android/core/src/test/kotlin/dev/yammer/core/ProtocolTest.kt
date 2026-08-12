package dev.yammer.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Protocol conformance against the Python client.
 *
 * `fixtures/protocol/client-frames.json` is written by
 * `client/tools/dump_protocol_frames.py` from the *real* Python protocol module,
 * and `server/src/protocol.test.ts` decodes it with the *real* TypeScript
 * decoder. This is the third consumer, and the reason the fixture exists in that
 * form: a test that builds its own JSON and parses it back proves only that JSON
 * round-trips.
 *
 * ## What "the same frame" means here
 *
 * The comparison is on parsed JSON, not on bytes. Python's `json.dumps` writes
 * `{"t": "hello", ...}` with a space after each separator and kotlinx writes
 * `{"t":"hello",...}` without; insignificant whitespace is not the contract, and
 * matching it byte-for-byte would mean hand-rolling an encoder to imitate a
 * formatting default. What *is* compared is everything that survives a parser:
 * the key set, the values, and their JSON types — which is where the mismatches
 * that actually break a cross-language protocol live (`"2"` versus `2`).
 */
class ProtocolTest {

    private val fixture: JsonObject =
        Json.parseToJsonElement(
            File(Fixture.fixturesDir, "protocol/client-frames.json").readText()
        ).jsonObject

    private val constants get() = fixture.obj("constants")
    private val frames get() = fixture.obj("controlFrames")

    /** The generator's fixed arguments, read back rather than duplicated here. */
    private val turn: Long get() = parse(frames.str("utterance.begin")).long("turn")!!
    private val requestId: String get() = parse(frames.str("answer.begin")).string("id")!!

    @Test
    fun `constants agree with the Python client`() {
        assertEquals(constants.int("protocolVersion"), PROTOCOL_VERSION)
        assertEquals(constants.obj("captureFormat"), CAPTURE_FORMAT.toJson())
        assertEquals(constants.obj("defaultSpeechFormat"), DEFAULT_SPEECH_FORMAT.toJson())

        val codes = constants.obj("closeCodes")
        assertEquals(codes.int("AUTH_FAILED"), CloseCode.AUTH_FAILED)
        assertEquals(codes.int("UNSUPPORTED_PROTOCOL"), CloseCode.UNSUPPORTED_PROTOCOL)
        assertEquals(codes.int("PROTOCOL_VIOLATION"), CloseCode.PROTOCOL_VIOLATION)
        assertEquals(codes.keys, CLOSE_REASONS.keys.map { code -> nameOf(code) }.toSet())
    }

    /**
     * The one field that must *not* match. `client` exists so a line in the
     * server's log can be attributed to a device; two clients sending the same
     * string would make it useless.
     */
    @Test
    fun `the client identifies itself as the Android client`() {
        assertNotEquals(constants.str("clientId"), CLIENT_ID)
        assertEquals("yammer-android/0.1.0", CLIENT_ID)
        assertTrue(
            parse(Protocol.hello("x")).string("client") == CLIENT_ID,
            "hello must carry CLIENT_ID",
        )
    }

    @Test
    fun `every control frame matches the Python client's`() {
        val built = mapOf(
            "hello" to Protocol.hello(parse(frames.str("hello")).string("token")!!),
            "utterance.begin" to Protocol.utteranceBegin(turn),
            "utterance.end" to Protocol.utteranceEnd(turn),
            "utterance.cancel" to Protocol.utteranceCancel(
                turn,
                parse(frames.str("utterance.cancel")).string("reason")!!,
            ),
            "answer.begin" to Protocol.answerBegin(turn, requestId),
            "answer.end" to Protocol.answerEnd(turn, requestId),
            "answer.timeout" to Protocol.answerTimeout(turn, requestId),
        )

        // Every frame the fixture records, and no fewer: a client that silently
        // stopped emitting one would otherwise pass.
        assertEquals(frames.keys, built.keys, "the set of client frames differs")

        for ((name, actual) in built) {
            val expected = parse(frames.str(name)).toMutableMap()
            val got = parse(actual).toMutableMap()
            if (name == "hello") {
                expected.remove("client")
                got.remove("client")
            }
            assertEquals(expected, got, "$name differs from the Python client's")
        }
    }

    @Test
    fun `audio frames are byte-identical to the Python client's`() {
        for (entry in fixture.arr("audioFrames").map { it.jsonObject }) {
            val turn = entry.long("turn")!!
            val pcm = hex(entry.str("pcmHex"))
            assertEquals(
                entry.str("frameHex"),
                Protocol.encodeAudioFrame(turn, pcm).toHex(),
                "frame for turn $turn",
            )
        }
    }

    @Test
    fun `audio frames decode back to their turn tag and payload`() {
        for (entry in fixture.arr("audioFrames").map { it.jsonObject }) {
            val decoded = Protocol.decodeAudioFrame(hex(entry.str("frameHex")))
            assertEquals(entry.long("turn"), decoded.turn)
            assertEquals(entry.str("pcmHex"), decoded.pcm.toHex())
        }
    }

    /**
     * The fixture carries 4294967295 for one reason, and this is it. Held in an
     * `Int` the tag decodes to -1, every comparison against the current turn
     * fails, and the client silently drops every frame of the last turn before
     * the wrap.
     */
    @Test
    fun `the turn tag is unsigned`() {
        val frame = Protocol.encodeAudioFrame(Protocol.MAX_TURN, byteArrayOf(0xAB.toByte()))
        assertEquals("ffffffffab", frame.toHex())
        assertEquals(Protocol.MAX_TURN, Protocol.decodeAudioFrame(frame).turn)
        assertTrue(Protocol.decodeAudioFrame(frame).turn > 0, "the tag must not go negative")

        // And the client's own allocation wraps back to 1 rather than to 0.
        assertEquals(1L, YammerClient.nextTurn(Protocol.MAX_TURN))
        assertEquals(8L, YammerClient.nextTurn(7L))
    }

    @Test
    fun `framing from samples and from bytes agree`() {
        val samples = shortArrayOf(1, -2, 32767, -32768, 0)
        val bytes = byteArrayOf(1, 0, -2, -1, -1, 127, 0, -128, 0, 0)
        assertContentEquals(
            Protocol.encodeAudioFrame(7, bytes),
            Protocol.encodeAudioFrame(7, samples, 0, samples.size),
        )
        assertContentEquals(samples, Protocol.samplesFromBytes(bytes))

        // Offsets, because the flush path sends 8192-sample windows of one array.
        assertContentEquals(
            Protocol.encodeAudioFrame(7, byteArrayOf(-2, -1, -1, 127)),
            Protocol.encodeAudioFrame(7, samples, 1, 2),
        )
    }

    @Test
    fun `a trailing odd byte is dropped rather than thrown on`() {
        assertContentEquals(shortArrayOf(1), Protocol.samplesFromBytes(byteArrayOf(1, 0, 9)))
        assertContentEquals(shortArrayOf(), Protocol.samplesFromBytes(byteArrayOf()))
    }

    @Test
    fun `structurally invalid control frames are rejected`() {
        // The fixture's `rejected` list is the server's, and only its structural
        // entries are a client's business — see the next test for the rest.
        val structural = setOf("not JSON", "not an object", "no type tag")
        val checked = rejected().filter { it.str("why") in structural }
        assertEquals(structural.size, checked.size, "the fixture's structural cases moved")

        for (case in checked) {
            assertFailsWith<ProtocolError>(case.str("why")) {
                Protocol.decodeServerMessage(case.str("raw"))
            }
        }
        assertFailsWith<ProtocolError> { Protocol.decodeAudioFrame(byteArrayOf(1, 2, 3)) }
    }

    /**
     * The other seven entries are client → server frames with bad fields, and a
     * *client* must not reject them — it has no business decoding them at all,
     * and treating one as fatal would close a working socket over a frame the
     * server was never going to send.
     */
    @Test
    fun `frames meant for the server are ignored, not rejected`() {
        val structural = setOf("not JSON", "not an object", "no type tag")
        val theirs = rejected().filterNot { it.str("why") in structural }
        assertTrue(theirs.isNotEmpty())

        for (case in theirs) {
            val message = ServerMessage.parse(Protocol.decodeServerMessage(case.str("raw")))
            assertIs<ServerMessage.Unknown>(message, "${case.str("why")} should be ignored")
        }
    }

    @Test
    fun `an unknown message type is ignored, not rejected`() {
        val message = ServerMessage.parse(
            Protocol.decodeServerMessage("""{"t":"turn.progress","turn":7,"percent":40}""")
        )
        assertEquals("turn.progress", assertIs<ServerMessage.Unknown>(message).type)
    }

    /**
     * The server → client half, against the examples in PROTOCOL.md itself.
     * `ServerConformanceTest` covers the same ground against the real encoder;
     * this one covers it against the document, which is the actual contract.
     */
    @Test
    fun `server messages parse to their documented fields`() {
        fun parsed(raw: String) = ServerMessage.parse(Protocol.decodeServerMessage(raw))

        val hello = assertIs<ServerMessage.HelloOk>(
            parsed(
                """{ "t": "hello.ok", "proto": 3, "server": "yammer-server/0.1.0",
                     "audio": { "codec": "pcm_s16le", "rate": 24000, "channels": 1 } }"""
            )
        )
        assertEquals(3, hello.proto)
        assertEquals("yammer-server/0.1.0", hello.server)
        assertEquals(AudioFormat("pcm_s16le", 24_000, 1), hello.audio)

        assertEquals(7L, assertIs<ServerMessage.TurnAccepted>(parsed("""{"t":"turn.accepted","turn":7}""")).turn)

        val rejected = assertIs<ServerMessage.TurnRejected>(
            parsed("""{"t":"turn.rejected","turn":7,"reason":"busy"}""")
        )
        assertEquals("busy", rejected.reason)

        val status = assertIs<ServerMessage.TurnStatus>(
            parsed("""{"t":"turn.status","turn":7,"state":"transcribing"}""")
        )
        assertEquals("transcribing", status.state)

        val transcript = assertIs<ServerMessage.Transcript>(
            parsed("""{"t":"transcript","turn":7,"text":"add a test for the session handler"}""")
        )
        assertEquals("add a test for the session handler", transcript.text)

        val begin = assertIs<ServerMessage.SpeechBegin>(
            parsed("""{"t":"speech.begin","turn":7,"seg":0,"voice":"supervisor"}""")
        )
        assertEquals(0, begin.seg)
        assertEquals("supervisor", begin.voice)

        assertEquals(3, assertIs<ServerMessage.SpeechEnd>(parsed("""{"t":"speech.end","turn":7,"seg":3}""")).seg)

        val ask = assertIs<ServerMessage.PermissionAsk>(
            parsed("""{"t":"permission.ask","turn":7,"id":"per_ff18","attempt":0,"question":"Say approve or deny."}""")
        )
        assertEquals("per_ff18", ask.id)
        assertEquals(0, ask.attempt)
        assertEquals("Say approve or deny.", ask.question)

        val resolved = assertIs<ServerMessage.PermissionResolved>(
            parsed("""{"t":"permission.resolved","turn":7,"id":"per_ff18","response":"once"}""")
        )
        assertEquals("once", resolved.response)

        val failure = assertIs<ServerMessage.Failure>(
            parsed("""{"t":"error","turn":7,"code":"opencode_unreachable","message":"Could not reach OpenCode."}""")
        )
        assertEquals("opencode_unreachable", failure.code)

        val end = assertIs<ServerMessage.TurnEnd>(parsed("""{"t":"turn.end","turn":7,"outcome":"denied"}"""))
        assertEquals("denied", end.outcome)
    }

    /** `turn` is documented as omitted for errors not associated with a turn. */
    @Test
    fun `an error without a turn still parses`() {
        val failure = assertIs<ServerMessage.Failure>(
            ServerMessage.parse(
                Protocol.decodeServerMessage("""{"t":"error","code":"internal","message":"boom"}""")
            )
        )
        assertEquals(null, failure.turn)
        assertEquals("internal", failure.code)
    }

    /**
     * A permission prompt with no id is the one place the Python client checks a
     * field's type before acting, because entering an answer window it can never
     * close is worse than ignoring the ask.
     */
    @Test
    fun `a permission ask without an id is not one`() {
        val message = ServerMessage.parse(
            Protocol.decodeServerMessage("""{"t":"permission.ask","turn":7,"attempt":0}""")
        )
        assertIs<ServerMessage.Unknown>(message)
    }

    /** hello.ok is what the playback rate comes from; a missing field falls back. */
    @Test
    fun `hello_ok falls back field by field`() {
        val hello = assertIs<ServerMessage.HelloOk>(
            ServerMessage.parse(
                Protocol.decodeServerMessage("""{"t":"hello.ok","proto":2,"audio":{"rate":22050}}""")
            )
        )
        assertEquals(AudioFormat("pcm_s16le", 22_050, 1), hello.audio)
        assertEquals("unknown", hello.server)

        val bare = assertIs<ServerMessage.HelloOk>(
            ServerMessage.parse(Protocol.decodeServerMessage("""{"t":"hello.ok","proto":2}"""))
        )
        assertEquals(DEFAULT_SPEECH_FORMAT, bare.audio)
    }

    // --- helpers -----------------------------------------------------------

    private fun rejected() = fixture.arr("rejected").map { it.jsonObject }

    private fun parse(raw: String) = Json.parseToJsonElement(raw).jsonObject

    private fun nameOf(code: Int) = when (code) {
        CloseCode.AUTH_FAILED -> "AUTH_FAILED"
        CloseCode.UNSUPPORTED_PROTOCOL -> "UNSUPPORTED_PROTOCOL"
        CloseCode.PROTOCOL_VIOLATION -> "PROTOCOL_VIOLATION"
        else -> "UNKNOWN_$code"
    }

    private fun hex(s: String) = ByteArray(s.length / 2) {
        s.substring(it * 2, it * 2 + 2).toInt(16).toByte()
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
}

// The fixture accessors in Fixture.kt are typed for the wake-word golden
// vectors; these two are the nullable reads the protocol frames need.
private fun JsonObject.long(key: String): Long? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()

private fun JsonObject.string(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
