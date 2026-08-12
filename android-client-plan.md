# Yammer — Android Client Implementation Plan

> **Status: Phases 0, 1 and 2 complete.** The feature pipeline and the earcons
> exist in Kotlin and reproduce their golden vectors; there is an APK that plays
> the earcons and records a WAV, but no client yet — nothing speaks the protocol.
> Written 2026-08-11 after a feasibility dig through `client/` and openWakeWord's
> internals; Phases 0 and 1 executed the same day, Phase 2 on 2026-08-12.
> Supersedes the "Mobile client" entry on the requirements doc's non-goals list,
> now amended as §9 — see [Doc changes](#doc-changes-required).
>
> **Phase 2's done-when is half machine-checkable and half not.** The earcon
> arithmetic is pinned to a fixture and agrees with Python *exactly*; whether the
> five are audible and distinguishable through the target earbuds is a judgement
> that needs the earbuds. The APK exists to make that judgement, and to answer
> the capture-bandwidth question with a measurement rather than an opinion.

## Verdict

Feasible, and the ML is the easy part. The full wake-word pipeline
(melspectrogram → embedding → two classifiers) measures **3.68 ms per 80 ms
block on a 2015 Skylake laptop core** — 4.6% of one core, single-threaded, and a
phone's big core beats that. Silero VAD adds 0.96 ms (1.2%). All five models are
plain ONNX totalling 6.2 MB and run on `onnxruntime-android` unmodified: no
conversion, no quantization, no NNAPI or GPU delegate.

The real work was a **faithful Kotlin port of openWakeWord's streaming feature
pipeline** — roughly 400 lines of fiddly but fully deterministic buffer
arithmetic. Phase 0 pinned it to golden vectors, with a from-scratch
reimplementation built only from this document's description reproducing the
library **exactly** (`0.0` divergence over 48 blocks). Phase 1 then wrote the
Kotlin against that fixture, and it agrees to **4.999e-07 — the fixture's own
six-decimal rounding step**, which is as exactly as the fixture can measure.

What was the plan's largest unknown is now finished and tested, and it took
about a day rather than the estimated three. The remaining work is ordinary
Android application code.

Total: **~1,600 lines of Kotlin**, ~2–3 weeks of focused part-time work, with an
open-ended tuning tail. Phase 1 came in at 812 lines of pipeline and 909 of
test, which suggests the estimate was about right for the parts that remain.

## Locked scope decisions

These were settled during the feasibility investigation. They are recorded here
because each one removes a large chunk of work, and reversing one puts that work
back.

| Decision | Rationale |
|---|---|
| **LE Audio bidirectional earbuds required** (Android 13+, compatible chipset + buds) | Classic Bluetooth has no high-bandwidth mic path — A2DP is output-only, HFP/SCO caps at 8 kHz CVSD / 16 kHz mSBC. LE Audio is the only classic-BT-free way to get a full-bandwidth earbud mic. Shipped as a documented YMMV requirement, not a compatibility matrix to satisfy. |
| **`minSdk 33`** | Follows from LE Audio. Also drops essentially all compat-library gymnastics. |
| **Default input and output devices; no device pinning** | Keep it dumb until it demonstrably breaks. See the mitigation in [Risks](#risks) — one log line makes the assumption verifiable instead of hoped-for. |
| **Declare the capture use case** via `VOICE_COMMUNICATION` / `MODE_IN_COMMUNICATION` | This is *not* device pinning; it is the smaller alternative to it. A headset mic is a communication route, not a default one — in a media context an LE Audio link runs unidirectional and the buds' mics do not stream at all. Without this, capture silently falls back to the phone's built-in mic. |
| **ONNX Runtime for everything, not LiteRT** | openWakeWord ships `.tflite` for the wake models but `silero_vad` is ONNX-only. One runtime beats two. |
| **Headphones remain a hard dependency** | Unchanged from the desktop client. The AEC that arrives with `VOICE_COMMUNICATION` is a bonus, not a licence to support speakers. |
| **Server unchanged** | The protocol is thin enough that this is purely a second client. No server work is in scope here. |

## Repo layout

New top-level `android/`, sibling to `client/` and `server/`. No rename of the
existing `client/` — it stays the Python desktop client.

```
android/
  README.md                     requirements, build, config, the LE Audio caveat
  settings.gradle.kts
  build.gradle.kts
  gradle/libs.versions.toml
  models/                       the five .onnx files, 6.1 MB   ✅
  core/                         pure Kotlin/JVM — no Android dependencies  ✅
    src/main/kotlin/dev/yammer/core/
      AudioFeatures.kt          ← openwakeword/utils.py  (the real work)
      WakeWordModel.kt          ← openwakeword/model.py
      SileroVad.kt              ← openwakeword/vad.py
      WakeWordDetector.kt       ← client/src/yammer_client/wakeword.py
      SpeechGate.kt             ← client/src/yammer_client/vad.py
      Onnx.kt                   model loading and tensor plumbing
      Earcons.kt                ← client/src/yammer_client/earcons.py   ✅
      Wav.kt                    RIFF read/write, for getting captures off the phone  ✅
    src/test/kotlin/            golden-vector tests — desktop JVM, no emulator
  app/                          ✅ Phase 2
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      res/values/strings.xml
      kotlin/dev/yammer/android/
        AudioIo.kt              ← client/src/yammer_client/audio.py     ✅
        AudioCheckActivity.kt   the audio harness, and a permanent diagnostic  ✅
        MainActivity.kt         (Phase 4) permission request, start/stop, log view
        YammerService.kt        (Phase 4) foreground service, type=microphone
        Config.kt               (Phase 4) ← client/src/yammer_client/config.py
        Protocol.kt             (Phase 3) ← client/src/yammer_client/protocol.py
        YammerClient.kt         (Phase 3) ← client/src/yammer_client/app.py
  tools/
    check_capture.py            spectrum verdict on a pulled WAV  ✅
```

**Amended in Phase 2: `Earcons.kt` moved to `core`**, for Phase 1's reason — it
is pure arithmetic, and in `core` it is checked against a fixture instead of by
ear. `Wav.kt` joined it, unplanned, because the done-when needs a WAV off the
phone. `app` is where Android is, and nothing else.

**Amended in Phase 1: the pipeline is its own Kotlin/JVM module, not part of the
app.** Two reasons, both found by doing it. The pipeline has no Android
dependencies, so a plain JVM module keeps its tests off the Android toolchain
entirely — `./gradlew :core:test` needs no SDK, no emulator and no device, and
runs in about twenty seconds. And ONNX Runtime ships two artifacts with the same
`ai.onnxruntime` API: the AAR for the device and the jar for the desktop. In a
single module both land on the unit-test classpath, where the AAR — which
carries no desktop native library — can win the ordering and fail every test
with an `UnsatisfiedLinkError` that looks nothing like its cause. `compileOnly`
in `core`, with each consumer supplying its own runtime, makes that a
non-question rather than a thing to debug later.

`models/` is likewise one directory rather than a copy under `app/src/main/
assets/`: the app module will add it as an extra asset source. The fixture
records each file's SHA-256, so the tests fail loudly if these are not the exact
weights the golden vectors were generated from.

**The left-hand column is load-bearing.** `protocol/PROTOCOL.md`,
`server/src/protocol.ts`, and `client/.../protocol.py` are already three views of
one contract; `Protocol.kt` makes four. Keep the file-for-file correspondence so
a protocol change has an obvious checklist.

### Dependencies

- `com.microsoft.onnxruntime:onnxruntime-android` — inference. **Phase 4**: it is
  28 MB of arm64 native library, and nothing before then calls it.
- `com.microsoft.onnxruntime:onnxruntime` (JVM, `testImplementation` only) — lets
  the feature-pipeline tests run as plain JVM unit tests against the same models
- `org.jetbrains.kotlinx:kotlinx-coroutines-android` — capture is a `Flow`
- `com.squareup.okhttp3:okhttp` — WebSocket (Phase 3)
- `org.jetbrains.kotlinx:kotlinx-serialization-json` — control frames (Phase 3)
- `androidx.datastore:datastore-preferences` — config (Phase 4)
- ~~Compose for the (deliberately minimal) UI~~ — **not in Phase 2.** The audio
  harness is framework Views: a screen whose whole job is to tell you whether
  audio works should not have a UI framework in it that could be why it doesn't.
  Revisit at Phase 4, where the UI is an actual artifact rather than a diagnostic.

### Permissions

`RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
`POST_NOTIFICATIONS`, `BLUETOOTH_CONNECT`, `INTERNET`. The last is easy to
forget and is required at runtime on API 31+ to enumerate or select
communication devices at all.

## The feature pipeline

This is the only genuinely novel code in the project, so it is specified here
rather than left to be rediscovered from Python. All of it is a port of
`AudioFeatures._streaming_features` and `Model.predict`.

**Model shapes**, confirmed against the checked-in ONNX graphs:

| Model | Input | Output | Size |
|---|---|---|---|
| `melspectrogram.onnx` | `(batch, samples)` f32 | `(time, 1, ?, 32)` | 1.0 MB |
| `embedding_model.onnx` | `(N, 76, 32, 1)` f32 | `(N, 1, 1, 96)` | 1.3 MB |
| `hey_jarvis_v0.1.onnx` | `(1, 16, 96)` f32 | `(1, 1)` | 1.2 MB |
| `alexa_v0.1.onnx` | `(1, 16, 96)` f32 | `(1, 1)` | 0.8 MB |
| `silero_vad.onnx` | `(batch, seq)` f32 + `sr` i64 + `h`,`c` `(2, b, 64)` | out + `hn`,`cn` | 1.8 MB |

**Per 80 ms block (1280 samples), the steps are:**

1. Append raw samples to a rolling buffer. Hold a remainder if the input is not
   an exact multiple of 1280 — only run the rest when `accumulated % 1280 == 0`.
2. Run melspectrogram over the **last `n_samples + 480`** samples (1760 for one
   block; the extra 480 is 3 frames of overlap context). Yields **8 new mel
   frames** per block at a 10 ms hop.
3. Apply the transform **`x / 10 + 2`** to the melspec output. This is not
   cosmetic — it is what aligns the ONNX melspectrogram with Google's native TF
   `speech_embedding` implementation. Getting it wrong produces plausible-looking
   scores that never cross threshold.
4. Append to a mel buffer capped at **970 frames**; seed it with `ones((76, 32))`.
5. Take the trailing **76-frame** window and run the embedding model → one
   **96-dim** vector per block. Append to a feature buffer capped at **120**.
6. Feed the **last 16** embeddings as `(1, 16, 96)` to each classifier. That is
   ~2 s of acoustic context (16 × 80 ms stride + a 760 ms window).
7. **Zero the score for the first 5 frames** after init or reset.
8. Debounce: with `debounce_time = 1.5 s` and 80 ms blocks, `n = ceil(1.5/0.08) =
   19`. If the current score ≥ threshold **and** any of the last 19 were ≥
   threshold, zero it.

**Silero VAD** is much smaller: normalize `int16 / 32767` → f32, feed 320-sample
frames (4 per block), carry `h`/`c` between calls, average the frame scores.
Note the bundled model is **v4** — `frame_size` is configurable and the input
must be an exact multiple of it. The 512-sample framing v5 requires does not
apply; do not "fix" it to match the v5 docs.

## Phases

Each phase has a done-when that can be checked without the next phase existing.

### Phase 0 — De-risk, on the desktop — ✅ **done**

No Android code. Four things, all in the existing repo.

**1. Golden vectors.** [`client/tools/make_golden_vectors.py`](client/tools/make_golden_vectors.py)
→ [`fixtures/wakeword/`](fixtures/wakeword/). It does more than dump tensors: it
**reimplements the streaming pipeline from scratch** against raw ONNX Runtime,
using only the steps written down in this document, and then cross-checks that
reimplementation against the real `openwakeword.Model` block for block, refusing
to write the fixture if they disagree.

> **Worst disagreement: `0.0`, across all 48 blocks and both models.**

That result is the actual de-risking. The algorithm described in [The feature
pipeline](#the-feature-pipeline) above is now *demonstrably* the library's
algorithm, verified on the desktop where a difference could be debugged — rather
than a careful reading that Kotlin gets to discover was wrong. Phase 1 is no
longer a port against a moving target; it is a port against a fixture.

The fixture carries per-block embeddings, buffer depths and scores; full mel and
VAD slabs for six sampled blocks; and — because the synthetic signal never
crosses a threshold, so an always-zero classifier would otherwise pass —
stage probes that land mid-range (0.63 and 0.97, above both thresholds) plus a
scripted trace through the warmup and refractory gating. See
[`fixtures/README.md`](fixtures/README.md).

**2. `protocol/PROTOCOL.md`'s framing section, fixed.** It was wrong in more
ways than the size: capture frames are not ~32 ms, and there is no streaming
during capture at all. The client buffers the whole utterance, trims the stop
word off the tail, and only then sends ≤16 KiB frames followed by
`utterance.end` — it cannot send earlier, because the trim needs the tail. The
stated rationale was wrong too (a busy server rejects at `utterance.begin`,
before any audio exists). Both sequence diagrams had the audio in the wrong
place. The section now states the receiver-side rule — **no assumptions about
payload size** — with the client's behaviour as one valid strategy rather than a
requirement.

**3. Protocol conformance, checked in.** Two suites, 24 new tests:

- [`server/src/protocol.test.ts`](server/src/protocol.test.ts) decodes frames
  dumped from the **real Python client module** by
  [`client/tools/dump_protocol_frames.py`](client/tools/dump_protocol_frames.py).
  A TypeScript test that builds its own JSON and parses it proves only that JSON
  round-trips; this one actually checks two implementations against each other.
  `Protocol.kt` gets held to the same fixture.
- [`server/src/ws-server.test.ts`](server/src/ws-server.test.ts) drives the real
  `startServer` with the four network dependencies faked: handshake, all four
  close codes, busy rejection *at begin*, late-frame dropping by turn tag, and
  the error path — including that `error` precedes the spoken explanation, and
  that every exit path emits `turn.end`.

`npm test`: 90 passing, `npm run typecheck` clean.

**4. Non-goal amended.** "Mobile client" is struck from
[`voice-opencode-requirements.md`](voice-opencode-requirements.md)'s non-goals
list and replaced by a new §9 recording the scope decisions and the measurements
behind them, following §7a's precedent. iOS and non-LE-Audio devices stay
non-goals.

**Done when:** ✅ the fixture exists and is exact, ✅ the doc is accurate,
✅ `npm test` runs the conformance check, ✅ the non-goal is amended openly.

### Phase 1 — Feature pipeline in Kotlin ✅

`AudioFeatures.kt`, `WakeWordModel.kt`, `SileroVad.kt`, `WakeWordDetector.kt`,
`SpeechGate.kt` and `Onnx.kt`, in `android/core` — **pure Kotlin with no Android
dependencies**, under plain JVM unit tests against the desktop ORT artifact.

**39 tests, all passing.** The pipeline reproduces
`fixtures/wakeword/golden.json` end to end, and the worst disagreement anywhere —
mel frames, embeddings, classifier scores, VAD probabilities, buffer depths —
is **4.999e-07**:

> The fixture rounds to six decimals, which is an absolute error of at most
> 5e-7. The observed worst case *is* that rounding step. Both sides run ONNX
> Runtime 1.28.0 against the same weights, so the tolerance is 1e-6 and there is
> no per-platform slack; the two implementations agree as exactly as the fixture
> is capable of recording.

Built bottom-up against the probes, which is what made this a day rather than
three: melspectrogram → embedding → classifier → gating trace → per-block
streaming. Every stage that broke, broke on its own test.

Three things beyond the numeric port:

- **The fixture now records model digests.** Every value in it is a function of
  five `.onnx` files, and a port checked against differently-versioned weights
  would have failed as unexplained numeric noise. `make_golden_vectors.py`
  writes their SHA-256s; `ModelIdentityTest` verifies the checked-in copies
  before any comparison runs. (Regenerating with the addition still cross-checks
  against the library at `0.0`, and is still byte-deterministic.)
- **`reset()` is now cheap** — see the amended gotcha below.
- **Model loading goes through a `ModelSource`** that hands ONNX Runtime a byte
  array, because that is the only route available on both sides: assets on the
  phone have no filesystem path at all. The desktop-only `createSession(String)`
  overload is the mistake that compiles and then fails on device.

Two details the fixture pinned that were easy to get wrong and gave no other
signal, both confirmed in the port: seed the feature buffer with **four seconds
of silence** (openWakeWord uses random audio, which is not reproducible), and
the classifiers' ONNX input names differ between models (`x.1` for `hey_jarvis`,
`onnx::Flatten_0` for `alexa`) — read `session.inputNames.first()`.

**Done when:** ✅ JVM tests reproduce `fixtures/wakeword/golden.json` end to end,
from PCM to classifier score.

### Phase 2 — Audio I/O and earcons (~2 days) ✅

`AudioIo.kt`, `Earcons.kt`. `AudioRecord` at 16 kHz mono PCM16 in 1280-sample
blocks; `AudioTrack` at the rate the server declares in `hello.ok`.

Two things get *simpler* than the Python client here:

- **Barge-in is real.** `Playback._writer` slices to 40 ms because
  `stream.write()` blocks for whatever it is handed. `AudioTrack.flush()` drops
  the device-side buffer directly, so the slicing workaround is unnecessary.
- **Earcons port verbatim.** `earcons.py` is pure sine math with no dependencies.

**Done when:** all five earcons are audible and distinguishable through the
target earbuds, and a captured 10 s WAV round-trips at full bandwidth.

#### What was built

> **The earcons are byte-identical to the Python client's.** All 75,697 samples,
> five earcons across three rates, zero differing. The comparison allows ±1 LSB —
> both sides truncate toward zero into int16, so a value within a float ulp of an
> integer boundary may legitimately land either side — and that headroom went
> entirely unused.

Exactness here was not a given, and getting it needed the narrowing points to
match rather than just the formulas. numpy computes the whole chain in float32:
`2π·freq` is narrowed *before* it multiplies the sample times, `np.linspace`
computes at double precision and narrows at the end while assigning its final
element to `stop` outright, and — the one that would have been invisible —
`error`'s sweep accumulates its phase as a running float32 sum. Carrying that
accumulator at double precision is more accurate and does not match.

Four amendments, all found by building it:

- **`Earcons.kt` is in `core`, not `app`.** Same reasoning as Phase 1's module
  split: it is pure arithmetic, so putting it where the JVM tests are turns "do
  the earcons match?" from a judgement by ear into 8 checked tests. Only
  playback needs Android.
- **`Wav.kt` too**, which the plan did not list at all. The done-when needs a WAV
  off the phone, and having a reader as well as a writer costs nothing and gets
  the writer a real test: it reads `fixtures/wakeword/input.wav`, which Python
  wrote.
- **The slicing workaround is *not* unnecessary** — the bullet above is half
  right. `AudioTrack.flush()` does drop the device buffer, which is the part the
  desktop client cannot do. But a `WRITE_BLOCKING` write cannot be abandoned, so
  a whole sentence handed over in one call is a whole sentence that must finish
  writing before the writer thread can notice it was flushed. 40 ms slices stay,
  for a different reason than in Python. (`flush()` also only takes effect on a
  paused track — hence a pause/flush/play sandwich, which needs confirming on a
  device.)
- **No Compose, and no ONNX Runtime in the APK yet.** The harness is
  framework Views: a diagnostic screen should not have a UI framework in it that
  could itself be why audio misbehaves, and Phase 4's status view is a different
  artifact anyway. Deferring ONNX Runtime to Phase 4 — nothing in Phase 2 runs
  inference — takes the APK from 38 MB to 9.4 MB, which matters when the phase is
  a sideload-listen-adjust loop. Checked before deferring: dexing `core` with
  unresolved `ai.onnxruntime` references produces no warnings in a debug build.

`AudioCheckActivity` is what makes the ear half of the done-when possible: it
plays each earcon at any of the three fixture rates, records 10 s to a WAV, and
reports level statistics plus **the device the OS actually routed to**. The
capture source is selectable across all four, because its effect cannot be
predicted from the API and recording the same room from each is the only way to
compare.

The bandwidth half is deliberately not judged on the phone. An 8 kHz-limited
stream resampled to 16 kHz sounds *fine*, so it takes a spectrum:
`android/tools/check_capture.py` prints a band table and returns a verdict.
Both of its verdicts are checked — it says FULL BANDWIDTH for
`fixtures/wakeword/input.wav` and BAND-LIMITED, naming the 3406 Hz cliff, for a
deliberately band-limited copy of it.

One thing surfaced that the plan had not connected up. §9 of the requirements doc
says the capture *use case* must be a communication one, because an LE Audio link
in a media context runs unidirectional and the buds' microphones do not stream at
all — capture falls back to the phone's own microphone without saying so. That
points at `VOICE_COMMUNICATION`, which is exactly the source a wake word would
rather not have: it brings AEC and noise suppression, and this plan's own risk
table lists AGC pumping the noise floor as a false-positive risk. The default
follows the requirements doc rather than quietly building against it, and **the
first comparison to run on a device is `VOICE_COMMUNICATION` against
`VOICE_RECOGNITION`, watching the routed device.** If the latter keeps
`BLE_HEADSET`, §9's claim needs revisiting and the wake word gets the cleaner
stream.

**Still open, and only a device can close it:** that comparison, whether the
earbuds route `TYPE_BLE_HEADSET` rather than `TYPE_BLUETOOTH_SCO`, whether the
five earcons are distinguishable in the ear, what the barge-in flush actually
sounds like, and the battery question below.

### Phase 3 — Protocol and state machine (~2–3 days)

`Protocol.kt`, `YammerClient.kt`. A direct port of `app.py`'s
IDLE → RECORDING → WAITING → ANSWERING machine, including the local busy
rejection, the fixed stop-word trim, and the pre-roll on permission answers.

**Done when:** a real utterance reaches the real server, an OpenCode reply plays
back, and a permission prompt can be approved by voice from the phone.

### Phase 4 — Service, lifecycle, config (~2 days)

`YammerService.kt` (foreground, `type=microphone`), `MainActivity.kt`,
`Config.kt` backed by DataStore.

**Config keeps the desktop client's variable names** — `YAMMER_SERVER_URL`,
`YAMMER_TOKEN`, `YAMMER_WAKE_START_MODEL`, `YAMMER_VAD_THRESHOLD`, and the rest.
There is no environment on Android, but matching keys keeps the two clients
legible to each other and keeps faith with "everything expected to change is
configuration."

**Done when:** it survives screen-off, Doze, and an app switch without dropping
the socket or the mic.

### Phase 5 — Tuning and measurement (open-ended, ≥2 days)

The part that cannot be done by reading code:

- Re-tune `YAMMER_WAKE_*_THRESHOLD` against the real earbud mic. The 0.5 defaults
  were calibrated on a laptop mic, and `VOICE_COMMUNICATION`'s AGC/NS chain
  changes the spectrum the models were trained on.
- Re-tune `YAMMER_WAKE_STOP_TRIM_SECONDS` — different mic, different latency.
- Measure phone battery per hour of listening.
- **Measure earbud battery.** See [Risks](#risks).

## Testing strategy

| Layer | How |
|---|---|
| Feature pipeline | ✅ `./gradlew :core:test` — vs. the Phase 0 golden vectors, worst divergence 4.999e-07. The one place where a subtle bug is silent: a wrong buffer offset yields scores that look reasonable and never fire. |
| Protocol | The Phase 0 conformance check, driven against `Protocol.kt`. |
| Earcons | ✅ Pinned to `fixtures/earcons/golden.json` — byte-identical to the Python client's, ±1 LSB allowed and unused. What a fixture cannot check is whether they are *distinguishable in the ear*, which is what `AudioCheckActivity` is for. |
| Capture bandwidth | ✅ `android/tools/check_capture.py` on a WAV pulled from the phone. Not judgeable by ear: a band-limited stream sounds fine and has already lost what cannot be recovered. |
| Wake-word accuracy | By use. Log every score above ~0.3 so false-negative complaints are diagnosable after the fact. |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Earbud battery.** Always-on listening means the LE Audio bidirectional stream is up *continuously*, not in call-length bursts. Buds carry ~50–70 mAh. Expect meaningfully shorter runtime than media playback, possibly half. | **High** — and not codeable-around | Measure early, before building on the assumption. **Still the top open risk**: Phase 2 built the thing that can measure it — leave `AudioCheckActivity` recording and watch the buds — but nothing has been measured yet. If it fails, the fallback is phone-mic-in / A2DP-out, which costs nothing in bandwidth but requires the phone to be out and near you. |
| ~~Capture silently routes to the built-in mic instead of the buds~~ | ~~Medium~~ → **instrumented** | Done in Phase 2. `AudioCapture` reports `getRoutedDevice()` at capture start and `describeDevice()` names the transport rather than printing a constant: `BLE_HEADSET (LE Audio — the supported path)` vs `BLUETOOTH_SCO (classic telephony — band-limited)` vs `BUILTIN_MIC`. A suspicion becomes a fact on first run. The *verdict* on what happens is still unmeasured. |
| ~~Feature-pipeline port is subtly wrong~~ | ~~Medium~~ → **Low** | Retired by Phase 0. The algorithm is pinned to a fixture that a from-scratch reimplementation reproduced *exactly* (`0.0` divergence), so a Kotlin bug now surfaces as a failing JVM test rather than as a wake word that mysteriously doesn't fire. |
| AGC pumping the noise floor causes wake-word false positives | Medium | Threshold re-tuning in Phase 5. If it persists, `UNPROCESSED` is available where `PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED` reports true — at the cost of losing AEC. |
| Phone battery from preventing deep sleep | Low–Medium | Measure. The cost is dominated by keeping the CPU out of deep sleep, not by the 4.6%-of-a-core inference. |

### Two gotchas that will otherwise cost an hour each

- ~~**`reset()` is expensive: 86 ms measured on desktop**~~ — **fixed in Phase 1,
  but only half of it.** The library reseeds the feature buffer with 4 s of fresh
  random audio on every reset: one melspectrogram over 64000 samples plus a
  41-window embedding batch. The port seeds with *silence*, which is constant, so
  `AudioFeatures` computes that once at construction and copies it back — the
  compute is gone. **The ~400 ms deaf window is not.** Clearing the prediction
  buffer re-triggers the 5-frame warmup by design, and `app.py` calls `reset()`
  at every `turn.end` and every `_leave_answering()`. On desktop it hides under
  the stop-record earcon; the same has to hold on the phone.
- ~~**ONNX Runtime cannot load a model from an asset path.**~~ Handled in Phase 1
  by `ModelSource`, which hands the runtime a `ByteArray` on both the desktop and
  the device. Still worth knowing, because the `createSession(String)` overload
  compiles fine and fails only on hardware.

## Doc changes required

Scope discipline (AGENTS.md): the requirements doc's non-goals list is
load-bearing, and building against it quietly is the failure mode it exists to
prevent. This project takes an entry off that list, so the doc changes first.

- ✅ **`voice-opencode-requirements.md`** — "Mobile client" struck from the
  non-goals list and replaced by §9, following §7a's precedent: the reasoning,
  the measurements, the LE Audio requirement, and what stays excluded (iOS,
  non-LE-Audio devices).
- ✅ **`protocol/PROTOCOL.md`** — framing section rewritten; both sequence
  diagrams corrected.
- ✅ **`AGENTS.md`** — `fixtures/` and `client/tools/` added to the repository
  layout; the test section now describes three suites and the fixture-regeneration
  step after a protocol change.
- ◐ **`voice-opencode-requirements.md`, second pass** — done: the headphones
  operating assumption now carries the note that Android gets AEC and NS as a
  side effect of the communication capture use case §9 requires, and says that
  is a side effect to measure rather than a reason to support speakers. Still
  outstanding: "Client (v1 = desktop app)" in § Architecture describing two
  clients, which waits for Phase 3 — after Phase 2 there is an APK that plays
  earcons and records audio, not a second client.
- ◐ **`AGENTS.md`, second pass** — done: `android/`, `android/core/` and
  `android/models/` are in the layout, `./gradlew :core:test` is in the commands,
  and the test section describes what that suite guards. Still outstanding: the
  note that the protocol contract has four views rather than three, due when
  `Protocol.kt` exists (Phase 3). The `reset()` and asset-loading gotchas turned
  out not to belong there — both are now solved in code rather than warned about
  in prose.
- ◐ **`android/README.md`** — written: requirements including the YMMV hardware
  caveat, the module split and why, build and test, the model table and what the
  suite actually checks. The config and earcon tables follow the code that needs
  them (Phases 4 and 2).

## Non-goals

Inherited from the requirements doc unless stated otherwise, plus:

- **Classic Bluetooth (HFP/SCO) support.** Explicitly unsupported. The mic
  bandwidth is not recoverable and supporting it means SCO lifecycle handling.
- **Device pinning / manual route selection.** Deferred until the Phase 2
  measurement says it is needed.
- **Play Store distribution.** Personal tool, then open source. Continuous
  background microphone access is a policy conversation nobody needs yet.
- **Any server-side change.** Workspace/project/session sandboxing is a separate
  effort. It is additive on the server and does not block or depend on this one.
- **Feature parity with the Python client's `.env` loading.** Same variable
  names, different mechanism.
