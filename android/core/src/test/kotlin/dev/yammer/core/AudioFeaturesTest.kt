package dev.yammer.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.math.PI
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The feature pipeline against `fixtures/wakeword/golden.json`.
 *
 * Ordered the way a divergence should be diagnosed: the melspectrogram alone,
 * then the embedding alone, then the two of them streaming with buffers in
 * between. A port that gets the mel right and the embedding wrong fails a
 * different test here from one that gets the buffering wrong, which is the
 * entire reason the fixture carries stage probes as well as end-to-end records.
 */
class AudioFeaturesTest {

    private val features get() = Loaded.features

    @Test
    fun `melspectrogram matches the probe`() {
        val probe = Fixture.probes.obj("melspectrogram")
        val count = probe.int("inputSamples")
        assertEquals(
            AudioFeatures.BLOCK_SAMPLES + AudioFeatures.MELSPEC_LOOKBACK,
            count,
            "the probe is one block plus its lookback",
        )

        // sin(2*pi*1000*t) * 16000, truncated to int16 exactly as numpy's
        // astype does. Grouped as numpy groups it so the doubles agree bit for
        // bit before the model ever sees them.
        val tone = ShortArray(count) {
            val t = it / AudioFeatures.SAMPLE_RATE.toDouble()
            (sin(2.0 * PI * 1000.0 * t) * 16000.0).toInt().toShort()
        }

        val expected = probe.arr("frames").rows()
        val actual = features.melspectrogram(tone)
        assertEquals(expected.size, actual.size, "mel frame count")

        val divergence = Divergence("melspectrogram probe")
        expected.indices.forEach { frame ->
            divergence.compare(expected[frame], actual[frame]) { bin -> "frame $frame bin $bin" }
        }
        divergence.assertWithin(TOLERANCE)
    }

    @Test
    fun `embedding matches the probe`() {
        val probe = Fixture.probes.obj("embedding")
        val raw = lcgFloats(AudioFeatures.MEL_WINDOW_FRAMES * AudioFeatures.MEL_BINS)
        val window = Array(AudioFeatures.MEL_WINDOW_FRAMES) { frame ->
            FloatArray(AudioFeatures.MEL_BINS) { bin ->
                (raw[frame * AudioFeatures.MEL_BINS + bin] * 4.0).toFloat()
            }
        }

        val actual = features.embed(arrayOf(window))
        assertEquals(1, actual.size)
        assertEquals(AudioFeatures.EMBEDDING_DIMS, actual[0].size)

        val divergence = Divergence("embedding probe")
        divergence.compare(probe.doubles("output"), actual[0]) { "dim $it" }
        divergence.assertWithin(TOLERANCE)
    }

    @Test
    fun `the silence seed produces the fixture's frame count`() {
        // If this is wrong, everything downstream is wrong from block 0 and
        // recovers on its own around block 16 — the worst possible failure to
        // debug from a score alone.
        assertEquals(Fixture.golden.int("seedFeatureFrames"), features.seedFrames)
        assertEquals("silence", Fixture.config.str("featureSeed"))
        assertEquals(AudioFeatures.SEED_SAMPLES, Fixture.config.int("featureSeedSamples"))
    }

    @Test
    fun `shape constants agree with the fixture`() {
        val shapes = Fixture.golden.obj("shapes")
        assertEquals(AudioFeatures.MEL_WINDOW_FRAMES, shapes.int("melWindowFrames"))
        assertEquals(AudioFeatures.MEL_BINS, shapes.int("melBins"))
        assertEquals(AudioFeatures.MEL_BUFFER_MAX_FRAMES, shapes.int("melBufferMaxFrames"))
        assertEquals(AudioFeatures.EMBEDDING_DIMS, shapes.int("embeddingDims"))
        assertEquals(AudioFeatures.FEATURE_BUFFER_MAX_FRAMES, shapes.int("featureBufferMaxFrames"))
        assertEquals(AudioFeatures.CLASSIFIER_FRAMES, shapes.int("classifierFrames"))
        assertEquals(SileroVad.FRAME_SAMPLES, shapes.int("vadFrameSamples"))
        assertEquals(AudioFeatures.BLOCK_SAMPLES, Fixture.golden.obj("input").int("blockSamples"))
    }

    @Test
    fun `streaming reproduces every block's embedding and buffer depths`() {
        features.reset()

        val slabs = Fixture.golden.obj("melSlabs")
        val embeddings = Divergence("streamed embeddings")
        val mels = Divergence("streamed mel frames")

        Fixture.audioBlocks.forEachIndexed { index, block ->
            val expected = Fixture.blocks[index].jsonObject
            val melFrames = features.process(block)

            assertEquals(expected.int("melFrameCount"), melFrames.size, "block $index mel frames")
            assertEquals(
                expected.int("melBufferFrames"),
                features.melBufferFrames,
                "block $index mel buffer depth",
            )
            assertEquals(
                expected.int("featureBufferFrames"),
                features.featureBufferFrames,
                "block $index feature buffer depth",
            )

            // The trailing 96 values of the classifier input are the embedding
            // this block produced, so comparing them checks the flattening and
            // the frame ordering at the same time.
            val window = features.features()
            val newest = window.copyOfRange(
                window.size - AudioFeatures.EMBEDDING_DIMS,
                window.size,
            )
            embeddings.compare(expected.doubles("embedding"), newest) { "block $index dim $it" }

            slabs[index.toString()]?.jsonArray?.rows()?.let { expectedMel ->
                expectedMel.indices.forEach { frame ->
                    mels.compare(expectedMel[frame], melFrames[frame]) { "block $index frame $frame bin $it" }
                }
            }
        }

        embeddings.assertWithin(TOLERANCE)
        mels.assertWithin(TOLERANCE)
    }

    @Test
    fun `the first block is short and the buffers grow from the seed`() {
        // Documented edge cases, asserted here so they can't be "fixed" into
        // uniformity: there is no lookback audio yet on block 0, and the mel
        // buffer starts pre-filled with 76 frames rather than empty.
        val first = Fixture.blocks[0].jsonObject
        assertEquals(5, first.int("melFrameCount"))
        assertEquals(AudioFeatures.MEL_WINDOW_FRAMES + 5, first.int("melBufferFrames"))
        assertEquals(Fixture.golden.int("seedFeatureFrames") + 1, first.int("featureBufferFrames"))

        val second = Fixture.blocks[1].jsonObject
        assertEquals(8, second.int("melFrameCount"))
    }

    private companion object {
        /**
         * Decimal rounding to six places is an absolute error of at most 5e-7,
         * whatever the magnitude, and that is the *only* slack these tests
         * allow: both sides run the same ONNX Runtime build against the same
         * weights, so there is no per-platform tolerance to leave room for.
         *
         * The observed worst case across every comparison here is 4.999e-07 —
         * the rounding step itself. The two implementations agree as exactly as
         * the fixture is capable of recording.
         */
        const val TOLERANCE = 1e-6
    }
}
