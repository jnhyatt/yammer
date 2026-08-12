package dev.yammer.android

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.util.Log
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import dev.yammer.core.Earcons
import dev.yammer.core.Wav
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * The Phase 2 audio harness, and a permanent diagnostic screen.
 *
 * It answers the two questions Phase 2 exists to answer, neither of which can be
 * settled from a desktop:
 *
 *  1. **Are the five earcons audible and distinguishable through the earbuds?**
 *     Their arithmetic is already pinned to `fixtures/earcons/golden.json` by
 *     `:core:test` — what is left is a judgement by ear, at the rate the server
 *     will actually declare.
 *  2. **Does the default input give us a full-bandwidth stream?** This records a
 *     WAV and reports what the OS routed it to. The *bandwidth* verdict is not
 *     made here: an 8 kHz-limited stream resampled to 16 kHz sounds perfectly
 *     fine, so it takes a spectrum to tell, which is what
 *     `android/tools/check_capture.py` is for. This screen's job is to produce a
 *     file worth measuring and to name the device it came from.
 *
 * The capture source is selectable because its effect cannot be predicted from
 * the API — see [CaptureSource]. Being able to record the same room from four
 * sources and compare the spectra is the whole point.
 */
class AudioCheckActivity : Activity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private var playback: AudioPlayback? = null
    private var playbackRate = DEFAULT_SPEECH_RATE
    private var source = CaptureSource.VOICE_COMMUNICATION
    private var recording: Job? = null
    private var lastCapture: File? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(buildUi())

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST)
            say("RECORD_AUDIO not granted yet — asking.")
        }

        say("Yammer audio check.")
        say("Output rate $playbackRate Hz, capture $CAPTURE_RATE Hz in $CAPTURE_BLOCK_SAMPLES-sample blocks.")
        reportUnprocessedSupport()
        say("Files land in ${getExternalFilesDir(null)}")
    }

    override fun onDestroy() {
        scope.cancel()
        playback?.stop()
        playback = null
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        results: IntArray,
    ) {
        if (requestCode == PERMISSION_REQUEST) {
            val granted = results.firstOrNull() == PackageManager.PERMISSION_GRANTED
            say(if (granted) "RECORD_AUDIO granted." else "RECORD_AUDIO denied — capture will fail.")
        }
    }

    // -- UI -----------------------------------------------------------------
    //
    // Built in code, with no Compose and no resources beyond a label. This is a
    // diagnostic screen: what matters is that it builds fast and has nothing in
    // it that could itself be the reason audio misbehaves. The real UI arrives
    // with the client in Phase 4.

    private fun buildUi(): ViewGroup {
        val pad = (16 * resources.displayMetrics.density).toInt()

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        column.addView(label("Playback rate — what the server declares in hello.ok"))
        column.addView(
            spinner(RATES.map { "$it Hz" }, RATES.indexOf(playbackRate)) { index ->
                val chosen = RATES[index]
                if (chosen != playbackRate) {
                    playbackRate = chosen
                    playback?.stop()
                    playback = null
                    say("Output rate is now $playbackRate Hz.")
                }
            }
        )

        column.addView(label("Earcons"))
        val earconRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (earcon in Earcons.Earcon.entries) {
            earconRow.addView(
                Button(this).apply {
                    text = shortLabel(earcon)
                    textSize = 12f
                    layoutParams = LinearLayout.LayoutParams(0, WRAP, 1f)
                    setOnClickListener { playEarcon(earcon) }
                }
            )
        }
        column.addView(earconRow)
        column.addView(
            button("Play all five, spaced") {
                scope.launch {
                    for (earcon in Earcons.Earcon.entries) {
                        playEarcon(earcon)
                        // Long enough to hear each one end before the next starts;
                        // they share a queue, so this is for the ear, not the API.
                        withContext(Dispatchers.IO) { Thread.sleep(900) }
                    }
                }
            }
        )
        column.addView(button("Interrupt (flush)") { flushPlayback() })

        column.addView(label("Capture source"))
        column.addView(
            spinner(
                CaptureSource.entries.map { "${it.name} — ${it.note}" },
                CaptureSource.entries.indexOf(source),
            ) { index ->
                source = CaptureSource.entries[index]
                say("Capture source is now ${source.name}.")
            }
        )
        column.addView(button("Record ${CAPTURE_SECONDS}s to WAV") { record() })
        column.addView(button("Play back last recording") { playLastCapture() })

        logView = TextView(this).apply {
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextIsSelectable(true)
            movementMethod = ScrollingMovementMethod()
        }
        logScroll = ScrollView(this).apply {
            addView(logView)
            layoutParams = LinearLayout.LayoutParams(MATCH, 0, 1f)
        }
        column.addView(logScroll)

        return column
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setPadding(0, (12 * resources.displayMetrics.density).toInt(), 0, 0)
    }

    private fun button(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
        setOnClickListener { onClick() }
    }

    private fun spinner(items: List<String>, selected: Int, onPick: (Int) -> Unit) =
        Spinner(this).apply {
            adapter = ArrayAdapter(
                this@AudioCheckActivity,
                android.R.layout.simple_spinner_dropdown_item,
                items,
            )
            setSelection(selected, false)
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(
                    parent: android.widget.AdapterView<*>?,
                    view: android.view.View?,
                    position: Int,
                    id: Long,
                ) = onPick(position)

                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
        }

    // -- Actions ------------------------------------------------------------

    /** The track is opened lazily, because opening it is what routes the audio. */
    private fun playbackAt(rate: Int): AudioPlayback? {
        playback?.let { if (it.rate == rate) return it else { it.stop(); playback = null } }
        return try {
            AudioPlayback(rate).also { it.start(); playback = it }
        } catch (e: AudioError) {
            say("Could not open output at $rate Hz: ${e.message}")
            null
        }
    }

    private fun playEarcon(earcon: Earcons.Earcon) {
        val track = playbackAt(playbackRate) ?: return
        val pcm = Earcons.pcm(earcon, playbackRate)
        say("${earcon.key}: ${pcm.size} samples, ${"%.0f".format(1000.0 * pcm.size / playbackRate)} ms")
        track.play(pcm)
    }

    private fun flushPlayback() {
        val track = playback
        if (track == null) {
            say("Nothing playing.")
            return
        }
        track.flush()
        say("Flushed. Anything still audible is what the device had already committed.")
    }

    private fun record() {
        if (recording?.isActive == true) {
            say("Already recording.")
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            say("RECORD_AUDIO is not granted.")
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST)
            return
        }

        recording = scope.launch {
            val capture = AudioCapture(source)
            val wanted = CAPTURE_SECONDS * CAPTURE_RATE / CAPTURE_BLOCK_SAMPLES
            say("Recording ${CAPTURE_SECONDS}s from ${source.name} — speak, and say the wake word.")

            val blocks = ArrayList<ShortArray>(wanted)
            try {
                capture.blocks().take(wanted).collect { blocks.add(it) }
            } catch (e: AudioError) {
                say("Capture failed: ${e.message}")
                return@launch
            }

            say("Routed to ${capture.routing}")
            if (blocks.size < wanted) {
                say("Only got ${blocks.size} of $wanted blocks — the stream ended early.")
            }

            val pcm = ShortArray(blocks.sumOf { it.size })
            var at = 0
            for (block in blocks) {
                block.copyInto(pcm, at)
                at += block.size
            }

            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val file = File(
                getExternalFilesDir(null),
                "capture-${source.name.lowercase(Locale.US)}-$stamp.wav",
            )
            try {
                withContext(Dispatchers.IO) {
                    file.outputStream().use { Wav.write(it, pcm, CAPTURE_RATE) }
                }
            } catch (e: Exception) {
                say("Could not write $file: $e")
                return@launch
            }

            lastCapture = file
            describe(pcm)
            say("Wrote ${file.name} (${file.length()} bytes)")
            say("  adb pull ${file.absolutePath}")
            say("  ../client/.venv/bin/python tools/check_capture.py ${file.name}")
        }
    }

    /**
     * Level statistics, for the failures that a spectrum would not show.
     *
     * A dead microphone gives digital silence; a broken path often gives a large
     * DC offset or a signal pinned to the rails. All three are things you would
     * otherwise discover after pulling the file.
     */
    private fun describe(pcm: ShortArray) {
        if (pcm.isEmpty()) {
            say("No samples captured at all.")
            return
        }
        var peak = 0
        var sumSquares = 0.0
        var sum = 0.0
        var zeros = 0
        var clipped = 0
        for (sample in pcm) {
            val v = sample.toInt()
            if (abs(v) > peak) peak = abs(v)
            sumSquares += v.toDouble() * v
            sum += v
            if (v == 0) zeros++
            if (v >= 32_760 || v <= -32_760) clipped++
        }
        val rms = sqrt(sumSquares / pcm.size)
        val dbfs = if (rms > 0) 20 * log10(rms / 32_768.0) else Double.NEGATIVE_INFINITY

        say("${pcm.size} samples, ${"%.2f".format(pcm.size.toDouble() / CAPTURE_RATE)}s")
        say("  peak $peak (${"%.1f".format(20 * log10(maxOf(peak, 1) / 32768.0))} dBFS)")
        say("  rms ${"%.1f".format(rms)} (${"%.1f".format(dbfs)} dBFS)")
        say("  dc offset ${"%.1f".format(sum / pcm.size)}, zeros $zeros, clipped $clipped")
        if (peak == 0) say("  SILENT — the microphone gave nothing.")
        if (clipped > pcm.size / 100) say("  CLIPPING — turn down the gain or move back.")
    }

    private fun playLastCapture() {
        val file = lastCapture
        if (file == null) {
            say("Nothing recorded yet.")
            return
        }
        scope.launch {
            val audio = try {
                withContext(Dispatchers.IO) { Wav.read(file.readBytes()) }
            } catch (e: Exception) {
                say("Could not read ${file.name}: $e")
                return@launch
            }
            // The recording is at the capture rate, not the speech rate, so this
            // opens its own track rather than resampling.
            val track = playbackAt(audio.rate) ?: return@launch
            say("Playing ${file.name} back at ${audio.rate} Hz.")
            track.play(audio.pcm)
        }
    }

    private fun reportUnprocessedSupport() {
        val manager = getSystemService(AUDIO_SERVICE) as AudioManager
        val supported =
            manager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        say("UNPROCESSED source: ${if (supported) "supported" else "not supported on this device"}")
    }

    // -- Log ----------------------------------------------------------------

    private fun say(line: String) {
        Log.i(TAG, line)
        runOnUiThread {
            logView.append("$line\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private fun shortLabel(earcon: Earcons.Earcon) = when (earcon) {
        Earcons.Earcon.START_RECORD -> "start"
        Earcons.Earcon.STOP_RECORD -> "stop"
        Earcons.Earcon.BUSY -> "busy"
        Earcons.Earcon.PERMISSION -> "perm"
        Earcons.Earcon.ERROR -> "error"
    }

    private companion object {
        const val TAG = "YammerAudioCheck"
        const val PERMISSION_REQUEST = 1

        /** Kokoro's native rate — the fallback in `protocol.py`, and the default here. */
        const val DEFAULT_SPEECH_RATE = 24_000

        /** The rates the earcon fixture covers, so what is heard is what is tested. */
        val RATES = listOf(16_000, 22_050, 24_000)

        const val CAPTURE_SECONDS = 10

        const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
    }
}
