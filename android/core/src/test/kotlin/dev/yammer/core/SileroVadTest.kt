package dev.yammer.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Silero VAD against the fixture.
 *
 * The per-frame slabs matter as much as the per-block means: a port that framed
 * the block wrongly and a port that failed to carry the LSTM state between
 * frames can produce similar-looking means, and only the slabs separate them.
 */
class SileroVadTest {

    private val vad get() = Loaded.vad

    @Test
    fun `every block's mean probability matches`() {
        vad.reset()
        val divergence = Divergence("vad block means")
        Fixture.audioBlocks.forEachIndexed { index, block ->
            divergence.compare(
                Fixture.blocks[index].jsonObject.dbl("vad"),
                vad.predict(block),
            ) { "block $index" }
        }
        divergence.assertWithin(TOLERANCE)
    }

    @Test
    fun `per-frame probabilities match on the sampled blocks`() {
        vad.reset()
        val slabs = Fixture.golden.obj("vadSlabs")
        val divergence = Divergence("vad frames")

        Fixture.audioBlocks.forEachIndexed { index, block ->
            val frames = vad.frames(block)
            assertEquals(
                AudioFeatures.BLOCK_SAMPLES / SileroVad.FRAME_SAMPLES,
                frames.size,
                "block $index frame count",
            )
            slabs[index.toString()]?.jsonArray?.doubles()?.let { expected ->
                divergence.compare(expected, frames) { "block $index frame $it" }
            }
        }
        divergence.assertWithin(TOLERANCE)
    }

    @Test
    fun `reset returns the model to its initial state`() {
        // The state carry is what makes this necessary: without a reset, the
        // answer window would open with an LSTM that still remembers the
        // agent's own speech.
        vad.reset()
        val first = vad.predict(Fixture.audioBlocks[0])
        repeat(5) { vad.predict(Fixture.audioBlocks[it + 1]) }
        vad.reset()
        assertEquals(first, vad.predict(Fixture.audioBlocks[0]))
    }

    @Test
    fun `a block that is not a whole number of frames is refused`() {
        val error = kotlin.runCatching { vad.frames(ShortArray(500)) }.exceptionOrNull()
        assertEquals(IllegalArgumentException::class, error!!::class)
    }

    private companion object {
        const val TOLERANCE = 1e-6
    }
}
