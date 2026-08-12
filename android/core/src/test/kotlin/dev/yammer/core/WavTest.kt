package dev.yammer.core

import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The WAV codec, which exists so captured audio can leave the phone and have its
 * spectrum measured on a desktop.
 *
 * The reader is checked against `fixtures/wakeword/input.wav` — a file written by
 * Python's `wave` module, so this is a cross-language check and not a
 * round-trip against our own writer.
 */
class WavTest {

    @Test
    fun `reads the fixture WAV written by Python`() {
        val file = File(Fixture.fixturesDir, "wakeword/input.wav")
        val audio = Wav.read(file.readBytes())

        assertEquals(AudioFeatures.SAMPLE_RATE, audio.rate, "capture rate")
        assertEquals(1, audio.channels, "mono")
        assertEquals(
            Fixture.golden.obj("input").int("samples"), audio.pcm.size,
            "sample count should agree with the wake-word fixture",
        )
    }

    @Test
    fun `round-trips an earcon`() {
        val pcm = Earcons.pcm(Earcons.Earcon.PERMISSION, 24_000)
        val out = ByteArrayOutputStream()
        Wav.write(out, pcm, rate = 24_000)

        val audio = Wav.read(out.toByteArray())
        assertEquals(24_000, audio.rate)
        assertEquals(1, audio.channels)
        assertContentEquals(pcm, audio.pcm, "samples should survive the round trip")
    }

    @Test
    fun `header declares the lengths the payload actually has`() {
        val samples = 1600
        val header = Wav.header(dataBytes = samples * 2, rate = 16_000)
        assertEquals(44, header.size)

        fun u32(at: Int) = (header[at].toInt() and 0xFF) or
            ((header[at + 1].toInt() and 0xFF) shl 8) or
            ((header[at + 2].toInt() and 0xFF) shl 16) or
            ((header[at + 3].toInt() and 0xFF) shl 24)

        assertEquals(36 + samples * 2, u32(4), "RIFF size is everything after the first 8 bytes")
        assertEquals(samples * 2, u32(40), "data size")
        assertEquals(16_000, u32(24), "sample rate")
        assertEquals(32_000, u32(28), "byte rate for 16-bit mono at 16 kHz")
    }

    /**
     * The reader walks the chunk list rather than assuming audio starts at byte
     * 44. Encoders really do insert `LIST` before `data`, and a reader that
     * trusts the canonical offset returns metadata bytes as audio — which plays
     * as a click followed by correct-sounding audio, i.e. it looks like it works.
     */
    @Test
    fun `finds the data chunk past an odd-sized LIST chunk`() {
        val pcm = shortArrayOf(0, 1000, -1000, 32767, -32768)
        val canonical = ByteArrayOutputStream().also { Wav.write(it, pcm, 16_000) }.toByteArray()

        // "LIST" + size 5 + 5 bytes + 1 pad byte, spliced in after "WAVE".
        val list = byteArrayOf(
            'L'.code.toByte(), 'I'.code.toByte(), 'S'.code.toByte(), 'T'.code.toByte(),
            5, 0, 0, 0,
            'y'.code.toByte(), 'a'.code.toByte(), 'm'.code.toByte(), 'm'.code.toByte(),
            'y'.code.toByte(),
            0, // pad to an even boundary
        )
        val spliced = canonical.copyOfRange(0, 12) + list + canonical.copyOfRange(12, canonical.size)

        val audio = Wav.read(spliced)
        assertContentEquals(pcm, audio.pcm)
        assertEquals(16_000, audio.rate)
    }

    @Test
    fun `rejects what it cannot represent instead of guessing`() {
        val good = ByteArrayOutputStream()
            .also { Wav.write(it, shortArrayOf(1, 2, 3), 16_000) }
            .toByteArray()

        assertFailsWith<Wav.WavError>("not RIFF") { Wav.read("nonsense but long enough".toByteArray()) }
        assertFailsWith<Wav.WavError>("too short") { Wav.read(byteArrayOf(1, 2, 3)) }

        // 8-bit samples: readable as RIFF, but every sample would be wrong.
        val eightBit = good.copyOf().also { it[34] = 8 }
        val bits = assertFailsWith<Wav.WavError> { Wav.read(eightBit) }
        assertTrue(bits.message!!.contains("8-bit"), "should name the problem: ${bits.message}")

        // A compressed format whose data chunk is not PCM at all.
        val compressed = good.copyOf().also { it[20] = 17 }
        assertFailsWith<Wav.WavError> { Wav.read(compressed) }
    }

    @Test
    fun `a data size of zero falls back to what is present`() {
        // A recorder killed before it could seek back and fix the header leaves
        // the size at zero. Playing that as silence is indistinguishable from a
        // microphone that captured nothing, so recover the samples instead.
        val pcm = ShortArray(64) { (it * 100).toShort() }
        val bytes = ByteArrayOutputStream().also { Wav.write(it, pcm, 16_000) }.toByteArray()
        for (i in 40..43) bytes[i] = 0

        assertContentEquals(pcm, Wav.read(bytes).pcm)
    }
}
