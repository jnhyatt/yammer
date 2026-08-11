# Yammer — Android Client Implementation Plan

> **Status: Phase 0 complete, no Android code yet.** Written 2026-08-11 after a
> feasibility dig through `client/` and openWakeWord's internals; Phase 0
> executed the same day. Supersedes the "Mobile client" entry on the
> requirements doc's non-goals list, now amended as §9 — see
> [Doc changes](#doc-changes-required).

## Verdict

Feasible, and the ML is the easy part. The full wake-word pipeline
(melspectrogram → embedding → two classifiers) measures **3.68 ms per 80 ms
block on a 2015 Skylake laptop core** — 4.6% of one core, single-threaded, and a
phone's big core beats that. Silero VAD adds 0.96 ms (1.2%). All five models are
plain ONNX totalling 6.2 MB and run on `onnxruntime-android` unmodified: no
conversion, no quantization, no NNAPI or GPU delegate.

The real work is a **faithful Kotlin port of openWakeWord's streaming feature
pipeline** — roughly 400 lines of fiddly but fully deterministic buffer
arithmetic. Phase 0 has since pinned it to golden vectors, and a from-scratch
reimplementation built only from this document's description reproduced the
library **exactly** (`0.0` divergence over 48 blocks). What was the plan's
largest unknown is now a fixture to code against.

Total: **~1,600 lines of Kotlin**, ~2–3 weeks of focused part-time work, with an
open-ended tuning tail.

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
  app/
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      assets/models/            the five .onnx files, 6.2 MB
      java/dev/yammer/android/
        MainActivity.kt         permission request, start/stop, log view
        YammerService.kt        foreground service, type=microphone
        Config.kt               ← client/src/yammer_client/config.py
        Protocol.kt             ← client/src/yammer_client/protocol.py
        YammerClient.kt         ← client/src/yammer_client/app.py
        AudioIo.kt              ← client/src/yammer_client/audio.py
        Earcons.kt              ← client/src/yammer_client/earcons.py
        WakeWordDetector.kt     ← client/src/yammer_client/wakeword.py
        SpeechGate.kt           ← client/src/yammer_client/vad.py
        AudioFeatures.kt        ← openwakeword/utils.py  (NEW — the real work)
        WakeWordModel.kt        ← openwakeword/model.py  (NEW)
        SileroVad.kt            ← openwakeword/vad.py    (NEW)
    test/                       JVM unit tests — golden vectors, no emulator
```

**The left-hand column is load-bearing.** `protocol/PROTOCOL.md`,
`server/src/protocol.ts`, and `client/.../protocol.py` are already three views of
one contract; `Protocol.kt` makes four. Keep the file-for-file correspondence so
a protocol change has an obvious checklist.

### Dependencies

- `com.microsoft.onnxruntime:onnxruntime-android` — inference
- `com.microsoft.onnxruntime:onnxruntime` (JVM, `testImplementation` only) — lets
  the feature-pipeline tests run as plain JVM unit tests against the same models
- `com.squareup.okhttp3:okhttp` — WebSocket
- `org.jetbrains.kotlinx:kotlinx-serialization-json` — control frames
- `androidx.datastore:datastore-preferences` — config
- Compose for the (deliberately minimal) UI

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

### Phase 1 — Feature pipeline in Kotlin (~3–4 days)

`AudioFeatures.kt`, `WakeWordModel.kt`, `SileroVad.kt`, `WakeWordDetector.kt`,
`SpeechGate.kt`. Written as **pure Kotlin with no Android dependencies**, so it
runs under plain JVM unit tests against the desktop ORT artifact — fast
iteration, no emulator, no device.

Work bottom-up against the fixture, in the order the probes are laid out:
melspectrogram probe → embedding probe → classifier probe → gating trace →
per-block streaming records. Each stage fails independently, so a divergence
localizes itself instead of presenting as "the score is wrong".

Two things the fixture pins that are easy to get wrong and give no other signal:
seed the feature buffer with **four seconds of silence** (openWakeWord uses
random audio, which is not reproducible), and remember the classifiers' ONNX
input names differ between models (`x.1` for `hey_jarvis`, `onnx::Flatten_0` for
`alexa`) — read `session.inputNames.first()` rather than hardcoding either.

**Done when:** JVM tests reproduce `fixtures/wakeword/golden.json` within f32
tolerance, end to end from PCM to classifier score.

### Phase 2 — Audio I/O and earcons (~2 days)

`AudioIo.kt`, `Earcons.kt`. `AudioRecord` at 16 kHz mono PCM16 in 1280-sample
blocks; `AudioTrack` at the rate the server declares in `hello.ok`.

Two things get *simpler* than the Python client here:

- **Barge-in is real.** `Playback._writer` slices to 40 ms because
  `stream.write()` blocks for whatever it is handed. `AudioTrack.flush()` drops
  the device-side buffer directly, so the slicing workaround is unnecessary.
- **Earcons port verbatim.** `earcons.py` is pure sine math with no dependencies.

**Done when:** all five earcons are audible and distinguishable through the
target earbuds, and a captured 10 s WAV round-trips at full bandwidth.

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
| Feature pipeline | JVM unit tests vs. Phase 0 golden vectors. The one place where a subtle bug is silent — a wrong buffer offset yields scores that look reasonable and never fire. |
| Protocol | The Phase 0 conformance check, driven against `Protocol.kt`. |
| Earcons | By ear. They are the only status channel; there is no better test. |
| Wake-word accuracy | By use. Log every score above ~0.3 so false-negative complaints are diagnosable after the fact. |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Earbud battery.** Always-on listening means the LE Audio bidirectional stream is up *continuously*, not in call-length bursts. Buds carry ~50–70 mAh. Expect meaningfully shorter runtime than media playback, possibly half. | **High** — and not codeable-around | Measure early, in Phase 2, before building on the assumption. If it fails, the fallback is phone-mic-in / A2DP-out, which costs nothing in bandwidth but requires the phone to be out and near you. |
| Capture silently routes to the built-in mic instead of the buds | Medium | **Log `AudioRecord.getRoutedDevice()` at capture start.** Three lines. Turns a suspicion into a fact on first run: `TYPE_BLE_HEADSET` means the assumption held, `TYPE_BUILTIN_MIC` means it did not and you know why. Same principle as `Config.env_file` being reported at startup. |
| ~~Feature-pipeline port is subtly wrong~~ | ~~Medium~~ → **Low** | Retired by Phase 0. The algorithm is pinned to a fixture that a from-scratch reimplementation reproduced *exactly* (`0.0` divergence), so a Kotlin bug now surfaces as a failing JVM test rather than as a wake word that mysteriously doesn't fire. |
| AGC pumping the noise floor causes wake-word false positives | Medium | Threshold re-tuning in Phase 5. If it persists, `UNPROCESSED` is available where `PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED` reports true — at the cost of losing AEC. |
| Phone battery from preventing deep sleep | Low–Medium | Measure. The cost is dominated by keeping the CPU out of deep sleep, not by the 4.6%-of-a-core inference. |

### Two gotchas that will otherwise cost an hour each

- **`reset()` is expensive: 86 ms measured on desktop,** and it reseeds the
  feature buffer with 4 s of random audio, which re-triggers the 5-frame warmup —
  so there is a **~400 ms deaf window** after every reset. `app.py` calls it at
  every `turn.end` and every `_leave_answering()`. On desktop it hides under the
  stop-record earcon. On a phone it could be 150–400 ms of compute and **must not
  run on the audio callback thread**. openWakeWord's own docstring warns it "may
  not be efficient when called too frequently."
- **ONNX Runtime cannot load a model from an asset path.** Read the asset into a
  `ByteArray` and use the byte-array session constructor, or copy to `filesDir`
  on first run.

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
- ⬜ **`voice-opencode-requirements.md`, second pass** — "Client (v1 = desktop
  app)" in § Architecture will describe two clients once one exists, and the
  headphones operating assumption gains a note that Android gets AEC as a side
  effect of declaring a communication capture use case. Deferred to Phase 2
  deliberately: both are claims about a thing that does not yet run.
- ⬜ **`AGENTS.md`, second pass** — add `android/` to the layout, the `reset()`
  cost and ONNX-asset-loading gotchas, and the note that the protocol contract
  has four views rather than three. Due when `Protocol.kt` exists (Phase 3).
- ⬜ **`android/README.md`** — new. Requirements (including the YMMV hardware
  caveat), build, config table, earcon table.

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
