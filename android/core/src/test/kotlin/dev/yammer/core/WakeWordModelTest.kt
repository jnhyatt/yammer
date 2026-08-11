package dev.yammer.core

import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The classifiers and the gating state machine.
 *
 * The streamed scores below all sit near zero — the fixture's signal is not a
 * wake word — so on their own they would be satisfied by a classifier that
 * always returned 0.0. The probe and the scripted gating trace are what close
 * that hole: the probe lands both models above their thresholds, and the trace
 * walks warmup, a crossing, refractory suppression and re-arming, none of which
 * the audio exercises at all.
 */
class WakeWordModelTest {

    private val model get() = Loaded.wake

    @Test
    fun `both classifiers match the probe`() {
        val probe = Fixture.probes.obj("classifier")
        val raw = lcgFloats(AudioFeatures.CLASSIFIER_FRAMES * AudioFeatures.EMBEDDING_DIMS)
        val divergence = Divergence("classifier probe")

        for ((scale, expected) in probe.obj("scores")) {
            val features = FloatArray(raw.size) { (raw[it] * scale.toDouble()).toFloat() }
            val actual = model.score(features)
            for ((name, value) in expected.jsonObject) {
                divergence.compare(
                    value.jsonPrimitive.double,
                    actual.getValue(name).toDouble(),
                ) { "scale $scale, $name" }
            }
        }
        divergence.assertWithin(SCORE_TOLERANCE)
    }

    @Test
    fun `the probe at scale 8 crosses both thresholds`() {
        // Otherwise the whole suite could pass without a detection ever
        // happening, which is the failure mode this fixture exists to prevent.
        val scores = Fixture.probes.obj("classifier").obj("scores").obj("8.0")
        Fixture.thresholds.forEach { (name, threshold) ->
            assertTrue(
                scores.dbl(name) >= threshold,
                "probe score for $name is ${scores.dbl(name)}, below its $threshold threshold",
            )
        }
    }

    @Test
    fun `gating reproduces the scripted trace`() {
        val trace = Fixture.probes.obj("gating")
        val name = trace.str("model")
        val threshold = trace.dbl("threshold")
        val debounce = trace.int("debounceFrames")

        model.reset()
        val gated = trace.doubles("rawScores").map { raw ->
            model.gate(mapOf(name to raw.toFloat()), mapOf(name to threshold), debounce)
                .getValue(name)
        }

        // Exactly equal, not within a tolerance: gating does no arithmetic. It
        // either passes the score through untouched or substitutes zero, so
        // anything in between means the wrong branch was taken.
        assertEquals(
            trace.doubles("gatedScores").map { it.toFloat() },
            gated,
            "gated score sequence",
        )
    }

    @Test
    fun `the debounce window is derived, not stored`() {
        assertEquals(
            Fixture.config.int("debounceFrames"),
            WakeWordModel.debounceFrames(Fixture.refractorySeconds),
        )
        assertEquals(Fixture.config.int("warmupFrames"), WakeWordModel.WARMUP_FRAMES)
    }

    @Test
    fun `streaming reproduces every block's raw and gated scores`() {
        model.reset()

        val rawDivergence = Divergence("streamed raw scores")
        val gatedDivergence = Divergence("streamed gated scores")

        Fixture.audioBlocks.forEachIndexed { index, block ->
            val expected = Fixture.blocks[index].jsonObject
            val prediction = model.process(block, Fixture.thresholds, Fixture.refractorySeconds)

            expected.obj("rawScores").forEach { (name, value) ->
                rawDivergence.compare(
                    value.jsonPrimitive.double,
                    prediction.raw.getValue(name).toDouble(),
                ) { "block $index $name" }
            }
            expected.obj("gatedScores").forEach { (name, value) ->
                gatedDivergence.compare(
                    value.jsonPrimitive.double,
                    prediction.gated.getValue(name).toDouble(),
                ) { "block $index $name" }
            }
        }

        rawDivergence.assertWithin(SCORE_TOLERANCE)
        gatedDivergence.assertWithin(SCORE_TOLERANCE)
    }

    @Test
    fun `warmup zeroes the first five scored frames`() {
        model.reset()
        val firstFive = Fixture.audioBlocks.take(WakeWordModel.WARMUP_FRAMES).map { block ->
            model.process(block, Fixture.thresholds, Fixture.refractorySeconds)
        }
        firstFive.forEachIndexed { index, prediction ->
            prediction.gated.forEach { (name, value) ->
                assertEquals(0.0f, value, "block $index $name should be zeroed by warmup")
            }
        }
        // ... and the raw score underneath is not zero, so this is really
        // warmup rather than a pipeline that produces nothing yet.
        assertTrue(
            firstFive.any { prediction -> prediction.raw.values.any { it != 0.0f } },
            "raw scores during warmup were all zero, so the test proves nothing",
        )
    }

    @Test
    fun `reset clears the prediction buffer, so warmup applies again`() {
        model.reset()
        repeat(WakeWordModel.WARMUP_FRAMES + 3) { index ->
            model.process(Fixture.audioBlocks[index], Fixture.thresholds, Fixture.refractorySeconds)
        }
        model.reset()
        val after = model.process(
            Fixture.audioBlocks[0],
            Fixture.thresholds,
            Fixture.refractorySeconds,
        )
        after.gated.forEach { (name, value) ->
            assertEquals(0.0f, value, "$name should be zeroed by warmup after a reset")
        }
    }

    @Test
    fun `the fixture's models are the ones being loaded`() {
        assertEquals(setOf(Fixture.startModel, Fixture.stopModel), model.names)
    }

    private companion object {
        /** Scores are in [0, 1] and the fixture rounds them to six decimals. */
        const val SCORE_TOLERANCE = 1e-6
    }
}
