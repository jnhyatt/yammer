package dev.yammer.core

import java.io.OutputStream

/**
 * Minimal RIFF/WAVE reader and writer for mono 16-bit PCM.
 *
 * This exists for one job: getting captured audio off the phone and onto a
 * desktop where its spectrum can be measured. "The microphone works" is not
 * something you can establish by listening — a Bluetooth stream capped at 8 kHz
 * and resampled to 16 kHz sounds perfectly fine, and that lost bandwidth is not
 * recoverable downstream of the codec. So the app writes a WAV and
 * `android/tools/check_capture.py` measures it.
 *
 * Deliberately not a general WAV implementation: 16-bit PCM only, and reading
 * rejects anything else rather than guessing.
 */
object Wav {

    private const val HEADER_BYTES = 44
    private const val FORMAT_PCM = 1

    class WavError(message: String) : Exception(message)

    /**
     * Write a 44-byte canonical header followed by [pcm] as little-endian int16.
     *
     * The header carries the total length, so this cannot be used to stream an
     * unknown number of samples — see [header] for that case.
     */
    fun write(out: OutputStream, pcm: ShortArray, rate: Int, channels: Int = 1) {
        out.write(header(pcm.size * 2, rate, channels))
        val bytes = ByteArray(pcm.size * 2)
        for (i in pcm.indices) {
            val v = pcm[i].toInt()
            bytes[i * 2] = (v and 0xFF).toByte()
            bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
        }
        out.write(bytes)
    }

    /**
     * The 44-byte header for [dataBytes] of payload.
     *
     * Split out because a recorder does not know how long the recording is until
     * it stops: write a placeholder header, stream the samples, then seek back
     * and overwrite it with this. A file whose header still claims zero samples
     * plays as silence in every tool that reads it, which looks exactly like a
     * microphone that captured nothing.
     */
    fun header(dataBytes: Int, rate: Int, channels: Int = 1): ByteArray {
        val bytesPerFrame = channels * 2
        val out = ByteArray(HEADER_BYTES)
        var i = 0
        fun ascii(s: String) { for (c in s) out[i++] = c.code.toByte() }
        fun u32(v: Int) {
            out[i++] = (v and 0xFF).toByte()
            out[i++] = ((v shr 8) and 0xFF).toByte()
            out[i++] = ((v shr 16) and 0xFF).toByte()
            out[i++] = ((v shr 24) and 0xFF).toByte()
        }
        fun u16(v: Int) {
            out[i++] = (v and 0xFF).toByte()
            out[i++] = ((v shr 8) and 0xFF).toByte()
        }

        ascii("RIFF")
        u32(HEADER_BYTES - 8 + dataBytes)
        ascii("WAVE")
        ascii("fmt ")
        u32(16)                       // PCM fmt chunk size
        u16(FORMAT_PCM)
        u16(channels)
        u32(rate)
        u32(rate * bytesPerFrame)     // byte rate
        u16(bytesPerFrame)            // block align
        u16(16)                       // bits per sample
        ascii("data")
        u32(dataBytes)
        return out
    }

    data class Audio(val pcm: ShortArray, val rate: Int, val channels: Int) {
        // Generated equals/hashCode would compare the array by identity, which
        // makes assertion failures in tests read as "arrays differ" when they do
        // not. Compare contents.
        override fun equals(other: Any?): Boolean =
            other is Audio && rate == other.rate && channels == other.channels &&
                pcm.contentEquals(other.pcm)

        override fun hashCode(): Int = 31 * (31 * pcm.contentHashCode() + rate) + channels
    }

    /**
     * Read 16-bit PCM from a complete WAV file.
     *
     * Walks the chunk list rather than assuming a 44-byte header: real encoders
     * insert `LIST` and `fact` chunks before `data`, and a reader that trusts the
     * canonical offset silently reads metadata as audio.
     */
    fun read(bytes: ByteArray): Audio {
        fun u32(at: Int): Int {
            if (at + 4 > bytes.size) throw WavError("truncated at offset $at")
            return (bytes[at].toInt() and 0xFF) or
                ((bytes[at + 1].toInt() and 0xFF) shl 8) or
                ((bytes[at + 2].toInt() and 0xFF) shl 16) or
                ((bytes[at + 3].toInt() and 0xFF) shl 24)
        }
        fun u16(at: Int): Int {
            if (at + 2 > bytes.size) throw WavError("truncated at offset $at")
            return (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)
        }
        fun tag(at: Int): String =
            if (at + 4 > bytes.size) "" else String(bytes, at, 4, Charsets.US_ASCII)

        if (bytes.size < 12) throw WavError("too short to be a WAV file (${bytes.size} bytes)")
        if (tag(0) != "RIFF" || tag(8) != "WAVE") throw WavError("not a RIFF/WAVE file")

        var rate = 0
        var channels = 0
        var bits = 0
        var dataAt = -1
        var dataBytes = 0

        var at = 12
        while (at + 8 <= bytes.size) {
            val id = tag(at)
            val size = u32(at + 4)
            if (size < 0) throw WavError("chunk '$id' declares an implausible size")
            val body = at + 8
            when (id) {
                "fmt " -> {
                    if (size < 16) throw WavError("fmt chunk is $size bytes, need 16")
                    val format = u16(body)
                    if (format != FORMAT_PCM) {
                        throw WavError("format $format is not uncompressed PCM")
                    }
                    channels = u16(body + 2)
                    rate = u32(body + 4)
                    bits = u16(body + 14)
                }
                "data" -> {
                    dataAt = body
                    // Some writers leave the size at 0 or 0xFFFFFFFF for a stream;
                    // fall back to whatever is actually present.
                    dataBytes = if (size == 0 || body + size > bytes.size) bytes.size - body else size
                }
            }
            // Chunks are word-aligned: an odd size is followed by a pad byte.
            at = body + size + (size and 1)
        }

        if (rate == 0) throw WavError("no fmt chunk")
        if (dataAt < 0) throw WavError("no data chunk")
        if (bits != 16) throw WavError("$bits-bit samples are not supported, need 16")

        val count = dataBytes / 2
        val pcm = ShortArray(count)
        for (i in 0 until count) {
            val lo = bytes[dataAt + i * 2].toInt() and 0xFF
            val hi = bytes[dataAt + i * 2 + 1].toInt()
            pcm[i] = ((hi shl 8) or lo).toShort()
        }
        return Audio(pcm, rate, channels)
    }
}
