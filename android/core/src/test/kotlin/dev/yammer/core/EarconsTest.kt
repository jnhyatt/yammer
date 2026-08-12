package dev.yammer.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The earcons against `fixtures/earcons/golden.json`.
 *
 * These are the only status channel the user has, and a drifted port is silent:
 * five plausible beeps still play, they just stop meaning what the desktop
 * client's mean. So the comparison is per sample.
 *
 * The tolerance is asymmetric on purpose. Sample *values* allow ±1 LSB, because
 * both sides truncate toward zero into int16 and a value sitting within a float
 * ulp of an integer boundary may legitimately land either side of it — inaudible
 * at 90 dB down. Everything structural allows nothing: lengths, per-segment
 * boundaries, and the silences, which must be digital zero.
 */
class EarconsTest {

    /** ±1 LSB, for the truncation-boundary reason in the class comment. */
    private val tolerance = 1

    @Test
    fun `every earcon matches the fixture at every rate`() {
        var worstDelta = 0
        var differing = 0
        var compared = 0

        for (earcon in Earcons.Earcon.entries) {
            val perRate = Fixture.earcons.obj("earcons").obj(earcon.key)
            for (rate in Fixture.earconRates) {
                val expected = perRate.obj(rate.toString())
                val want = Fixture.pcmOf(expected)
                val got = Earcons.pcm(earcon, rate)

                assertEquals(
                    expected.int("samples"), got.size,
                    "${earcon.key} at $rate Hz: sample count",
                )
                assertEquals(
                    expected.int("peak"), Earcons.peak(got),
                    "${earcon.key} at $rate Hz: peak amplitude",
                )

                for (i in want.indices) {
                    val delta = abs(want[i] - got[i])
                    compared++
                    if (delta > 0) differing++
                    if (delta > worstDelta) worstDelta = delta
                    assertTrue(
                        delta <= tolerance,
                        "${earcon.key} at $rate Hz sample $i: expected ${want[i]}, got ${got[i]}",
                    )
                }
            }
        }

        // A passing run should still say how much headroom it had — and how much
        // of the truncation-boundary effect the ±1 is actually absorbing.
        val percent = 100.0 * differing / compared
        println(
            "earcons: $compared samples, worst |Δ| $worstDelta LSB, " +
                "$differing differing (${"%.4f".format(percent)}%)"
        )
    }

    @Test
    fun `silences are digital zero`() {
        for (earcon in Earcons.Earcon.entries) {
            val perRate = Fixture.earcons.obj("earcons").obj(earcon.key)
            for (rate in Fixture.earconRates) {
                val pcm = Earcons.pcm(earcon, rate)
                for (range in perRate.obj(rate.toString()).arr("silences")) {
                    val (from, until) = range.jsonArray.ints()
                    for (i in from until until) {
                        assertEquals(
                            0, pcm[i].toInt(),
                            "${earcon.key} at $rate Hz: sample $i is in a silence",
                        )
                    }
                }
            }
        }
    }

    /**
     * Each segment synthesized on its own, against its slice of the whole
     * earcon.
     *
     * This is the test that localizes. The whole-earcon comparison above says
     * *that* something diverged; this one says which tone, and separates a wrong
     * frequency from a wrong duration from a concatenation off by one — all of
     * which produce the same "the earcon differs" from the outside.
     */
    @Test
    fun `each segment matches its slice, synthesized alone`() {
        var segments = 0
        for (earcon in Earcons.Earcon.entries) {
            val perRate = Fixture.earcons.obj("earcons").obj(earcon.key)
            for (rate in Fixture.earconRates) {
                val expected = perRate.obj(rate.toString())
                val want = Fixture.pcmOf(expected)
                var offset = 0

                for (element in expected.arr("segments")) {
                    val segment = element as JsonObject
                    val seconds = segment.dbl("seconds")
                    val samples = segment.int("samples")
                    val kind = segment.str("kind")

                    val wave = when (kind) {
                        "silence" -> Earcons.silence(seconds, rate)
                        "tone" -> Earcons.tone(segment.dbl("freq"), seconds, rate)
                        "sweep" -> Earcons.sweep(
                            segment.dbl("startFreq"), segment.dbl("endFreq"), seconds, rate,
                        )
                        else -> error("unknown segment kind '$kind'")
                    }

                    assertEquals(
                        samples, wave.size,
                        "${earcon.key} at $rate Hz: $kind of ${seconds}s should be $samples samples",
                    )
                    if (kind != "silence") {
                        assertEquals(
                            maxOf(1, (Earcons.FADE_SECONDS * rate).toInt()),
                            segment.int("ramp"),
                            "${earcon.key} at $rate Hz: fade ramp length",
                        )
                    }

                    val alone = Earcons.toPcm(wave)
                    for (i in 0 until samples) {
                        assertTrue(
                            abs(want[offset + i] - alone[i]) <= tolerance,
                            "${earcon.key} at $rate Hz, $kind at offset $offset, sample $i: " +
                                "expected ${want[offset + i]}, got ${alone[i]}",
                        )
                    }
                    offset += samples
                    segments++
                }

                assertEquals(
                    want.size, offset,
                    "${earcon.key} at $rate Hz: segments sum to $offset, earcon is ${want.size}",
                )
            }
        }
        println("earcon segments: $segments checked in isolation")
    }

    /**
     * `start` and `stop` are the same two notes in opposite order, and `busy`
     * repeats one of them. A copy-paste slip between any two of the five is a
     * bug the fixture comparison would catch — but only because this asserts the
     * five are actually different signals rather than trusting that they are.
     */
    @Test
    fun `the five earcons are pairwise distinct`() {
        val rate = 24_000
        val all = Earcons.all(rate)
        for (a in Earcons.Earcon.entries) {
            for (b in Earcons.Earcon.entries) {
                if (a.ordinal >= b.ordinal) continue
                assertTrue(
                    !all.getValue(a).contentEquals(all.getValue(b)),
                    "${a.key} and ${b.key} are the same audio",
                )
            }
        }
    }

    @Test
    fun `every earcon has energy and none clips`() {
        for (rate in Fixture.earconRates) {
            for ((earcon, pcm) in Earcons.all(rate)) {
                val peak = Earcons.peak(pcm)
                // 0.28 full scale, truncated: nothing should reach the rails, and
                // nothing should be inaudibly quiet either.
                assertEquals(9174, peak, "${earcon.key} at $rate Hz: peak")
                assertTrue(
                    pcm.count { it.toInt() != 0 } > pcm.size / 4,
                    "${earcon.key} at $rate Hz: mostly silent",
                )
            }
        }
    }

    @Test
    fun `pcm is cached per earcon and rate`() {
        val first = Earcons.pcm(Earcons.Earcon.BUSY, 24_000)
        assertSame(first, Earcons.pcm(Earcons.Earcon.BUSY, 24_000), "should be the cached array")
        assertNotEquals(
            first.size, Earcons.pcm(Earcons.Earcon.BUSY, 16_000).size,
            "a different rate is a different length",
        )
    }

    /**
     * numpy's `linspace` assigns the final element to `stop` outright instead of
     * letting `i * step` land near it, and computes at double precision before
     * narrowing. The endpoints are where the fades reach exactly zero, so an
     * approximation here is an audible click at the edge of every tone.
     */
    @Test
    fun `linspace matches numpy at the endpoints and the degenerate case`() {
        val up = Earcons.linspace(0.0, 1.0, 128)
        assertEquals(128, up.size)
        assertEquals(0.0f, up[0], "first element is exactly the start")
        assertEquals(1.0f, up[127], "last element is exactly the stop")

        val down = Earcons.linspace(1.0, 0.0, 128)
        assertEquals(1.0f, down[0])
        assertEquals(0.0f, down[127], "the fade-out must reach exactly zero")

        // A step of 1/(num-1) is undefined for num == 1; numpy yields [start].
        assertEquals(1, Earcons.linspace(1.0, 0.0, 1).size)
        assertEquals(1.0f, Earcons.linspace(1.0, 0.0, 1)[0])
        assertEquals(0, Earcons.linspace(0.0, 1.0, 0).size)
    }

    @Test
    fun `amplitude and fade agree with the fixture`() {
        assertEquals(
            Fixture.earcons.dbl("amplitude").toFloat(), Earcons.AMPLITUDE,
            "AMPLITUDE drifted from earcons.py",
        )
        assertEquals(
            Fixture.earcons.dbl("fadeSeconds"), Earcons.FADE_SECONDS,
            "the fade length drifted from earcons.py",
        )
    }
}
