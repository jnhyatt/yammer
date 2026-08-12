package dev.yammer.core

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * The socket, and the thread it calls back on.
 *
 * OkHttp rather than anything Android-specific, which is why this can live in
 * `core` and be driven by a JVM test against the real server — see
 * `ServerConformanceTest`. It is also the only transport either client has that
 * survives a phone falling asleep, which is Phase 4's problem.
 *
 * OkHttp delivers every callback on one reader thread, in order. That does not
 * make [YammerClient] safe on its own — the microphone is a different thread
 * entirely — but it does mean the ordering the protocol depends on is the
 * ordering the client sees.
 */
class WebSocketTransport(
    private val url: String,
    private val client: YammerClient,
    private val log: ClientLog = ClientLog.Silent,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    @Volatile
    private var socket: WebSocket? = null

    fun connect() {
        val request = Request.Builder().url(url).build()
        log.info("connecting to $url")
        socket = http.newWebSocket(request, Listener())
    }

    /** A normal client-initiated close. 1000 is the RFC's "going away, no error". */
    fun close() {
        socket?.close(1000, "client shutting down")
        socket = null
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            client.onOpen(Sender(webSocket, log))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            client.onText(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            client.onBinary(bytes.toByteArray())
        }

        /**
         * The server has sent a close frame. Acknowledge it before reporting:
         * without this the socket stays half-open until the read times out, and
         * a `4004 already connected` would look like a hang rather than an
         * answer.
         */
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socket = null
            client.onClosed(code, reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socket = null
            client.onFailure(t)
        }
    }

    private class Sender(private val socket: WebSocket, private val log: ClientLog) : Transport {
        override fun send(text: String) {
            if (!socket.send(text)) log.warn("dropped a control frame, the socket is closing")
        }

        /**
         * A refused binary frame is worth a warning of its own: OkHttp enqueues
         * rather than blocks, and the failure mode is an utterance that reaches
         * the server with a hole in the middle and transcribes into nonsense.
         */
        override fun send(bytes: ByteArray) {
            if (!socket.send(bytes.toByteString())) log.warn("dropped an audio frame")
        }

        /**
         * RFC 6455 caps the close reason at 123 bytes and OkHttp throws rather
         * than truncating. A protocol-violation message is free text — and can
         * quote a message type the *server* chose — so it is cut to fit here.
         * Losing the tail of an explanation beats an exception thrown from
         * inside the reporting of the original fault.
         *
         * Counted in UTF-8 bytes, not characters, because that is what the limit
         * is: 80 emoji are 320 bytes.
         */
        override fun close(code: Int, reason: String) {
            socket.close(code, clampReason(reason))
        }

        private fun clampReason(reason: String): String {
            var bytes = 0
            for ((index, char) in reason.withIndex()) {
                bytes += when {
                    char.code < 0x80 -> 1
                    char.code < 0x800 -> 2
                    else -> 3 // a surrogate pair is 2 chars and 4 bytes; 3 each
                }
                if (bytes > MAX_CLOSE_REASON_BYTES) return reason.take(index)
            }
            return reason
        }
    }

    companion object {
        /** RFC 6455's cap on the close reason, which OkHttp enforces by throwing. */
        private const val MAX_CLOSE_REASON_BYTES = 123

        /**
         * A WebSocket has no request/response cycle, so the read timeout has to
         * go: it would otherwise fire during any silence longer than it. Liveness
         * comes from pings instead, which is also what notices a phone whose
         * network dropped without a FIN.
         */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
