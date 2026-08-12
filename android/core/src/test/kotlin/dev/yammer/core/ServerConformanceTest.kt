package dev.yammer.core

import java.io.BufferedReader
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * The Kotlin client against the real TypeScript server, over a real socket.
 *
 * `ProtocolTest` checks that the two implementations encode the same frames.
 * This checks that they can hold a conversation — that the frames go out in an
 * order the server accepts, that a turn's audio arrives whole, and that a
 * permission prompt answered by voice actually settles. Those are failures of
 * *sequence*, and no amount of codec conformance finds them.
 *
 * The server is `server/tools/fake-server.ts`: the genuine `startServer`,
 * handshake, `TurnManager` and `PermissionSupervisor`, with fakes standing in
 * only for the four things that would otherwise need network — STT, the router,
 * OpenCode and Kokoro.
 *
 * ## What this does not cover
 *
 * The audio is synthetic and the wake words are scripted, so nothing here says
 * anything about detection. It also runs on a desktop JVM, so the parts of the
 * Android client that are Android — `AudioRecord`, `AudioTrack`, the routing —
 * are the `Speaker` fake. What it does prove is that the state machine and the
 * wire format are right, which until now could only be checked by pointing a
 * phone at a real server.
 */
class ServerConformanceTest {

    /**
     * One connection, two turns. The fake server asks for permission on its
     * second prompt, so this is both paths without a side channel: an ordinary
     * turn, then one that stops to ask.
     */
    @Test
    fun `a turn and a permission prompt round-trip through the real server`() = withServer { port ->
        val wake = ScriptedWake()
        val voice = ScriptedVoice()
        val speaker = RecordingSpeaker()
        val log = RecordingLog()
        val config = ClientConfig(token = TOKEN)
        val client = YammerClient(
            config,
            WakeWordDetector(config.wake, wake),
            SpeechGate(config.vad, voice),
            speaker,
            log,
        )
        var blockId = 0
        fun block() = ShortArray(AudioFeatures.BLOCK_SAMPLES) { (++blockId).toShort() }
        fun say(which: Wake) {
            wake.next = which
            client.onCaptureBlock(block())
        }

        val transport = WebSocketTransport("ws://127.0.0.1:$port", client, log)
        transport.connect()
        try {
            await("the handshake") { client.connected }
            // The server declares Kokoro's rate; the client must take it from
            // the frame rather than from its own default, even when they agree.
            assertEquals(AudioFormat("pcm_s16le", 24_000, 1), speaker.format)

            // --- an ordinary turn ------------------------------------------
            say(Wake.START)
            repeat(20) { client.onCaptureBlock(block()) }
            say(Wake.STOP)
            assertEquals(YammerClient.State.WAITING, client.state)

            await("turn.end", diagnose = log::all) { client.state == YammerClient.State.IDLE }

            // 20 blocks captured, 8 trimmed off the tail, 12 × 1280 × 2 bytes
            // left. The fake STT reports what it was handed, so this is the
            // whole audio path — buffering, trimming, framing and reassembly —
            // checked from the far end.
            assertTrue(
                log.any("heard: received ${12 * 1280 * 2} bytes"),
                "the server did not receive the trimmed utterance: ${log.all()}",
            )
            assertEquals(
                listOf(Earcons.Earcon.START_RECORD, Earcons.Earcon.STOP_RECORD),
                speaker.earcons(24_000),
            )
            // And the reply came back as playable audio, not just as frames.
            assertContentEquals(fakeSpeech(0), speaker.speech(24_000).first())

            // --- a turn that stops to ask ----------------------------------
            speaker.clear()
            say(Wake.START)
            repeat(20) { client.onCaptureBlock(block()) }
            say(Wake.STOP)

            await("permission.ask") { client.state == YammerClient.State.ANSWERING }
            assertTrue(
                Earcons.Earcon.PERMISSION in speaker.earcons(24_000),
                "the permission earcon is the only warning the user gets",
            )

            // Wait for the supervisor to finish asking. The client is built to
            // barge in, but the server only opens its answer window once the
            // whole question has been sent — see the note at the bottom of this
            // file.
            awaitQuiet(speaker)

            voice.probability = 0.0
            repeat(3) { client.onCaptureBlock(block()) }
            voice.probability = 1.0
            repeat(6) { client.onCaptureBlock(block()) }
            voice.probability = 0.0
            repeat(10) { client.onCaptureBlock(block()) }

            // The state to wait on is not WAITING: `permission.resolved` is
            // followed by the rest of the turn, and IDLE can arrive between two
            // polls. The log line is what says the answer was understood.
            await("permission.resolved", diagnose = log::all) {
                log.any("permission per_fake0001 resolved: once")
            }

            await("the second turn.end", diagnose = log::all) {
                client.state == YammerClient.State.IDLE
            }
            assertEquals(2L, client.turn)
        } finally {
            transport.close()
        }
    }

    /**
     * The close code is the whole error report for a failed handshake — the
     * server never sends a message explaining itself — so a client that does not
     * translate it tells the user nothing at all.
     */
    @Test
    fun `a bad token is refused with a close code the client can explain`() = withServer { port ->
        val log = RecordingLog()
        val config = ClientConfig(token = "not-the-token")
        val client = YammerClient(
            config,
            WakeWordDetector(config.wake, ScriptedWake()),
            SpeechGate(config.vad, ScriptedVoice()),
            RecordingSpeaker(),
            log,
        )

        val transport = WebSocketTransport("ws://127.0.0.1:$port", client, log)
        transport.connect()
        try {
            await("the server to refuse the token") {
                log.any(CLOSE_REASONS.getValue(CloseCode.AUTH_FAILED))
            }
            assertTrue(!client.connected)
        } finally {
            transport.close()
        }
    }

    // --- harness -----------------------------------------------------------

    /** The ramp `fake-server.ts` synthesizes, rebuilt so playback can be checked. */
    private fun fakeSpeech(seg: Int) = ShortArray(240) { ((it * 37 + seg) % 3000).toShort() }

    private fun withServer(block: (Int) -> Unit) {
        val root = Fixture.fixturesDir.parentFile
        val serverDir = File(root, "server")
        val node = System.getenv("PATH").orEmpty().split(File.pathSeparator)
            .map { File(it, "node") }
            .firstOrNull { it.canExecute() }

        assumeTrue(node != null, "node is not on PATH")
        assumeTrue(
            File(serverDir, "node_modules").isDirectory,
            "server/node_modules is missing — run `npm install` in server/",
        )

        val process = ProcessBuilder(node!!.path, "--experimental-strip-types", "tools/fake-server.ts")
            .directory(serverDir)
            .redirectErrorStream(true)
            .start()

        try {
            val output = process.inputStream.bufferedReader()
            val port = awaitPort(output, process)
            // Nothing reads the rest, and a full pipe buffer would wedge the
            // server mid-turn.
            thread(isDaemon = true) { runCatching { output.forEachLine { } } }
            block(port)
        } finally {
            process.destroy()
            process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    private fun awaitPort(output: BufferedReader, process: Process): Int {
        val deadline = System.nanoTime() + SPAWN_TIMEOUT_MS * 1_000_000
        val seen = StringBuilder()
        while (System.nanoTime() < deadline) {
            val line = output.readLine()
                ?: fail("fake-server.ts exited before it listened:\n$seen")
            seen.appendLine(line)
            PORT.matchEntire(line)?.let { return it.groupValues[1].toInt() }
        }
        process.destroy()
        fail("fake-server.ts did not report a port within ${SPAWN_TIMEOUT_MS}ms:\n$seen")
    }

    private fun await(
        what: String,
        timeoutMs: Long = 15_000,
        diagnose: () -> List<String> = ::emptyList,
        condition: () -> Boolean,
    ) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        // Without the client's own log a timeout here says only "something did
        // not happen", and the interesting part is always how far it got.
        fail("timed out after ${timeoutMs}ms waiting for $what\n" + diagnose().joinToString("\n"))
    }

    /** Waits until the server has stopped sending audio for [quietMs]. */
    private fun awaitQuiet(speaker: RecordingSpeaker, quietMs: Long = 500) {
        await("the supervisor to finish asking") {
            val last = speaker.lastPlayedAt
            last != 0L && (System.nanoTime() - last) / 1_000_000 >= quietMs
        }
    }

    private companion object {
        const val TOKEN = "s3cret-token"

        /** Node has to strip types before it can listen, which is not instant. */
        const val SPAWN_TIMEOUT_MS = 20_000L

        val PORT = Regex("""listening (\d+)""")
    }
}

/*
 * One thing this test found, recorded here rather than asserted:
 *
 * `PermissionSupervisor.handle` awaits `speak(question)` *before* it calls
 * `collectAnswer`, so the answer window does not exist until the last segment of
 * the question has been sent. An `answer.begin` that arrives earlier hits a null
 * `pending` and is dropped silently, and its audio frames fall through to
 * `TurnManager.appendAudio`, which drops them too because the turn is already
 * processing. The user gets a reprompt for an answer they already gave.
 *
 * PROTOCOL.md documents barge-in as supported ("the user speaks over the
 * supervisor"), and this client implements it — `SpeechGate` onset flushes
 * playback. The gap is narrow in practice, because sending audio is much faster
 * than playing it, so by the time a user has heard enough to interrupt, the
 * window is usually open. It widens with synthesis latency and with longer
 * questions. It is a server fix, not a client one, so it is noted here and in
 * android-client-plan.md rather than worked around above.
 */
