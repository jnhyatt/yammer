package dev.yammer.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Wire protocol types and codecs.
 *
 * Mirrors `protocol/PROTOCOL.md`, `server/src/protocol.ts` and
 * `client/src/yammer_client/protocol.py`. All four change together — this is a
 * cross-language contract, not a shared type definition, and nothing but
 * `ProtocolTest` checks that these four agree.
 *
 * The encoders are deliberately hand-written against `buildJsonObject` rather
 * than `@Serializable` data classes. A generated encoder would make the field
 * names an implementation detail of a Kotlin class name, and the field names
 * *are* the contract.
 */

const val PROTOCOL_VERSION = 3

/**
 * Deliberately not the Python client's `yammer-client/0.1.0`.
 *
 * The server logs this and nothing else reads it, which is exactly the point:
 * it is how a session in the log gets attributed to the phone rather than the
 * desktop. Making it match the fixture verbatim would defeat the field.
 */
const val CLIENT_ID = "yammer-android/0.1.0"

/**
 * Application-specific WebSocket close codes.
 *
 * `4004 ALREADY_CONNECTED` was retired in v3: the server takes as many clients
 * as want to connect, each with its own active workspace. The number is left
 * unused rather than recycled.
 */
object CloseCode {
    const val AUTH_FAILED = 4001
    const val UNSUPPORTED_PROTOCOL = 4002
    const val PROTOCOL_VIOLATION = 4003
}

val CLOSE_REASONS: Map<Int, String> = mapOf(
    CloseCode.AUTH_FAILED to "the server rejected the token",
    CloseCode.UNSUPPORTED_PROTOCOL to "the server speaks a different protocol version",
    CloseCode.PROTOCOL_VIOLATION to "the server reported a protocol violation",
)

data class AudioFormat(val codec: String, val rate: Int, val channels: Int) {
    fun toJson(): JsonObject = buildJsonObject {
        put("codec", codec)
        put("rate", rate)
        put("channels", channels)
    }

    companion object {
        /** Field-by-field, so a server that omits one still yields a usable format. */
        fun fromJson(raw: JsonElement?, fallback: AudioFormat): AudioFormat {
            val obj = raw as? JsonObject ?: return fallback
            return AudioFormat(
                codec = obj.string("codec") ?: fallback.codec,
                rate = obj.int("rate") ?: fallback.rate,
                channels = obj.int("channels") ?: fallback.channels,
            )
        }
    }
}

/** The client captures at this rate; the server does not resample. */
val CAPTURE_FORMAT = AudioFormat(codec = "pcm_s16le", rate = 16_000, channels = 1)

/**
 * Kokoro's native rate. Only a fallback — the real value arrives in `hello.ok`
 * and must be honoured rather than assumed.
 */
val DEFAULT_SPEECH_FORMAT = AudioFormat(codec = "pcm_s16le", rate = 24_000, channels = 1)

/** The peer sent something that violates PROTOCOL.md. */
class ProtocolError(message: String) : Exception(message)

/** One decoded binary frame: its turn tag and the PCM that followed. */
data class AudioFrame(val turn: Long, val pcm: ByteArray) {
    override fun equals(other: Any?): Boolean =
        other is AudioFrame && turn == other.turn && pcm.contentEquals(other.pcm)

    override fun hashCode(): Int = 31 * turn.hashCode() + pcm.contentHashCode()
}

object Protocol {

    /** Bytes in a binary frame's turn tag: a little-endian uint32. */
    const val HEADER_BYTES = 4

    /**
     * Turn ids are a uint32 that the spec says wraps at 2^32, so they are held
     * in a [Long] rather than an [Int]. The fixture includes 4294967295 for
     * exactly this reason: a signed-int implementation only ever goes wrong
     * there, and only after the case it was never tested on reaches production.
     */
    const val MAX_TURN = 0xFFFF_FFFFL

    // The defaults are what this wants: strict parsing and compact output.
    private val json = Json

    // --- Client → Server ---------------------------------------------------

    fun hello(token: String): String = encode {
        put("t", "hello")
        put("proto", PROTOCOL_VERSION)
        put("token", token)
        put("client", CLIENT_ID)
        put("audio", CAPTURE_FORMAT.toJson())
    }

    fun utteranceBegin(turn: Long): String = encode {
        put("t", "utterance.begin")
        put("turn", turn)
    }

    fun utteranceEnd(turn: Long): String = encode {
        put("t", "utterance.end")
        put("turn", turn)
    }

    fun utteranceCancel(turn: Long, reason: String): String = encode {
        put("t", "utterance.cancel")
        put("turn", turn)
        put("reason", reason)
    }

    /**
     * The user has started answering a permission prompt; audio frames follow.
     *
     * Answers reuse the ordinary turn-tagged binary frames — an answer happens
     * inside a turn, so it carries the request id rather than a tag of its own.
     */
    fun answerBegin(turn: Long, requestId: String): String = encode {
        put("t", "answer.begin")
        put("turn", turn)
        put("id", requestId)
    }

    fun answerEnd(turn: Long, requestId: String): String = encode {
        put("t", "answer.end")
        put("turn", turn)
        put("id", requestId)
    }

    /** The answer window closed with no speech in it at all. */
    fun answerTimeout(turn: Long, requestId: String): String = encode {
        put("t", "answer.timeout")
        put("turn", turn)
        put("id", requestId)
    }

    private inline fun encode(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        json.encodeToString(JsonObject.serializer(), buildJsonObject(build))

    // --- Framing -----------------------------------------------------------

    /** Prefix PCM with its 4-byte little-endian turn tag. */
    fun encodeAudioFrame(turn: Long, pcm: ByteArray): ByteArray {
        val out = ByteArray(HEADER_BYTES + pcm.size)
        writeTurn(out, turn)
        pcm.copyInto(out, HEADER_BYTES)
        return out
    }

    /**
     * The same, straight from capture samples.
     *
     * Capture and playback both deal in [ShortArray] on Android — `AudioRecord`
     * fills one and `AudioTrack` consumes one — so converting to a `ByteArray`
     * first would allocate an intermediate copy of every utterance for nothing.
     */
    fun encodeAudioFrame(turn: Long, pcm: ShortArray, offset: Int, count: Int): ByteArray {
        val out = ByteArray(HEADER_BYTES + count * 2)
        writeTurn(out, turn)
        var at = HEADER_BYTES
        for (i in offset until offset + count) {
            val sample = pcm[i].toInt()
            out[at++] = (sample and 0xFF).toByte()
            out[at++] = ((sample shr 8) and 0xFF).toByte()
        }
        return out
    }

    /** Split a binary frame into its turn tag and PCM payload. */
    fun decodeAudioFrame(data: ByteArray): AudioFrame {
        if (data.size < HEADER_BYTES) {
            throw ProtocolError("binary frame shorter than its header")
        }
        var turn = 0L
        for (i in 0 until HEADER_BYTES) {
            turn = turn or ((data[i].toLong() and 0xFF) shl (8 * i))
        }
        return AudioFrame(turn, data.copyOfRange(HEADER_BYTES, data.size))
    }

    private fun writeTurn(out: ByteArray, turn: Long) {
        val masked = turn and MAX_TURN
        for (i in 0 until HEADER_BYTES) {
            out[i] = ((masked shr (8 * i)) and 0xFF).toByte()
        }
    }

    /**
     * Little-endian s16 bytes to samples.
     *
     * A trailing odd byte is dropped rather than thrown on: it can only come
     * from a sender that split a sample across two frames, and losing 1/32000 of
     * a second is a better outcome than dropping the connection over it.
     */
    fun samplesFromBytes(data: ByteArray): ShortArray {
        val out = ShortArray(data.size / 2)
        for (i in out.indices) {
            val lo = data[i * 2].toInt() and 0xFF
            val hi = data[i * 2 + 1].toInt()
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }

    /** Parse a control frame, validating only that it is a tagged object. */
    fun decodeServerMessage(raw: String): JsonObject {
        val parsed = try {
            json.parseToJsonElement(raw)
        } catch (cause: Exception) {
            throw ProtocolError("control frame is not valid JSON: ${cause.message}")
        }
        if (parsed !is JsonObject) throw ProtocolError("control frame is not an object")
        if (parsed.string("t") == null) throw ProtocolError("control frame has no message type")
        return parsed
    }
}

/**
 * A server → client control message.
 *
 * The Python client switches on a dict; Kotlin gets types because it can, and
 * because the compiler then holds [YammerClient] to handling every case. What
 * it deliberately does *not* get is enums for `voice`, `response` and `outcome`:
 * those are closed sets in PROTOCOL.md today, and an enum would turn a server
 * that adds a value into a client that throws rather than one that logs and
 * carries on.
 *
 * [Unknown] is not an error. A newer server is allowed to send message types
 * this client has never heard of, and the v1 client already ignores `turn.status`
 * by design.
 */
sealed interface ServerMessage {
    val type: String

    data class HelloOk(val proto: Int, val server: String, val audio: AudioFormat) : ServerMessage {
        override val type = "hello.ok"
    }

    data class TurnAccepted(val turn: Long) : ServerMessage {
        override val type = "turn.accepted"
    }

    data class TurnRejected(val turn: Long, val reason: String) : ServerMessage {
        override val type = "turn.rejected"
    }

    data class TurnStatus(val turn: Long, val state: String) : ServerMessage {
        override val type = "turn.status"
    }

    data class Transcript(val turn: Long, val text: String) : ServerMessage {
        override val type = "transcript"
    }

    data class SpeechBegin(val turn: Long, val seg: Int, val voice: String) : ServerMessage {
        override val type = "speech.begin"
    }

    data class SpeechEnd(val turn: Long, val seg: Int) : ServerMessage {
        override val type = "speech.end"
    }

    data class PermissionAsk(
        val turn: Long,
        val id: String,
        val attempt: Int,
        val question: String,
    ) : ServerMessage {
        override val type = "permission.ask"
    }

    /**
     * `id` and `response` are nullable where [PermissionAsk]'s `id` is not, and
     * that asymmetry is the Python client's: it refuses to *enter* an answer
     * window without an id, but leaves one on any `permission.resolved` at all.
     * Being stricter here would strand the Android client in ANSWERING on a
     * frame the desktop client recovers from.
     */
    data class PermissionResolved(
        val turn: Long,
        val id: String?,
        val response: String?,
    ) : ServerMessage {
        override val type = "permission.resolved"
    }

    /** `turn` is omitted for errors not associated with a turn. */
    data class Failure(val turn: Long?, val code: String, val message: String) : ServerMessage {
        override val type = "error"
    }

    data class TurnEnd(val turn: Long, val outcome: String) : ServerMessage {
        override val type = "turn.end"
    }

    data class Unknown(override val type: String, val raw: JsonObject) : ServerMessage

    companion object {
        /**
         * Never throws. [Protocol.decodeServerMessage] has already rejected
         * everything structurally invalid; anything that gets here is a tagged
         * object, and a known tag with a missing field degrades to [Unknown]
         * rather than killing a connection over one absent string.
         */
        fun parse(obj: JsonObject): ServerMessage {
            val type = obj.string("t") ?: return Unknown("", obj)
            val turn = obj.long("turn")

            return when (type) {
                "hello.ok" -> HelloOk(
                    proto = obj.int("proto") ?: 0,
                    server = obj.string("server") ?: "unknown",
                    audio = AudioFormat.fromJson(obj["audio"], DEFAULT_SPEECH_FORMAT),
                )

                "turn.accepted" -> TurnAccepted(turn ?: return Unknown(type, obj))
                "turn.rejected" -> TurnRejected(
                    turn ?: return Unknown(type, obj),
                    obj.string("reason") ?: "",
                )

                "turn.status" -> TurnStatus(
                    turn ?: return Unknown(type, obj),
                    obj.string("state") ?: "",
                )

                "transcript" -> Transcript(
                    turn ?: return Unknown(type, obj),
                    obj.string("text") ?: "",
                )

                "speech.begin" -> SpeechBegin(
                    turn ?: return Unknown(type, obj),
                    obj.int("seg") ?: 0,
                    obj.string("voice") ?: "agent",
                )

                "speech.end" -> SpeechEnd(
                    turn ?: return Unknown(type, obj),
                    obj.int("seg") ?: 0,
                )

                "permission.ask" -> PermissionAsk(
                    turn = turn ?: return Unknown(type, obj),
                    id = obj.string("id") ?: return Unknown(type, obj),
                    attempt = obj.int("attempt") ?: 0,
                    question = obj.string("question") ?: "",
                )

                "permission.resolved" -> PermissionResolved(
                    turn = turn ?: 0L,
                    id = obj.string("id"),
                    response = obj.string("response"),
                )

                "error" -> Failure(
                    turn = turn,
                    code = obj.string("code") ?: "internal",
                    message = obj.string("message") ?: "",
                )

                "turn.end" -> TurnEnd(
                    turn ?: return Unknown(type, obj),
                    obj.string("outcome") ?: "",
                )

                else -> Unknown(type, obj)
            }
        }
    }
}

// --- JSON accessors --------------------------------------------------------
//
// Deliberately total: `jsonPrimitive` and friends throw on a type mismatch, and
// a server that sends `{"turn": null}` should not be able to raise an exception
// from inside a WebSocket callback.
//
// File-private because the test source set declares its own `str`/`int`
// extensions on JsonObject in this same package, for reading the fixtures.

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/**
 * Numbers accept their string form too, matching Python's `int(raw.get(...))`.
 * The tolerance is only in this direction — nothing here *writes* a number as a
 * string.
 */
private fun JsonObject.long(key: String): Long? =
    (this[key] as? JsonPrimitive)?.content?.toLongOrNull()

private fun JsonObject.int(key: String): Int? = long(key)?.toInt()
