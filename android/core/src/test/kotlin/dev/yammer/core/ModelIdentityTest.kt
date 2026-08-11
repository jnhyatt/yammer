package dev.yammer.core

import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * That the models under test are the models the fixture was generated against.
 *
 * Every number in `golden.json` is a function of these five files. Check in a
 * differently-versioned `hey_jarvis`, or regenerate the fixture against one, and
 * the whole suite fails as numeric noise with nothing pointing at the cause —
 * so the digests are recorded on the Python side and verified here.
 */
class ModelIdentityTest {

    @Test
    fun `every model matches the digest the fixture recorded`() {
        val recorded = Fixture.golden.obj("models")
        assertEquals(5, recorded.size, "the pipeline is five models")

        recorded.forEach { (role, entry) ->
            val file = File(Fixture.modelsDir, entry.jsonObject.str("file"))
            assertEquals(
                entry.jsonObject.str("sha256"),
                Fixture.sha256(file),
                "$role (${file.name}) is not the model the fixture was generated against",
            )
        }
    }

    @Test
    fun `the audio matches the digest the fixture recorded`() {
        assertEquals(
            Fixture.golden.obj("input").str("sha256"),
            Fixture.sha256(File(Fixture.fixturesDir, "wakeword/input.wav")),
        )
    }

    @Test
    fun `the models the pipeline loads are the ones on disk`() {
        assertEquals(
            Fixture.golden.obj("models").obj("melspectrogram").str("file"),
            AudioFeatures.MELSPEC_MODEL,
        )
        assertEquals(
            Fixture.golden.obj("models").obj("embedding").str("file"),
            AudioFeatures.EMBEDDING_MODEL,
        )
        assertEquals(Fixture.golden.obj("models").obj("vad").str("file"), SileroVad.VAD_MODEL)
        Fixture.classifiers.forEach { (name, file) ->
            assertEquals(file, WakeWordDetector.modelFile(name), "$name resolves to the wrong asset")
        }
    }
}
