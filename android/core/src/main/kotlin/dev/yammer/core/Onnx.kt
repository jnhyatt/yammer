package dev.yammer.core

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File

/**
 * Where the `.onnx` files come from.
 *
 * Deliberately not a path. On the phone the models are APK assets and have no
 * filesystem path at all; on the desktop, where these tests run, they are files
 * under `android/models/`. Both sides hand ONNX Runtime a byte array, which is
 * the one loading route available to both — reaching for
 * `createSession(String)` is the mistake that compiles fine and then fails only
 * on device.
 */
fun interface ModelSource {
    /** Returns the bytes of [name], e.g. `"melspectrogram.onnx"`. */
    fun read(name: String): ByteArray

    companion object {
        fun directory(dir: File): ModelSource = ModelSource { name ->
            val file = File(dir, name)
            require(file.isFile) { "model not found: $file" }
            file.readBytes()
        }
    }
}

/**
 * Single-threaded, so a wake-word pass cannot fan out across cores.
 *
 * The pipeline is ~4% of one core per block; ONNX Runtime's default thread pool
 * would spend more on coordination than it saves, and on a phone it competes
 * with the audio callback for exactly the wrong cores.
 */
internal fun singleThreadedOptions(): OrtSession.SessionOptions =
    OrtSession.SessionOptions().apply {
        setInterOpNumThreads(1)
        setIntraOpNumThreads(1)
    }

internal fun OrtEnvironment.loadSession(models: ModelSource, name: String): OrtSession =
    createSession(models.read(name), singleThreadedOptions())

/** A float tensor read back as a flat array plus its shape. */
internal class FlatTensor(val data: FloatArray, val shape: LongArray)

/**
 * Reads output [index] as a flat float array.
 *
 * Flat rather than nested on purpose: every output here is reshaped or squeezed
 * immediately afterwards, and `Array<Array<Array<FloatArray>>>` casts express
 * that badly and break whenever a model's rank changes.
 */
internal fun OrtSession.Result.flat(index: Int): FlatTensor {
    val tensor = get(index) as OnnxTensor
    val buffer = tensor.floatBuffer
    val data = FloatArray(buffer.remaining())
    buffer.get(data)
    return FlatTensor(data, tensor.info.shape)
}
