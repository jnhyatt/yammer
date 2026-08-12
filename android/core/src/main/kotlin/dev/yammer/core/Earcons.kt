package dev.yammer.core

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

/**
 * Earcons — the system's only status channel.
 *
 * A port of `client/src/yammer_client/earcons.py`, and the reason it is in this
 * module rather than the app is that it is pure arithmetic: keeping it here
 * means the five earcons are pinned to `fixtures/earcons/golden.json` under
 * plain JVM tests instead of being judged by ear.
 *
 * With no screen and no keyboard these carry everything the user knows about
 * what state Yammer is in. The five are deliberately distinguishable from each
 * other and from synthesized speech:
 *
 * ```
 *     start       two rising tones      "I'm listening"
 *     stop        two falling tones     "got it, working"
 *     busy        low double blip       "I'm still on the last one"
 *     error       descending buzz       "that failed"
 *     permission  rising two-note query "answer me before I do this"
 * ```
 *
 * They are synthesized rather than shipped as audio assets so they always match
 * the playback rate the server declared in `hello.ok`, whatever that is.
 *
 * ## On float32
 *
 * Every intermediate here is [Float], not [Double], and that is deliberate
 * rather than an optimization. The Python side computes in numpy float32
 * throughout, and the last step truncates toward zero into int16 — so a value
 * carried at double precision can land on the other side of an integer boundary
 * and produce a different sample. The port matches the narrowing points, which
 * is what makes the fixture agree to within a single LSB.
 *
 * The one place this bites hardest is [sweep]: its phase is a *running sum* of
 * per-sample frequencies, accumulated in float32. Accumulating that in double
 * would be more accurate and would not match.
 */
object Earcons {

    /** Loud enough to hear over a room, quiet enough not to startle next to speech. */
    const val AMPLITUDE: Float = 0.28f

    /** Fade in and out of every tone, so it clicks at neither end. */
    const val FADE_SECONDS: Double = 0.008

    /** The five. [key] is the name shared with `earcons.py` and the fixture. */
    enum class Earcon(val key: String) {
        START_RECORD("start_record"),
        STOP_RECORD("stop_record"),
        BUSY("busy"),
        PERMISSION("permission"),
        ERROR("error"),
    }

    private val cache = HashMap<Long, ShortArray>()

    /**
     * PCM for [earcon] at [rate], as signed 16-bit mono samples.
     *
     * Cached per earcon and rate, and the returned array is **shared** — callers
     * read it and must not modify it. Playback only ever writes it to a device.
     */
    @Synchronized
    fun pcm(earcon: Earcon, rate: Int): ShortArray {
        require(rate > 0) { "rate must be positive, got $rate" }
        val cacheKey = earcon.ordinal.toLong() shl 32 or rate.toLong()
        return cache.getOrPut(cacheKey) { synthesize(earcon, rate) }
    }

    /** Every earcon at [rate], in enum order. Warms the cache. */
    fun all(rate: Int): Map<Earcon, ShortArray> =
        Earcon.entries.associateWith { pcm(it, rate) }

    private fun synthesize(earcon: Earcon, rate: Int): ShortArray = when (earcon) {
        // Rising major third. Opens upward: something has begun.
        Earcon.START_RECORD -> toPcm(
            concat(tone(660.0, 0.07, rate), silence(0.02, rate), tone(880.0, 0.09, rate))
        )
        // The same interval inverted. Closes downward: handed off.
        Earcon.STOP_RECORD -> toPcm(
            concat(tone(880.0, 0.07, rate), silence(0.02, rate), tone(660.0, 0.09, rate))
        )
        // Low, flat, repeated — a closed door, not a failure.
        Earcon.BUSY -> toPcm(
            concat(tone(330.0, 0.06, rate), silence(0.05, rate), tone(330.0, 0.06, rate))
        )
        // Two rising notes ending on an unresolved interval — an audible question.
        //
        // Deliberately not START_RECORD: that one means "I am recording what you
        // say next", this one means "I am blocked until you answer". They sit in
        // different registers so a half-heard one is still unambiguous.
        Earcon.PERMISSION -> toPcm(
            concat(
                tone(520.0, 0.08, rate),
                silence(0.03, rate),
                tone(740.0, 0.08, rate),
                silence(0.03, rate),
                tone(990.0, 0.12, rate),
            )
        )
        // A long fall. Unmistakably different from the two-tone pair.
        Earcon.ERROR -> toPcm(sweep(440.0, 180.0, 0.35, rate))
    }

    /** A sine burst with short fades. */
    internal fun tone(freq: Double, seconds: Double, rate: Int): FloatArray {
        val samples = (seconds * rate).toInt()
        // `2π * freq` is computed at double precision and narrowed once, exactly
        // as numpy narrows the scalar before multiplying it into the float32
        // sample-time array.
        val omega = (2.0 * PI * freq).toFloat()
        val rateF = rate.toFloat()
        val wave = FloatArray(samples) { sin((omega * (it.toFloat() / rateF)).toDouble()).toFloat() }
        applyFades(wave, rate)
        return wave
    }

    internal fun silence(seconds: Double, rate: Int): FloatArray =
        FloatArray((seconds * rate).toInt())

    /**
     * Linear frequency sweep — reads as a single gesture rather than two notes.
     *
     * The phase is the running sum of the per-sample frequency, accumulated in
     * float32 to match numpy's `cumsum`. See the note on float32 above.
     */
    internal fun sweep(startFreq: Double, endFreq: Double, seconds: Double, rate: Int): FloatArray {
        val samples = (seconds * rate).toInt()
        val freq = linspace(startFreq, endFreq, samples)
        val twoPi = (2.0 * PI).toFloat()
        val rateF = rate.toFloat()

        val wave = FloatArray(samples)
        var running = 0.0f
        for (i in 0 until samples) {
            running += freq[i]
            wave[i] = sin(((twoPi * running) / rateF).toDouble()).toFloat()
        }
        applyFades(wave, rate)
        return wave
    }

    /**
     * Ramp the first and last [FADE_SECONDS] to and from zero, in place.
     *
     * Skipped entirely when the burst is shorter than both ramps together —
     * the guard exists in `earcons.py` and no earcon segment trips it, but a
     * port that dropped it would diverge on any future short one.
     */
    private fun applyFades(wave: FloatArray, rate: Int) {
        val ramp = maxOf(1, (FADE_SECONDS * rate).toInt())
        if (wave.size <= 2 * ramp) return

        val up = linspace(0.0, 1.0, ramp)
        val down = linspace(1.0, 0.0, ramp)
        for (i in 0 until ramp) {
            wave[i] *= up[i]
            wave[wave.size - ramp + i] *= down[i]
        }
    }

    /**
     * `np.linspace(start, stop, num, dtype=np.float32)`.
     *
     * Two details are load-bearing. numpy computes the ramp at double precision
     * and narrows to float32 only at the end, and it assigns the final element
     * to `stop` outright rather than letting `i * step` land near it — so the
     * fades reach exactly zero and one. A naive `i / (num - 1)` agrees at most
     * sample positions and not at the endpoints, which is precisely where an
     * audible click would come from.
     */
    internal fun linspace(start: Double, stop: Double, num: Int): FloatArray {
        require(num >= 0) { "num must not be negative, got $num" }
        val out = FloatArray(num)
        if (num == 0) return out
        // num == 1 has an undefined step; numpy yields [start].
        if (num == 1) {
            out[0] = start.toFloat()
            return out
        }
        val step = (stop - start) / (num - 1)
        for (i in 0 until num) out[i] = (i * step + start).toFloat()
        out[num - 1] = stop.toFloat()
        return out
    }

    private fun concat(vararg parts: FloatArray): FloatArray {
        val out = FloatArray(parts.sumOf { it.size })
        var offset = 0
        for (part in parts) {
            part.copyInto(out, offset)
            offset += part.size
        }
        return out
    }

    /**
     * Scale to [AMPLITUDE], clip, and truncate into int16.
     *
     * `toInt()` truncates toward zero, which is what numpy's `astype("<i2")`
     * does — rounding instead would disagree with the fixture on roughly half
     * the samples.
     */
    internal fun toPcm(wave: FloatArray): ShortArray = ShortArray(wave.size) {
        val scaled = (wave[it] * AMPLITUDE).coerceIn(-1.0f, 1.0f) * 32767.0f
        scaled.toInt().toShort()
    }

    /** Peak absolute sample, for logging and for the tests. */
    internal fun peak(pcm: ShortArray): Int = pcm.maxOfOrNull { abs(it.toInt()) } ?: 0
}
