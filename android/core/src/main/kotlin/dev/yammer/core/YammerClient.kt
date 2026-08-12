package dev.yammer.core

/**
 * Client turn state machine.
 *
 * ```
 *     IDLE       ── start word ─────────▶ RECORDING
 *     RECORDING  ── stop word  ─────────▶ WAITING     (buffer flushed to the server)
 *     RECORDING  ── start word ─────────▶ RECORDING   (restart: discard and re-arm)
 *     WAITING    ── permission.ask ─────▶ ANSWERING   (VAD-delimited answer window)
 *     ANSWERING  ── permission.resolved ▶ WAITING
 *     WAITING    ── turn.end   ─────────▶ IDLE
 * ```
 *
 * Port of `client/src/yammer_client/app.py`. Audio is buffered locally and
 * flushed on the stop word rather than streamed as it is captured. That is what
 * makes stop-word trimming possible at all — once a frame is on the wire it
 * cannot be taken back.
 *
 * ANSWERING is the one state where wake words are not what delimits speech. The
 * user is being asked a direct question and answers it with one word, so the
 * window is opened by the server and closed by silence — see [SpeechGate].
 * Wake-word detection is suspended for its duration: "hey jarvis" is not an
 * answer to "approve or deny", and treating it as one would start a turn the
 * server would only reject.
 *
 * ## Threading
 *
 * The Python client is one asyncio task reading the microphone and one reading
 * the socket, which the event loop serializes for free. Here they are genuinely
 * different threads — capture is a `Flow` on a background dispatcher, the socket
 * calls back on OkHttp's reader thread — so every entry point takes one lock and
 * the state is only ever touched under it. Wake-word inference runs inside that
 * lock, which parks the socket thread for the few milliseconds a block takes;
 * that is the price of the state being consistent, and it is much cheaper than
 * the class of bug the alternative buys.
 */
class YammerClient(
    private val config: ClientConfig,
    private val detector: WakeWordDetector,
    private val gate: SpeechGate,
    private val speaker: Speaker,
    private val log: ClientLog = ClientLog.Silent,
) {
    enum class State { IDLE, RECORDING, WAITING, ANSWERING }

    private val lock = Any()

    private var transport: Transport? = null
    private var ready = false
    private var failed = false

    private var stateInternal = State.IDLE
    private var turnInternal = 0L
    private var speechFormatInternal = DEFAULT_SPEECH_FORMAT

    private val buffer = ArrayList<ShortArray>()

    // Permission answer state, all cleared together by leaveAnswering().
    private var requestId: String? = null
    private var answering = false
    private val answer = ArrayList<ShortArray>()
    private var idleBlocks = 0

    val state: State get() = synchronized(lock) { stateInternal }
    val turn: Long get() = synchronized(lock) { turnInternal }

    /** The playback format the server declared, or the fallback until it has. */
    val speechFormat: AudioFormat get() = synchronized(lock) { speechFormatInternal }

    /** True once `hello.ok` has been accepted. */
    val connected: Boolean get() = synchronized(lock) { ready }

    // --- connection --------------------------------------------------------

    /** The socket is open. Sends `hello` and waits for `hello.ok`. */
    fun onOpen(transport: Transport) {
        synchronized(lock) {
            this.transport = transport
            ready = false
            failed = false
            transport.send(Protocol.hello(config.token))
        }
    }

    fun onText(raw: String) {
        synchronized(lock) {
            val message = try {
                ServerMessage.parse(Protocol.decodeServerMessage(raw))
            } catch (cause: ProtocolError) {
                return violation(cause.message ?: "malformed control frame")
            }

            if (!ready) {
                if (message !is ServerMessage.HelloOk) {
                    return violation("expected hello.ok, got ${message.type}")
                }
                ready = true
                // Honour the server's declared rate rather than assuming Kokoro's.
                speechFormatInternal = message.audio
                speaker.open(speechFormatInternal)
                log.info("connected to ${message.server}, playback ${speechFormatInternal.rate} Hz")
                return
            }

            onControl(message)
        }
    }

    fun onBinary(frame: ByteArray) {
        synchronized(lock) {
            if (!ready) return violation("server sent a binary frame before hello.ok")

            val decoded = try {
                Protocol.decodeAudioFrame(frame)
            } catch (cause: ProtocolError) {
                return violation(cause.message ?: "malformed binary frame")
            }

            if (decoded.turn != turnInternal) {
                log.debug("dropping speech audio for stale turn ${decoded.turn}")
                return
            }
            // Once the user has started answering, the rest of the supervisor's
            // question is stale — playing it would talk over them and then ask a
            // question they already answered.
            if (answering) {
                log.debug("dropping supervisor audio, an answer is in progress")
                return
            }
            speaker.play(Protocol.samplesFromBytes(decoded.pcm))
        }
    }

    /** The socket closed, for any reason. Leaves the client ready to reconnect. */
    fun onClosed(code: Int, reason: String) {
        synchronized(lock) {
            val explanation = CLOSE_REASONS[code]
            if (explanation != null) {
                log.warn("connection closed: $explanation")
            } else {
                log.info("connection closed: $code $reason")
            }
            teardown()
        }
    }

    /** The connection failed below the protocol — DNS, TCP, TLS, a dropped link. */
    fun onFailure(cause: Throwable) {
        synchronized(lock) {
            log.warn("connection failed: $cause")
            teardown()
        }
    }

    private fun teardown() {
        transport = null
        ready = false
        stateInternal = State.IDLE
        buffer.clear()
        answer.clear()
        answering = false
        requestId = null
        idleBlocks = 0
        speaker.close()
    }

    /**
     * The peer broke the contract.
     *
     * The desktop client raises, which ends the process in front of a console
     * that says why. A phone has no console, so the same event has to become
     * three things the user or the log can actually see: the error earcon, a
     * warning, and a close code the server records.
     */
    private fun violation(message: String) {
        log.warn("protocol violation: $message")
        failed = true
        play(Earcons.Earcon.ERROR)
        transport?.close(CloseCode.PROTOCOL_VIOLATION, message)
        stateInternal = State.IDLE
    }

    // --- microphone side ---------------------------------------------------

    /**
     * One capture block, [AudioFeatures.BLOCK_SAMPLES] samples at 16 kHz.
     *
     * Blocks arriving before `hello.ok` are dropped rather than buffered. The
     * desktop client cannot reach this case — it starts capture after the
     * handshake — but on Android the microphone belongs to a service whose
     * lifetime is not the socket's.
     */
    fun onCaptureBlock(block: ShortArray) {
        synchronized(lock) {
            if (!ready || failed) return

            // The answer window owns the microphone while it is open: speech is
            // delimited by the VAD, and wake words mean nothing here.
            if (stateInternal == State.ANSWERING) return onAnswerBlock(block)

            val detection = detector.process(block)
            if (detection != null) {
                // The block containing the wake word is deliberately not
                // buffered: for the start word it holds the word itself, and for
                // the stop word the buffer has already been flushed.
                return onDetection(detection)
            }

            if (stateInternal == State.RECORDING) buffer.add(block)
        }
    }

    private fun onDetection(detection: Detection) {
        log.debug("wake word ${detection.which} (${detection.score})")
        val socket = transport ?: return

        if (detection.which == Wake.START) {
            if (stateInternal == State.WAITING) {
                // A turn is already in flight. Reject locally so the earcon is
                // immediate; the server's own busy rejection remains the
                // authoritative backstop if the two ever disagree.
                log.info("ignoring start word, turn $turnInternal still in flight")
                play(Earcons.Earcon.BUSY)
                return
            }

            if (stateInternal == State.RECORDING) {
                // "Wait, let me say that again" — discard and re-arm.
                log.info("restarting utterance, discarding turn $turnInternal")
                socket.send(Protocol.utteranceCancel(turnInternal, "restart"))
            }

            turnInternal = nextTurn(turnInternal)
            buffer.clear()
            stateInternal = State.RECORDING
            socket.send(Protocol.utteranceBegin(turnInternal))
            play(Earcons.Earcon.START_RECORD)
            return
        }

        // Stop word.
        if (stateInternal != State.RECORDING) {
            log.debug("ignoring stop word outside recording")
            return
        }
        flush(socket)
    }

    /** Trim the stop word off the tail, send the buffer, close the utterance. */
    private fun flush(socket: Transport) {
        val captured = buffer.sumOf { it.size }
        val audio = ShortArray(captured)
        var at = 0
        for (block in buffer) {
            block.copyInto(audio, at)
            at += block.size
        }
        buffer.clear()

        val trim = trimSamples()
        val kept = when {
            trim > 0 && captured > trim -> captured - trim
            trim > 0 -> 0
            else -> captured
        }
        log.info("utterance $turnInternal: $captured samples captured, $kept after trimming the stop word")

        var offset = 0
        while (offset < kept) {
            val count = minOf(FLUSH_CHUNK_SAMPLES, kept - offset)
            socket.send(Protocol.encodeAudioFrame(turnInternal, audio, offset, count))
            offset += count
        }

        socket.send(Protocol.utteranceEnd(turnInternal))
        stateInternal = State.WAITING
        play(Earcons.Earcon.STOP_RECORD)
    }

    /**
     * Samples to drop from the tail so the stop word doesn't reach OpenCode.
     *
     * Rounded down to whole capture blocks so a sample is never split, exactly
     * as the desktop client rounds to whole `BLOCK_BYTES`.
     */
    private fun trimSamples(): Int {
        val raw = (config.wake.stopTrimSeconds * CAPTURE_FORMAT.rate).toInt()
        return (raw / AudioFeatures.BLOCK_SAMPLES) * AudioFeatures.BLOCK_SAMPLES
    }

    // --- permission answers ------------------------------------------------

    /** Drive the VAD-delimited answer window with one capture block. */
    private fun onAnswerBlock(block: ShortArray) {
        val request = requestId ?: return
        val socket = transport ?: return

        val edge = gate.process(block)

        if (edge == Speech.START) {
            // Barge-in: the user is answering over the supervisor, so drop
            // whatever is still queued rather than making them wait it out.
            speaker.flush()
            answering = true
            // Onset detection lags, so the pre-roll is what stops a one-word
            // answer arriving with its first syllable missing. It already
            // includes the block that triggered onset — appending `block` again
            // here would duplicate 80 ms of audio.
            answer.clear()
            answer.add(gate.preroll())
            socket.send(Protocol.answerBegin(turnInternal, request))
            log.info("answering permission $request")
            return
        }

        if (answering) {
            answer.add(block)
            if (edge == Speech.END) flushAnswer(socket, request)
            return
        }

        // No speech yet. The server has its own deadline; this one just lets it
        // reprompt sooner when the user clearly isn't there.
        idleBlocks += 1
        if (idleBlocks * AudioFeatures.BLOCK_SECONDS >= config.vad.answerSeconds) {
            log.info("no answer heard for $request")
            idleBlocks = 0
            socket.send(Protocol.answerTimeout(turnInternal, request))
        }
    }

    private fun flushAnswer(socket: Transport, request: String) {
        val total = answer.sumOf { it.size }
        val audio = ShortArray(total)
        var at = 0
        for (block in answer) {
            block.copyInto(audio, at)
            at += block.size
        }
        answer.clear()
        answering = false
        log.info("answer captured: $total samples")

        var offset = 0
        while (offset < total) {
            val count = minOf(FLUSH_CHUNK_SAMPLES, total - offset)
            socket.send(Protocol.encodeAudioFrame(turnInternal, audio, offset, count))
            offset += count
        }
        socket.send(Protocol.answerEnd(turnInternal, request))
    }

    private fun enterAnswering(request: String) {
        stateInternal = State.ANSWERING
        requestId = request
        answering = false
        answer.clear()
        idleBlocks = 0
        gate.reset()
    }

    private fun leaveAnswering() {
        stateInternal = State.WAITING
        requestId = null
        answering = false
        answer.clear()
        idleBlocks = 0
        gate.reset()
        // The supervisor's voice is in the detector's buffer now; without this
        // it can still contribute to a wake-word detection afterwards.
        detector.reset()
    }

    // --- server side -------------------------------------------------------

    private fun onControl(message: ServerMessage) {
        when (message) {
            is ServerMessage.HelloOk -> log.warn("ignoring a second hello.ok")

            is ServerMessage.TurnAccepted -> log.debug("turn ${message.turn} accepted")

            is ServerMessage.TurnRejected -> {
                log.info("turn ${message.turn} rejected: ${message.reason}")
                buffer.clear()
                // WAITING survives a rejection because the turn being waited on
                // is not the one that was rejected — the rejection *is* the
                // server saying that other turn is still running.
                if (stateInternal != State.WAITING) stateInternal = State.IDLE
                play(Earcons.Earcon.BUSY)
            }

            is ServerMessage.TurnStatus -> log.debug("turn ${message.turn}: ${message.state}")

            // Logged rather than spoken — the cheapest way to diagnose a
            // misroute is to see what the STT layer actually heard.
            is ServerMessage.Transcript -> log.info("heard: ${message.text}")

            is ServerMessage.SpeechBegin ->
                log.debug("speech segment ${message.seg} (${message.voice})")

            is ServerMessage.SpeechEnd -> Unit

            is ServerMessage.PermissionAsk -> {
                log.info("permission asked (attempt ${message.attempt}): ${message.question}")
                if (stateInternal != State.ANSWERING) {
                    // The earcon lands before any synthesized speech does, which
                    // is what actually tells the user to stop and listen.
                    play(Earcons.Earcon.PERMISSION)
                }
                // A reprompt for the same request re-arms without replaying the
                // earcon over the supervisor's second question.
                enterAnswering(message.id)
            }

            is ServerMessage.PermissionResolved -> {
                log.info("permission ${message.id} resolved: ${message.response}")
                if (message.response == "timeout") play(Earcons.Earcon.ERROR)
                leaveAnswering()
            }

            is ServerMessage.Failure -> {
                log.warn("server error [${message.code}]: ${message.message}")
                play(Earcons.Earcon.ERROR)
            }

            is ServerMessage.TurnEnd -> {
                log.info("turn ${message.turn} ended: ${message.outcome}")
                // A turn can end while an answer window is still open — a
                // supervisor failure, or an abort — so tear that down rather
                // than stranding it.
                if (stateInternal == State.ANSWERING) leaveAnswering()
                stateInternal = State.IDLE
                buffer.clear()
                // Drop buffered audio so the tail of one turn can't contribute
                // to a detection in the next.
                detector.reset()
            }

            is ServerMessage.Unknown -> log.debug("ignoring unknown message type ${message.type}")
        }
    }

    private fun play(earcon: Earcons.Earcon) {
        speaker.play(Earcons.pcm(earcon, speechFormatInternal.rate))
    }

    companion object {
        /**
         * Audio is flushed in chunks rather than one large frame, to keep
         * individual WebSocket messages a sane size. 8192 samples is the 16 KiB
         * the desktop client sends and PROTOCOL.md describes.
         */
        const val FLUSH_CHUNK_SAMPLES = 8192

        /**
         * Turn ids start at 1 and wrap at 2^32, per PROTOCOL.md.
         *
         * The desktop client increments a Python int forever and masks only at
         * the framing layer, so after 2^32 turns its control frames and its
         * binary frames would disagree. Nothing reaches that — one turn every
         * ten seconds is 1360 years — but wrapping here costs a line and makes
         * the implementation match what the document says.
         */
        fun nextTurn(current: Long): Long = if (current >= Protocol.MAX_TURN) 1L else current + 1
    }
}

/** Everything [YammerClient] needs that is not audio. Phase 4 builds this from DataStore. */
data class ClientConfig(
    val token: String,
    val wake: WakeWordConfig = WakeWordConfig(),
    val vad: VadConfig = VadConfig(),
)

/**
 * The sending half of the socket.
 *
 * An interface so the state machine can be driven without one. Every test below
 * `WebSocketTransport` asserts on what was sent, in order, which is the only
 * thing about this client the server can see.
 */
interface Transport {
    fun send(text: String)
    fun send(bytes: ByteArray)
    fun close(code: Int, reason: String)
}

/**
 * Playback, as the state machine needs it.
 *
 * [open] rather than a constructor parameter because the rate is not known until
 * `hello.ok` arrives, and [flush] because barge-in has to drop audio that is
 * already queued — see `AudioIo.kt`, where doing that to a live `AudioTrack`
 * turns out to need more than the one call it looks like.
 */
interface Speaker {
    fun open(format: AudioFormat)
    fun play(pcm: ShortArray)
    fun flush()
    fun close()
}

/**
 * Where the client's narration goes.
 *
 * `core` has no `android.util.Log` and the JVM tests want the output inline, so
 * the sink is injected. The levels are the Python client's.
 */
interface ClientLog {
    fun debug(message: String) {}
    fun info(message: String) {}
    fun warn(message: String) {}

    object Silent : ClientLog

    object Console : ClientLog {
        override fun debug(message: String) = println("DEBUG $message")
        override fun info(message: String) = println("INFO  $message")
        override fun warn(message: String) = println("WARN  $message")
    }
}
