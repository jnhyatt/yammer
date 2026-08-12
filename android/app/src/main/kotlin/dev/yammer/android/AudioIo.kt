package dev.yammer.android

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import dev.yammer.core.Earcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import java.util.concurrent.LinkedBlockingQueue

/**
 * Microphone capture and speaker playback.
 *
 * A port of `client/src/yammer_client/audio.py`. Capture runs at the protocol's
 * capture rate and emits fixed-size blocks; playback runs at whatever rate the
 * server declared in `hello.ok`, which is also the rate earcons are synthesized
 * at, so both share one track.
 *
 * There is no echo cancellation and the microphone is not gated during playback:
 * v1 assumes headphones, on the phone exactly as on the desktop. Through a
 * speaker, synthesized speech is picked up by the microphone and can trigger the
 * client's own wake words.
 *
 * Neither class pins a device. The OS is asked for the default input and output,
 * and with earbuds connected that is what the OS routes to — [AudioCapture]
 * reports which device it actually got, because "the earbuds are connected" and
 * "the earbud microphone is what we are recording from" are different claims and
 * only the second one matters.
 */
private const val TAG = "YammerAudio"

const val CAPTURE_RATE = 16_000

/** 80 ms. openWakeWord's block size, so detection needs no re-chunking. */
const val CAPTURE_BLOCK_SAMPLES = 1280

class AudioError(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Which microphone the OS should hand us.
 *
 * This is the one capture parameter worth being able to change without a
 * rebuild, because its effect cannot be predicted from the API — it depends on
 * the phone's audio HAL, and the wrong choice degrades the stream silently.
 *
 * There is a real tension in this choice, and Phase 2 exists partly to settle
 * it by measurement:
 *
 * - `voice-opencode-requirements.md` §9 says the capture *use case* has to be a
 *   communication one, because an LE Audio link in a media context runs
 *   unidirectional — the buds' microphones do not stream at all and capture
 *   falls back to the phone's own microphone without saying so.
 * - What a wake word wants is the opposite: no automatic gain, no noise
 *   suppression, nothing that pumps the noise floor between utterances.
 *
 * So the default follows the requirements doc, and the alternatives are here to
 * be compared against it with the routing report and a spectrum. If
 * [VOICE_RECOGNITION] turns out to keep the earbud microphone, it is the better
 * choice and the requirements doc's claim needs revisiting.
 */
enum class CaptureSource(val id: Int, val note: String) {
    /**
     * The default, per the requirements doc: a communication use case is what
     * brings up the LE Audio bidirectional link. It carries acoustic echo
     * cancellation and noise suppression with it, which v1 does not need
     * (headphones are assumed) and which a wake word would rather not have.
     *
     * On *classic* Bluetooth this is also the source that lands on HFP/SCO,
     * where the microphone is band-limited — but classic Bluetooth is out of
     * scope, and that is what `tools/check_capture.py` is for.
     */
    VOICE_COMMUNICATION(MediaRecorder.AudioSource.VOICE_COMMUNICATION, "AEC/NS, LE Audio bidirectional"),

    /**
     * What a wake word wants: tuned for speech recognition, and on most devices
     * it leaves automatic gain and noise suppression out of the path. The one
     * to compare against the default — check whether the routed device is still
     * the earbuds.
     */
    VOICE_RECOGNITION(MediaRecorder.AudioSource.VOICE_RECOGNITION, "tuned for ASR"),

    /** The plain microphone, with whatever the device does by default. */
    MIC(MediaRecorder.AudioSource.MIC, "device default processing"),

    /**
     * No processing at all where the device supports it — the honest baseline
     * for judging what the hardware is actually delivering. Not guaranteed:
     * check `AudioManager.getProperty(PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED)`.
     */
    UNPROCESSED(MediaRecorder.AudioSource.UNPROCESSED, "no processing, if supported"),
}

/** Microphone → a [Flow] of fixed-size int16 blocks. */
class AudioCapture(
    val source: CaptureSource = CaptureSource.VOICE_COMMUNICATION,
    val rate: Int = CAPTURE_RATE,
    val blockSamples: Int = CAPTURE_BLOCK_SAMPLES,
) {
    /**
     * How the OS described the device it routed us to, once recording has
     * started. Read after the first block arrives.
     */
    @Volatile
    var routing: String = "not started"
        private set

    /**
     * Blocks of exactly [blockSamples] samples, until the collector stops.
     *
     * Requires `RECORD_AUDIO`; without it `AudioRecord` construction throws and
     * this surfaces as [AudioError] rather than a security exception from inside
     * a flow.
     */
    fun blocks(): Flow<ShortArray> = flow {
        val minBytes = AudioRecord.getMinBufferSize(rate, CHANNEL_IN, ENCODING)
        if (minBytes <= 0) {
            throw AudioError("the device will not capture ${rate} Hz mono 16-bit PCM")
        }
        // Room for several blocks, so a scheduling hiccup in the collector costs
        // latency rather than samples. Overruns are not recoverable: AudioRecord
        // drops the oldest audio silently, and a wake word that was spoken into
        // the gap simply never fires.
        val bufferBytes = maxOf(minBytes, blockSamples * 2 * BUFFER_BLOCKS)

        val recorder = try {
            AudioRecord.Builder()
                .setAudioSource(source.id)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(ENCODING)
                        .setSampleRate(rate)
                        .setChannelMask(CHANNEL_IN)
                        .build()
                )
                .setBufferSizeInBytes(bufferBytes)
                .build()
        } catch (e: SecurityException) {
            throw AudioError("RECORD_AUDIO has not been granted", e)
        } catch (e: UnsupportedOperationException) {
            throw AudioError("could not open ${source.name} at $rate Hz", e)
        } catch (e: IllegalArgumentException) {
            throw AudioError("could not open ${source.name} at $rate Hz", e)
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw AudioError("input device failed to initialize (source ${source.name})")
        }

        try {
            recorder.startRecording()
            if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                throw AudioError("input device would not start (source ${source.name})")
            }
            routing = describeDevice(recorder.routedDevice)
            Log.i(TAG, "capturing at $rate Hz in $blockSamples-sample blocks from $routing")

            val block = ShortArray(blockSamples)
            while (currentCoroutineContext().isActive) {
                // read() can return a partial block; fill before emitting so
                // downstream never sees a short one.
                var filled = 0
                while (filled < blockSamples) {
                    val n = recorder.read(block, filled, blockSamples - filled)
                    when {
                        n > 0 -> filled += n
                        n == 0 -> return@flow // stopped underneath us
                        else -> throw AudioError("read failed: ${readError(n)}")
                    }
                }
                emit(block.copyOf())
            }
        } finally {
            // stop() before release(), and swallow: by the time we are unwinding,
            // an already-dead device is not news.
            runCatching { recorder.stop() }
            recorder.release()
        }
    }.flowOn(Dispatchers.IO)

    private companion object {
        const val CHANNEL_IN = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        const val BUFFER_BLOCKS = 8

        fun readError(code: Int): String = when (code) {
            AudioRecord.ERROR_INVALID_OPERATION -> "ERROR_INVALID_OPERATION (not initialized)"
            AudioRecord.ERROR_BAD_VALUE -> "ERROR_BAD_VALUE"
            AudioRecord.ERROR_DEAD_OBJECT -> "ERROR_DEAD_OBJECT (device went away)"
            else -> "error $code"
        }
    }
}

/**
 * Speaker output fed by a background writer thread.
 *
 * Earcons and speech share one queue, so an earcon queued during playback is
 * heard after the current audio rather than on top of it.
 */
class AudioPlayback(val rate: Int, val channels: Int = 1) {

    private class Chunk(
        val generation: Int,
        val pcm: ShortArray?, // null is the stop sentinel
        val offset: Int = 0,
        val length: Int = 0,
    )

    private val queue = LinkedBlockingQueue<Chunk>()
    private var track: AudioTrack? = null
    private var writer: Thread? = null

    /**
     * Bumped by [flush]. The writer drops any chunk from an earlier generation,
     * which is how audio already in the queue is abandoned rather than played
     * after the interruption.
     */
    @Volatile
    private var generation = 0

    /** Samples per write, from [SLICE_MS]. See [flush] for why this matters. */
    private val sliceSamples = maxOf(1, rate * SLICE_MS / 1000) * channels

    fun start() {
        val minBytes = AudioTrack.getMinBufferSize(rate, channelMask(), ENCODING)
        if (minBytes <= 0) {
            throw AudioError("the device will not play $rate Hz 16-bit PCM")
        }

        val created = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        // ASSISTANT + SPEECH, not VOICE_COMMUNICATION: this is a
                        // media path, and asking for the telephony one would put
                        // a Bluetooth headset on the narrowband call profile.
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(ENCODING)
                        .setSampleRate(rate)
                        .setChannelMask(channelMask())
                        .build()
                )
                // Small on purpose. flush() drops whatever the device is holding,
                // so this buffer is the floor on how much already-committed audio
                // still gets heard after a barge-in.
                .setBufferSizeInBytes(maxOf(minBytes, sliceSamples * 2 * SLICE_BUFFERS))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: UnsupportedOperationException) {
            throw AudioError("could not open output at $rate Hz", e)
        } catch (e: IllegalArgumentException) {
            throw AudioError("could not open output at $rate Hz", e)
        }

        if (created.state != AudioTrack.STATE_INITIALIZED) {
            created.release()
            throw AudioError("output device failed to initialize")
        }

        track = created
        created.play()
        writer = Thread(::drain, "yammer-playback").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "playing back at $rate Hz, ${describeDevice(created.routedDevice)}")
    }

    private fun drain() {
        while (true) {
            val chunk = queue.take()
            val pcm = chunk.pcm ?: return
            if (chunk.generation != generation) continue // flushed while queued
            val active = track ?: return
            try {
                active.write(pcm, chunk.offset, chunk.length, AudioTrack.WRITE_BLOCKING)
            } catch (e: IllegalStateException) {
                Log.e(TAG, "playback write failed", e)
            }
        }
    }

    /**
     * Queue PCM at this track's rate.
     *
     * Sliced on the way in rather than written whole, and the reason differs from
     * the Python client's. There, the slice size bounds how long `flush()` waits
     * for a blocking write. Here it bounds something sharper: a `WRITE_BLOCKING`
     * write cannot be abandoned, so a whole sentence handed over in one call is a
     * whole sentence that has to be written before the writer thread can notice
     * it has been flushed. Slicing keeps that to one slice.
     */
    fun play(pcm: ShortArray) {
        val at = generation
        var offset = 0
        while (offset < pcm.size) {
            val length = minOf(sliceSamples, pcm.size - offset)
            queue.put(Chunk(at, pcm, offset, length))
            offset += length
        }
    }

    /** Queue an earcon, synthesized at this track's rate. */
    fun play(earcon: Earcons.Earcon) = play(Earcons.pcm(earcon, rate))

    /**
     * Barge-in: drop everything not yet heard.
     *
     * Three steps, in this order. The generation bumps first so the writer
     * discards anything it has already taken from the queue; then the queue is
     * drained; then the device's own buffer is dropped, which is the part the
     * desktop client cannot do — there, `flush()` leaves whatever PortAudio is
     * holding to play out. `AudioTrack.flush()` only takes effect on a paused
     * track, hence the pause/flush/play sandwich.
     *
     * What still gets heard: at most the slice being written, plus however much
     * the device had already committed to hardware.
     */
    fun flush() {
        generation++
        queue.clear()
        val active = track ?: return
        try {
            active.pause()
            active.flush()
            active.play()
        } catch (e: IllegalStateException) {
            Log.e(TAG, "flush failed", e)
        }
    }

    fun stop() {
        queue.put(Chunk(generation, null))
        writer?.join(2_000)
        writer = null
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            it.release()
        }
        track = null
    }

    private fun channelMask(): Int =
        if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO

    private companion object {
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /**
         * 40 ms, matching the desktop client. Well under the point where a cut
         * sounds laggy, and coarse enough not to thrash the device.
         */
        const val SLICE_MS = 40
        const val SLICE_BUFFERS = 4
    }
}

/**
 * What the OS says it routed us to.
 *
 * The device *type* is the diagnostic that matters. `BLE_HEADSET` is the
 * supported path; `BLUETOOTH_SCO` means the OS put us on classic Bluetooth's
 * telephony profile, where the microphone is capped at 8 or 16 kHz — audio that
 * sounds fine and has already lost the bandwidth. `BUILTIN_MIC` while earbuds
 * are connected means the earbuds are being used for output only.
 */
fun describeDevice(device: AudioDeviceInfo?): String {
    if (device == null) return "unknown device (the OS did not say)"
    val type = when (device.type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET (LE Audio — the supported path)"
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> "BLE_SPEAKER (LE Audio)"
        AudioDeviceInfo.TYPE_BLE_BROADCAST -> "BLE_BROADCAST"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO (classic telephony — band-limited)"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP (classic, output only)"
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "BUILTIN_MIC (the phone's own microphone)"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER (the phone's own speaker)"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
        AudioDeviceInfo.TYPE_TELEPHONY -> "TELEPHONY"
        else -> "type ${device.type}"
    }
    val rates = device.sampleRates.takeIf { it.isNotEmpty() }?.joinToString(",") ?: "unreported"
    return "${device.productName}: $type, rates $rates"
}
