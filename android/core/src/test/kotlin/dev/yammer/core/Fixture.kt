package dev.yammer.core

import ai.onnxruntime.OrtEnvironment
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Base64
import kotlin.math.abs
import kotlin.test.assertTrue

/**
 * The golden vectors, the models they were generated against, and the audio
 * they were generated from.
 *
 * All three are shared with the Python side rather than copied under
 * `src/test/resources`: the fixture is written by
 * `client/tools/make_golden_vectors.py`, and the models are the same files the
 * app ships as assets. A copy here would drift, and drift in a fixture is worse
 * than no fixture — it fails loudly for the wrong reason, or quietly for none.
 */
object Fixture {
    val modelsDir: File = File(property("yammer.models.dir"))
    val fixturesDir: File = File(property("yammer.fixtures.dir"))

    val models: ModelSource = ModelSource.directory(modelsDir)

    val golden: JsonObject =
        Json.parseToJsonElement(File(fixturesDir, "wakeword/golden.json").readText()).jsonObject

    /** `fixtures/earcons/golden.json` — see `client/tools/make_earcon_vectors.py`. */
    val earcons: JsonObject =
        Json.parseToJsonElement(File(fixturesDir, "earcons/golden.json").readText()).jsonObject

    /** The rates the earcon fixture was generated at, read from the fixture. */
    val earconRates: List<Int> get() = earcons.arr("rates").ints().toList()

    /** The `pcmBase64` of one earcon entry, as int16 samples. */
    fun pcmOf(entry: JsonObject): ShortArray {
        val bytes = Base64.getDecoder().decode(entry.str("pcmBase64"))
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        return ShortArray(buffer.remaining()).also { buffer.get(it) }
    }

    val config: JsonObject get() = golden.obj("config")
    val probes: JsonObject get() = golden.obj("probes")
    val blocks: JsonArray get() = golden.arr("blocks")

    val startModel: String get() = config.str("startModel")
    val stopModel: String get() = config.str("stopModel")

    val thresholds: Map<String, Double>
        get() = config.obj("thresholds").mapValues { (_, v) -> v.jsonPrimitive.double }

    val refractorySeconds: Double get() = config.dbl("refractorySeconds")

    /** The classifier assets, keyed the way the models report themselves. */
    val classifiers: Map<String, String>
        get() = golden.obj("models")
            .filterKeys { it != "melspectrogram" && it != "embedding" && it != "vad" }
            .mapValues { (_, v) -> v.jsonObject.str("file") }

    /** `input.wav`, split into the 80 ms blocks the client captures. */
    val audioBlocks: List<ShortArray> by lazy {
        val samples = Wav.read(File(fixturesDir, "wakeword/input.wav").readBytes()).pcm
        val expected = golden.obj("input").int("samples")
        check(samples.size == expected) { "input.wav has ${samples.size} samples, fixture says $expected" }
        (samples.indices step AudioFeatures.BLOCK_SAMPLES).map { at ->
            samples.copyOfRange(at, at + AudioFeatures.BLOCK_SAMPLES)
        }
    }

    private fun property(name: String): String =
        checkNotNull(System.getProperty(name)) {
            "-D$name is not set; run these tests through Gradle"
        }

    fun sha256(file: File): String =
        MessageDigest.getInstance("SHA-256")
            .digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }

}

// -- JSON access ------------------------------------------------------------
//
// Untyped on purpose. Typed deserialization would need @Serializable mirrors of
// the fixture's shape, which is one more description of the same thing to keep
// in step; here the test reads the fixture's own key names directly.

fun JsonObject.obj(key: String): JsonObject = getValue(key).jsonObject
fun JsonObject.arr(key: String): JsonArray = getValue(key).jsonArray
fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content
fun JsonObject.int(key: String): Int = getValue(key).jsonPrimitive.content.toInt()
fun JsonObject.dbl(key: String): Double = getValue(key).jsonPrimitive.double
fun JsonObject.doubles(key: String): DoubleArray = arr(key).doubles()
fun JsonArray.doubles(): DoubleArray = DoubleArray(size) { this[it].jsonPrimitive.double }
fun JsonArray.ints(): IntArray = IntArray(size) { this[it].jsonPrimitive.content.toInt() }
fun JsonArray.rows(): List<DoubleArray> = map { it.jsonArray.doubles() }

// -- Comparison -------------------------------------------------------------

/**
 * Accumulates the worst disagreement across a whole comparison instead of
 * failing on the first one.
 *
 * A port that is off by a rounding step everywhere and a port that is wrong in
 * one place look identical when the assertion stops at the first mismatch. The
 * worst value is reported either way, so a passing run still says how much
 * headroom it had.
 */
class Divergence(private val label: String) {
    private var worst = 0.0
    private var where = "nothing compared"
    private var count = 0

    fun compare(expected: Double, actual: Double, at: () -> String) {
        count++
        val delta = abs(expected - actual)
        if (delta > worst) {
            worst = delta
            where = "${at()}: expected $expected, got $actual"
        }
    }

    fun compare(expected: DoubleArray, actual: DoubleArray, at: (Int) -> String) {
        assertTrue(
            expected.size == actual.size,
            "$label: expected ${expected.size} values, got ${actual.size}",
        )
        expected.indices.forEach { i -> compare(expected[i], actual[i]) { at(i) } }
    }

    fun compare(expected: DoubleArray, actual: FloatArray, at: (Int) -> String) =
        compare(expected, DoubleArray(actual.size) { actual[it].toDouble() }, at)

    fun assertWithin(tolerance: Double) {
        assertTrue(count > 0, "$label: nothing was compared")
        assertTrue(worst <= tolerance, "$label: worst |Δ| $worst at $where (tolerance $tolerance)")
        println("$label: $count values, worst |Δ| ${"%.3e".format(worst)} (tolerance $tolerance)")
    }
}

/**
 * The same linear congruential generator `make_golden_vectors.py` uses for its
 * probe inputs — glibc's constants, mapped to [-1, 1).
 *
 * Regenerated here rather than carried in the fixture, which is the point of
 * choosing something this trivial: if the two languages disagree about the
 * *input*, the probe would be comparing two different experiments.
 */
fun lcgFloats(count: Int, seed: Long = 20260811L): DoubleArray {
    var state = seed
    return DoubleArray(count) {
        state = (state * 1103515245L + 12345L) and 0x7FFFFFFFL
        state.toDouble() / 0x40000000L - 1.0
    }
}

/** One ONNX Runtime environment for the whole suite; it is process-global. */
val ortEnv: OrtEnvironment = OrtEnvironment.getEnvironment()

/**
 * Model instances shared across the suite.
 *
 * Loading is the slow part — the silence seed alone is a 41-window embedding
 * batch — and none of it is per-test state. Every test that streams audio calls
 * `reset()` first, which is exactly what the client does between turns, so the
 * sharing exercises the reset path rather than working around it.
 */
object Loaded {
    val features: AudioFeatures by lazy { AudioFeatures(ortEnv, Fixture.models) }
    val wake: WakeWordModel by lazy { WakeWordModel(ortEnv, Fixture.models, Fixture.classifiers) }
    val vad: SileroVad by lazy { SileroVad(ortEnv, Fixture.models) }
}
