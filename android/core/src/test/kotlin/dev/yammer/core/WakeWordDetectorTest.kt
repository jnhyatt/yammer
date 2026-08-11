package dev.yammer.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * The detector's arbitration, against scripted scores.
 *
 * Everything here is about which of two wake words wins, which real audio
 * cannot be made to demonstrate on demand — a block where both words are over
 * threshold is exactly the case you cannot record deliberately.
 */
class WakeWordDetectorTest {

    private class ScriptedScorer(private var scores: Map<String, Float>) : WakeWordScorer {
        var resets = 0
            private set

        fun give(vararg pairs: Pair<String, Float>) {
            scores = pairs.toMap()
        }

        override fun predict(
            block: ShortArray,
            thresholds: Map<String, Double>,
            refractorySeconds: Double,
        ): Map<String, Float> = scores

        override fun reset() {
            resets++
        }
    }

    private val config = WakeWordConfig()
    private val block = ShortArray(AudioFeatures.BLOCK_SAMPLES)

    private fun detector(scorer: WakeWordScorer) = WakeWordDetector(config, scorer)

    @Test
    fun `a start crossing fires start`() {
        val scorer = ScriptedScorer(mapOf("hey_jarvis" to 0.7f, "alexa" to 0.1f))
        assertEquals(Detection(Wake.START, 0.7f), detector(scorer).process(block))
    }

    @Test
    fun `a stop crossing fires stop`() {
        val scorer = ScriptedScorer(mapOf("hey_jarvis" to 0.1f, "alexa" to 0.7f))
        assertEquals(Detection(Wake.STOP, 0.7f), detector(scorer).process(block))
    }

    @Test
    fun `nothing below threshold fires`() {
        val scorer = ScriptedScorer(mapOf("hey_jarvis" to 0.49f, "alexa" to 0.49f))
        assertNull(detector(scorer).process(block))
    }

    @Test
    fun `the threshold is inclusive`() {
        val scorer = ScriptedScorer(mapOf("hey_jarvis" to 0.5f, "alexa" to 0.0f))
        assertEquals(Detection(Wake.START, 0.5f), detector(scorer).process(block))
    }

    @Test
    fun `when both cross, the stronger one wins`() {
        val scorer = ScriptedScorer(mapOf("hey_jarvis" to 0.6f, "alexa" to 0.9f))
        val subject = detector(scorer)
        assertEquals(
            Detection(Wake.STOP, 0.9f),
            subject.process(block),
            "start must not win by being checked first",
        )

        scorer.give("hey_jarvis" to 0.9f, "alexa" to 0.6f)
        assertEquals(Detection(Wake.START, 0.9f), subject.process(block))
    }

    @Test
    fun `a missing model scores zero rather than throwing`() {
        // The scorer's key set comes from the models it loaded; a mismatch is a
        // configuration error, not something to crash the capture loop over.
        val scorer = ScriptedScorer(mapOf("alexa" to 0.9f))
        assertEquals(Detection(Wake.STOP, 0.9f), detector(scorer).process(block))
    }

    @Test
    fun `two wake words that resolve to the same key are refused`() {
        val scorer = ScriptedScorer(emptyMap())
        val error = assertFailsWith<WakeWordError> {
            WakeWordDetector(
                WakeWordConfig(startModel = "hey_jarvis", stopModel = "/models/hey_jarvis.onnx"),
                scorer,
            )
        }
        assertEquals(true, error.message!!.contains("hey_jarvis"))
    }

    @Test
    fun `reset reaches the scorer`() {
        val scorer = ScriptedScorer(emptyMap())
        detector(scorer).reset()
        assertEquals(1, scorer.resets)
    }

    @Test
    fun `model identifiers resolve the way openWakeWord keys them`() {
        assertEquals("hey_jarvis", WakeWordDetector.modelKey("hey_jarvis"))
        assertEquals("hey_yammer", WakeWordDetector.modelKey("hey_yammer.onnx"))
        assertEquals("hey_yammer", WakeWordDetector.modelKey("/sdcard/models/hey_yammer.onnx"))
        assertEquals("hey_yammer", WakeWordDetector.modelKey("hey_yammer.tflite"))

        assertEquals("hey_jarvis_v0.1.onnx", WakeWordDetector.modelFile("hey_jarvis"))
        assertEquals("hey_yammer.onnx", WakeWordDetector.modelFile("hey_yammer.onnx"))
    }

    @Test
    fun `the real models report no detection on the fixture's signal`() {
        // The generator says the same thing from the Python side: peak raw score
        // 0.0119, no crossings. Detection *behaviour* needs a real recording and
        // is a Phase 5 question; what this pins is that nothing fires spuriously.
        val model = Loaded.wake
        model.reset()
        val detector = WakeWordDetector(
            WakeWordConfig(
                startModel = Fixture.startModel,
                stopModel = Fixture.stopModel,
                refractorySeconds = Fixture.refractorySeconds,
            ),
            model,
        )
        val fired = Fixture.audioBlocks.mapIndexedNotNull { index, block ->
            detector.process(block)?.let { index to it }
        }
        assertEquals(emptyList(), fired)
    }
}
