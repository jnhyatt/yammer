package dev.yammer.core

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The answer-window state machine, driven from scripted probabilities.
 *
 * Real audio cannot produce a 0.49 followed by a 0.51 on demand, and onset and
 * offset are both defined in blocks, so the interesting cases are all timing
 * ones. The real model gets a single integration check at the bottom.
 */
class SpeechGateTest {

    /** Returns a fixed probability per call, in order. */
    private class ScriptedVad(private val script: List<Double>) : VoiceScorer {
        private var at = 0
        var resets = 0
            private set

        override fun predict(block: ShortArray): Double = script[at++]

        override fun reset() {
            resets++
        }
    }

    private fun block(marker: Int) = ShortArray(AudioFeatures.BLOCK_SAMPLES) { marker.toShort() }

    private fun run(script: List<Double>, config: VadConfig = VadConfig()): Pair<SpeechGate, List<Speech>> {
        val gate = SpeechGate(config, ScriptedVad(script))
        val events = script.indices.map { gate.process(block(it)) }
        return gate to events
    }

    @Test
    fun `onset needs consecutive voiced blocks`() {
        val (_, events) = run(listOf(0.9, 0.1, 0.9, 0.9, 0.1))
        assertEquals(
            listOf(Speech.NONE, Speech.NONE, Speech.NONE, Speech.START, Speech.NONE),
            events,
            "a single voiced block, then a gap, must not open the window",
        )
    }

    @Test
    fun `the threshold is inclusive`() {
        val (_, events) = run(listOf(0.5, 0.5))
        assertEquals(Speech.START, events[1])
    }

    @Test
    fun `the window closes only after the full silence run`() {
        // 0.8 s of silence at 80 ms a block is ten blocks; the ninth must not
        // close it.
        val script = listOf(0.9, 0.9) + List(10) { 0.0 }
        val (gate, events) = run(script)

        assertEquals(Speech.START, events[1])
        assertTrue(events.subList(2, 11).all { it == Speech.NONE }, "closed early: $events")
        assertEquals(Speech.END, events[11])
        assertFalse(gate.speaking)
    }

    @Test
    fun `a pause inside speech does not close the window`() {
        val script = listOf(0.9, 0.9) + List(9) { 0.0 } + listOf(0.9) + List(9) { 0.0 }
        val (gate, events) = run(script)
        assertTrue(events.drop(2).all { it == Speech.NONE }, "closed during a pause: $events")
        assertTrue(gate.speaking)
    }

    @Test
    fun `preroll keeps the blocks leading up to onset, including the trigger`() {
        // Without the trigger block a one-word answer loses its first syllable,
        // which is the whole reason this buffer exists.
        val script = List(8) { 0.0 } + listOf(0.9, 0.9)
        val (gate, _) = run(script)

        val preroll = gate.preroll()
        assertEquals(5 * AudioFeatures.BLOCK_SAMPLES, preroll.size, "0.4 s of preroll at 80 ms a block")

        // Blocks are marked with their index, so the contents say which ones
        // were kept: the five most recent, ending with the one that opened the
        // window.
        val markers = (0 until 5).map { preroll[it * AudioFeatures.BLOCK_SAMPLES].toInt() }
        assertContentEquals(listOf(5, 6, 7, 8, 9), markers)
    }

    @Test
    fun `preroll stops growing once the window is open`() {
        val script = listOf(0.9, 0.9, 0.9, 0.9)
        val (gate, _) = run(script)
        assertEquals(2 * AudioFeatures.BLOCK_SAMPLES, gate.preroll().size)
    }

    @Test
    fun `reset clears the gate and the model underneath it`() {
        val vad = ScriptedVad(listOf(0.9, 0.9, 0.9))
        val gate = SpeechGate(VadConfig(), vad)
        gate.process(block(0))
        gate.process(block(1))
        assertTrue(gate.speaking)

        gate.reset()

        assertFalse(gate.speaking)
        assertEquals(0, gate.preroll().size)
        assertEquals(1, vad.resets, "the VAD's LSTM state has to be cleared too")
        assertEquals(Speech.NONE, gate.process(block(2)), "onset must start over after a reset")
    }

    @Test
    fun `the real VAD does not open the window on the fixture's signal`() {
        // The synthetic signal is spectrally busy but is not speech, and Silero
        // says so — nothing in it reaches 0.5. A port that inverted the
        // probability or dropped the state would light this up.
        val gate = SpeechGate(VadConfig(), Loaded.vad)
        gate.reset()
        val opened = Fixture.audioBlocks.withIndex().filter { (_, block) ->
            gate.process(block) == Speech.START
        }
        assertTrue(opened.isEmpty(), "speech onset on non-speech at blocks ${opened.map { it.index }}")
    }
}
