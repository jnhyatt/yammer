package dev.yammer.android

import android.util.Log
import dev.yammer.core.AudioFormat
import dev.yammer.core.Speaker

/**
 * [Speaker] on a real `AudioTrack`.
 *
 * The whole adapter, and it is this small on purpose: `AudioPlayback` already
 * does the hard parts (the writer thread, the slicing, the pause/flush/play
 * sandwich that barge-in needs), and `core` is not allowed to know they exist.
 *
 * The track is built in [open] rather than in a constructor because the sample
 * rate is not known until `hello.ok` arrives — the server declares it, and
 * PROTOCOL.md says the client must honour it rather than assume Kokoro's 24 kHz.
 */
class TrackSpeaker : Speaker {

    @Volatile
    private var playback: AudioPlayback? = null

    /** The track currently open, for a UI that wants to say what rate it got. */
    val rate: Int? get() = playback?.rate

    override fun open(format: AudioFormat) {
        close()
        playback = AudioPlayback(format.rate, format.channels).also { it.start() }
        Log.i(TAG, "playback open at ${format.rate} Hz, ${format.channels} channel(s)")
    }

    override fun play(pcm: ShortArray) {
        playback?.play(pcm)
    }

    override fun flush() {
        playback?.flush()
    }

    override fun close() {
        playback?.stop()
        playback = null
    }

    private companion object {
        const val TAG = "TrackSpeaker"
    }
}
