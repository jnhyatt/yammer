# yammer-android

The second client. Same job as [`client/`](../client): wake-word detection,
capture, earcons, playback — no STT, no TTS, no LLM calls, all of which stay on
the server.

**Status: Phase 2.** The feature pipeline and the earcons exist and are pinned to
golden vectors, and there is an APK that plays the earcons and records a WAV —
but nothing speaks the protocol yet, so it is a diagnostic tool rather than a
client. `Protocol` and the state machine arrive in Phases 3–4. See
[`android-client-plan.md`](../android-client-plan.md).

## Requirements

- **JDK 17 or newer.** The build targets 17.
- Nothing else for `:core` — the tests run on the desktop JVM against
  `com.microsoft.onnxruntime:onnxruntime`. No emulator, no device, no Android
  SDK.
- For `:app`: **Android SDK 36** with build-tools 36.x, and `ANDROID_HOME` set to
  a real path. A literal `~` in that variable does not get expanded by the
  toolchain and fails in a way that does not mention the tilde.
- **minSdk 33**, arm64 only.

The hardware requirements are a scope decision rather than a limitation to be
worked around, and are documented in
[`voice-opencode-requirements.md` §9](../voice-opencode-requirements.md):
**LE Audio bidirectional earbuds and Android 13+**. Classic Bluetooth is
explicitly unsupported — HFP/SCO caps the microphone at 8 or 16 kHz, and that
bandwidth is not recoverable downstream of the codec. Headphones of some kind
remain a hard dependency, as on the desktop.

## Layout

```
android/
  core/          everything that is pure Kotlin — no Android dependencies
  models/        the five .onnx files, 6.1 MB, shared with the app's assets
  app/           the Android application
  tools/         desktop scripts for things the phone cannot judge about itself
```

`core` is a plain Kotlin/JVM module, not part of the app, for two reasons. The
pipeline has no Android dependencies, so its tests belong on the desktop JVM
where they run in seconds. And ONNX Runtime ships as two artifacts with the same
`ai.onnxruntime` API — the AAR for the device, the jar for the desktop — which
must not meet on one classpath: the AAR carries no desktop native library, and
whichever copy wins the classpath ordering decides whether the tests run or fail
with an `UnsatisfiedLinkError` that looks nothing like its cause. Keeping the
runtime `compileOnly` in `core` and letting each consumer supply its own is what
makes that a non-question.

The rule that follows from it: **anything that is only arithmetic goes in
`core`.** That is why the earcons are there and not in the app — synthesizing a
sine needs no Android, and in `core` the five are checked against a fixture
rather than judged by ear.

| File | Ported from |
|---|---|
| `core/AudioFeatures.kt` | `openwakeword/utils.py` — melspectrogram, embedding, buffers |
| `core/WakeWordModel.kt` | `openwakeword/model.py` — classifiers, warmup, debounce |
| `core/SileroVad.kt` | `openwakeword/vad.py` |
| `core/WakeWordDetector.kt` | `client/src/yammer_client/wakeword.py` |
| `core/SpeechGate.kt` | `client/src/yammer_client/vad.py` |
| `core/Earcons.kt` | `client/src/yammer_client/earcons.py` |
| `core/Onnx.kt` | new — model loading and tensor plumbing |
| `core/Wav.kt` | new — RIFF read/write, for getting captures off the phone |
| `app/AudioIo.kt` | `client/src/yammer_client/audio.py` |
| `app/AudioCheckActivity.kt` | new — the audio harness |

The right-hand column is load-bearing: a change to the Python client's detection
behaviour has an obvious counterpart here.

## Build and test

```sh
cd android
./gradlew :core:test                 # 53 JVM tests, no SDK or device needed
./gradlew :app:assembleDebug         # 9.4 MB APK
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The tests need no arguments and no network. They read the models from
`android/models/` and the golden vectors from `../fixtures/`, both passed in as
system properties by `core/build.gradle.kts` — running them from an IDE without
those properties fails with a message saying so.

## The audio check

The APK is one screen, `AudioCheckActivity`. It exists because two things about
Phase 2 cannot be settled from a desktop, and it stays because they are worth
re-checking whenever the hardware changes.

**Are the earcons distinguishable in the ear?** Play each of the five, at any of
the three rates the fixture covers, through the buds you actually use. Their
arithmetic is already proven; this is the part a fixture cannot do.

**What is the OS actually giving us?** Record 10 s and the screen reports the
routed device by name — `BLE_HEADSET (LE Audio — the supported path)` is the
answer you want, `BLUETOOTH_SCO (classic telephony — band-limited)` is the one
that means the scope assumption did not hold, and `BUILTIN_MIC` means the buds
are output-only. It also prints peak, RMS, DC offset and clipping, which catch
the failures a spectrum would not.

The capture source is selectable across all four, because the effect of that
choice cannot be predicted from the API — it depends on the phone's audio HAL —
and because there is a genuine tension in it that only measurement settles:

| Source | Why you would pick it |
|---|---|
| `VOICE_COMMUNICATION` | **the default.** [§9](../voice-opencode-requirements.md) requires a communication use case: an LE Audio link in a media context runs unidirectional, so the buds' mics do not stream and capture silently falls back to the phone. Brings AEC and NS along whether you want them or not |
| `VOICE_RECOGNITION` | what a wake word wants — usually leaves AGC and NS out of the path. The one to compare against the default |
| `MIC` | whatever the device does by default |
| `UNPROCESSED` | no processing where the device supports it; the honest baseline |

**The comparison worth running first** is `VOICE_COMMUNICATION` against
`VOICE_RECOGNITION`, watching the routed device. If `VOICE_RECOGNITION` keeps
`BLE_HEADSET`, it is the better source and §9's claim needs revisiting. If it
drops to `BUILTIN_MIC`, §9 was right and the AEC comes with the territory.

**The bandwidth verdict is not made on the phone**, on purpose. An 8 kHz-limited
stream resampled to 16 kHz sounds perfectly fine and has already lost what no
amount of downstream work recovers, so it takes a spectrum:

```sh
adb pull /sdcard/Android/data/dev.yammer.android/files/capture-….wav
../client/.venv/bin/python tools/check_capture.py capture-….wav
```

It prints a band table and returns `FULL BANDWIDTH` or `BAND-LIMITED`, naming the
cliff frequency. Both verdicts are checked against known inputs — it passes
`fixtures/wakeword/input.wav` and fails a deliberately band-limited copy of it at
3406 Hz. `--plot` writes the spectrum as a PNG if matplotlib is around.

## The models

`models/` holds the five ONNX files openWakeWord downloads on the desktop:

| File | Role |
|---|---|
| `melspectrogram.onnx` | audio → mel frames |
| `embedding_model.onnx` | Google `speech_embedding`, 76 mel frames → 96 dims |
| `hey_jarvis_v0.1.onnx` | start wake word |
| `alexa_v0.1.onnx` | stop wake word |
| `silero_vad.onnx` | v4, for the permission answer window only |

They are checked in rather than downloaded because a phone has nowhere to
download them *to* at first run, and because the fixture pins their digests —
`fixtures/wakeword/golden.json` records the SHA-256 of each, and
`ModelIdentityTest` fails if the files here are not those exact weights. The app
module will pick this directory up as an extra asset source rather than keeping a
second copy.

`hey_jarvis` and `alexa` are v1 placeholders, exactly as on the desktop. Custom
`hey yammer` / `yammer stop` models are a drop-in swap.

## What the tests actually check

`:core:test` is 53 tests, and the ones that matter reproduce
[the golden vectors](../fixtures/README.md) — `wakeword/golden.json`, generated by
the Python client and cross-checked against the real `openwakeword.Model` before
it was written, and `earcons/golden.json`, generated from the Python client's own
`earcons.py`.

This exists because the pipeline is the one part of the port whose bugs are
**silent**. A wrong buffer offset or a dropped transform yields plausible scores
that simply never cross threshold; nothing throws and nothing logs, and the only
symptom is a wake word that doesn't work. So each stage is checked separately —
melspectrogram, then embedding, then classifier, then the gating state machine,
then all of them streaming — and a divergence localizes itself instead of
presenting as "the score is wrong".

Both sides run the same ONNX Runtime version against the same weights, so the
tolerance is 1e-6: the fixture's own six-decimal rounding and nothing more. The
observed worst case is 4.999e-07, which is that rounding step.

The earcons are the same argument in a different key — they are the only status
channel, and a drifted port still plays five plausible beeps. They come out
**byte-identical** to Python's, all 75,697 samples across five earcons and three
rates. The comparison allows ±1 LSB, because both sides truncate toward zero into
int16 and a value within a float ulp of an integer boundary may land either side;
that headroom goes unused. Getting there needed the float32 narrowing points to
match and not just the formulas — `2π·freq` is narrowed before it multiplies the
sample times, and the `error` sweep accumulates its phase as a running float32
sum, which is *less* accurate than a double would be and is what numpy does.

Two details the fixture pins that are easy to get wrong and give no other signal:

- **The feature buffer is seeded with four seconds of silence.** openWakeWord
  seeds it with four seconds of *random* audio, which makes its first ~16 blocks
  unreproducible. Silence is a deliberate deviation, and both sides do it.
- **The classifiers disagree about what their input is called** — `x.1` for
  `hey_jarvis`, `onnx::Flatten_0` for `alexa`, both just whatever the exporter
  emitted. `WakeWordModel` reads `session.inputNames.first()`; hardcoding either
  works for exactly one model.

One deliberate deviation from the library, in `AudioFeatures`: `reset()` restores
a cached silence seed instead of recomputing it. openWakeWord's `Model.reset()`
re-embeds four seconds of fresh random audio every call — one melspectrogram over
64000 samples plus a 41-window embedding batch — which is far too expensive to do
at the end of every turn on a phone. The seed is constant, so caching it is
free, and the fixture proves the result is identical.
