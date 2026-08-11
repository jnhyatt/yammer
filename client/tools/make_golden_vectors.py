#!/usr/bin/env python3
"""Generate the cross-language golden vectors for the wake-word pipeline.

Why this exists
---------------
The Android client reimplements openWakeWord's streaming feature pipeline in
Kotlin. That pipeline is the one part of the port whose bugs are *silent*: a
wrong buffer offset or a missed transform yields plausible-looking scores that
simply never cross threshold, and the only symptom is a wake word that doesn't
work. There is no exception to catch and nothing in a log to read.

So the pipeline is pinned to a fixture instead. This script:

1. Reimplements the streaming algorithm from scratch on top of raw ONNX Runtime,
   using only the steps written down in `android-client-plan.md` — no calls into
   openWakeWord's own buffering.
2. Cross-checks that reimplementation against the real `openwakeword.Model`,
   block for block, and refuses to write anything if they disagree.
3. Dumps the intermediate tensors to `fixtures/wakeword/golden.json`.

Step 2 is the load-bearing one. It proves the written-down algorithm *is* the
library's algorithm, here on the desktop in the language where it can be
debugged, rather than discovering the difference from Kotlin later.

Determinism
-----------
`AudioFeatures.__init__` seeds its feature buffer with four seconds of
`np.random.randint` audio, so the library's first ~16 blocks of output are not
reproducible between runs. This script seeds with four seconds of **silence**
instead, and forces the same seeding on the library before comparing. The
Kotlin port must do the same. After ~16 blocks the seed frames have been pushed
out of the 16-frame classifier window and the choice stops mattering — but
matching it means the fixture is exact from block 0 rather than only eventually.

Usage
-----
    cd client
    .venv/bin/python tools/make_golden_vectors.py

Optionally pass a 16 kHz mono 16-bit WAV to use instead of the generated test
signal — worth doing once there is a real recording of the wake word:

    .venv/bin/python tools/make_golden_vectors.py --input hey_jarvis.wav
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import wave
from collections import deque
from pathlib import Path

import numpy as np
import onnxruntime as ort

# --- Pipeline constants ----------------------------------------------------
#
# Every one of these is a magic number in openWakeWord that the Kotlin port has
# to reproduce exactly. They are named here so the fixture and the port can
# refer to the same things.

SAMPLE_RATE = 16_000
BLOCK_SAMPLES = 1280  # 80 ms — the granularity openWakeWord accumulates to

# The melspectrogram is computed over the new block *plus* three hops of the
# preceding audio, so the window that straddles the block boundary is real
# audio rather than padding.
MELSPEC_LOOKBACK = 160 * 3  # 480 samples
MEL_BINS = 32
MEL_FRAMES_PER_BLOCK = 8  # for a full 1760-sample input; the first block gives 5

MEL_BUFFER_INIT = 1.0  # melspectrogram_buffer starts as ones((76, 32))
MEL_BUFFER_MAX_FRAMES = 970  # 10 * 97
MEL_WINDOW_FRAMES = 76  # embedding model input height
MEL_WINDOW_STEP = 8  # hop between embedding windows

EMBEDDING_DIMS = 96
FEATURE_BUFFER_MAX_FRAMES = 120
CLASSIFIER_FRAMES = 16  # the classifier sees the last 16 embedding frames

# Model outputs are forced to zero until this many frames have been scored.
WARMUP_FRAMES = 5
PREDICTION_BUFFER_MAX = 30

VAD_FRAME_SAMPLES = 320  # 20 ms; divides 1280 evenly (see client/.../vad.py)
VAD_STATE_DIMS = (2, 1, 64)

# Seed for the feature buffer. openWakeWord uses random audio; we use silence so
# the fixture is reproducible. Must match in the Kotlin port.
SEED_SAMPLES = SAMPLE_RATE * 4


def melspec_transform(spec: np.ndarray) -> np.ndarray:
    """openWakeWord's default `melspec_transform`.

    Brings the ONNX melspectrogram model's output into the range Google's
    original TensorFlow `speech_embedding` graph was trained against. Omitting
    it is the single easiest way to get a pipeline that runs and never fires.
    """
    return spec / 10.0 + 2.0


# --- Reference implementation ----------------------------------------------


class ReferencePipeline:
    """The streaming feature pipeline, built from documented steps only.

    Deliberately does not import openWakeWord. It talks to the same five ONNX
    files through raw ONNX Runtime, exactly as `AudioFeatures.kt` will, so that
    a disagreement with the library is a disagreement with *this description of
    the algorithm* — which is the thing the Kotlin port will be written from.

    Simplifying assumption: `process_block` is always fed exactly
    `BLOCK_SAMPLES`. openWakeWord tolerates arbitrary lengths by accumulating a
    remainder; the client only ever hands it whole 80 ms blocks, so the port
    does not need that machinery. `AudioIo.kt` must guarantee the same.
    """

    def __init__(self, model_dir: Path, wake_models: dict[str, Path]) -> None:
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        providers = ["CPUExecutionProvider"]

        def load(path: Path) -> ort.InferenceSession:
            return ort.InferenceSession(str(path), sess_options=opts, providers=providers)

        self.melspec = load(model_dir / "melspectrogram.onnx")
        self.embedding = load(model_dir / "embedding_model.onnx")
        self.classifiers = {name: load(path) for name, path in wake_models.items()}

        self.raw_buffer: deque[int] = deque(maxlen=SAMPLE_RATE * 10)
        self.mel_buffer = np.full((MEL_WINDOW_FRAMES, MEL_BINS), MEL_BUFFER_INIT)
        self.feature_buffer = self.seed_features()
        self.seed_frames = int(self.feature_buffer.shape[0])
        self.prediction_buffer: dict[str, deque[float]] = {
            name: deque(maxlen=PREDICTION_BUFFER_MAX) for name in wake_models
        }

    # -- model wrappers --

    def run_melspec(self, samples: np.ndarray) -> np.ndarray:
        """PCM (int16) -> (frames, 32) mel frames, transformed."""
        x = samples.astype(np.float32)[None, :]
        spec = np.squeeze(self.melspec.run(None, {"input": x})[0])
        return melspec_transform(spec)

    def run_embedding(self, windows: np.ndarray) -> np.ndarray:
        """(batch, 76, 32, 1) float32 -> (batch, 96)."""
        out = self.embedding.run(None, {"input_1": windows})[0]
        return out.reshape(out.shape[0], EMBEDDING_DIMS)

    def run_classifier(self, name: str, features: np.ndarray) -> float:
        """(1, 16, 96) float32 -> scalar score."""
        session = self.classifiers[name]
        out = session.run(None, {session.get_inputs()[0].name: features})[0]
        return float(np.ravel(out)[0])

    # -- setup --

    def seed_features(self) -> np.ndarray:
        """Prime the feature buffer, the way `AudioFeatures.__init__` does.

        Batch (not streaming) embedding of four seconds of audio: one
        melspectrogram over the whole clip, then every 76-frame window at a
        stride of 8, all pushed through the embedding model at once.
        """
        spec = self.run_melspec(np.zeros(SEED_SAMPLES, dtype=np.int16))
        windows = [
            spec[i : i + MEL_WINDOW_FRAMES]
            for i in range(0, spec.shape[0], MEL_WINDOW_STEP)
            if spec[i : i + MEL_WINDOW_FRAMES].shape[0] == MEL_WINDOW_FRAMES
        ]
        batch = np.expand_dims(np.array(windows), axis=-1).astype(np.float32)
        return self.run_embedding(batch)

    # -- streaming --

    def process_block(self, block: np.ndarray) -> dict:
        """Feed one 80 ms block. Returns everything the fixture records."""
        if block.shape[0] != BLOCK_SAMPLES:
            raise ValueError(f"expected {BLOCK_SAMPLES} samples, got {block.shape[0]}")

        # 1. Accumulate raw audio.
        self.raw_buffer.extend(block.tolist())

        # 2. Melspectrogram over the new block plus the lookback, appended to a
        #    rolling buffer. On the very first block the buffer is shorter than
        #    the requested slice, so this yields 5 frames rather than 8 — a real
        #    edge case, not an off-by-one to "fix".
        tail = np.array(
            list(self.raw_buffer)[-(BLOCK_SAMPLES + MELSPEC_LOOKBACK) :], dtype=np.int16
        )
        mel_new = self.run_melspec(tail)
        self.mel_buffer = np.vstack((self.mel_buffer, mel_new))
        if self.mel_buffer.shape[0] > MEL_BUFFER_MAX_FRAMES:
            self.mel_buffer = self.mel_buffer[-MEL_BUFFER_MAX_FRAMES:, :]

        # 3. One embedding frame per block, over the trailing 76 mel frames.
        window = self.mel_buffer[-MEL_WINDOW_FRAMES:].astype(np.float32)
        embedding = None
        if window.shape[0] == MEL_WINDOW_FRAMES:
            embedding = self.run_embedding(window[None, :, :, None])
            self.feature_buffer = np.vstack((self.feature_buffer, embedding))
        if self.feature_buffer.shape[0] > FEATURE_BUFFER_MAX_FRAMES:
            self.feature_buffer = self.feature_buffer[-FEATURE_BUFFER_MAX_FRAMES:, :]

        # 4. Score each wake word off the trailing 16 embedding frames.
        features = self.feature_buffer[-CLASSIFIER_FRAMES:, :][None,].astype(np.float32)
        scores = {
            name: self.run_classifier(name, features) for name in self.classifiers
        }

        return {
            "melFrames": mel_new.tolist(),
            "embedding": (
                embedding.reshape(-1).tolist() if embedding is not None else None
            ),
            "featureBufferFrames": int(self.feature_buffer.shape[0]),
            "melBufferFrames": int(self.mel_buffer.shape[0]),
            "rawScores": scores,
        }

    def apply_gating(
        self, raw: dict[str, float], thresholds: dict[str, float], debounce_frames: int
    ) -> dict[str, float]:
        """Warmup zeroing and refractory debounce, in openWakeWord's order.

        Two details the port must not get wrong:

        - The debounce window is checked against the prediction buffer, and the
          **gated** score is what gets appended to it. A suppressed detection
          therefore does not extend its own refractory period.
        - Warmup is counted per model in frames scored, not in samples seen.
        """
        gated: dict[str, float] = {}
        for name, score in raw.items():
            history = self.prediction_buffer[name]
            value = 0.0 if len(history) < WARMUP_FRAMES else score
            if value != 0.0 and value >= thresholds[name]:
                recent = list(history)[-debounce_frames:]
                if any(prior >= thresholds[name] for prior in recent):
                    value = 0.0
            gated[name] = value
        for name, value in gated.items():
            self.prediction_buffer[name].append(value)
        return gated


class ReferenceVad:
    """Silero v4, framed the way `client/.../vad.py` frames it."""

    def __init__(self, model_path: Path) -> None:
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.sample_rate = np.array(SAMPLE_RATE).astype(np.int64)
        self.reset()

    def reset(self) -> None:
        self.h = np.zeros(VAD_STATE_DIMS, dtype=np.float32)
        self.c = np.zeros(VAD_STATE_DIMS, dtype=np.float32)

    def score_block(self, block: np.ndarray) -> tuple[float, list[float]]:
        """One capture block -> (mean probability, per-frame probabilities).

        Note the scaling divisor is 32767, not 32768. The difference is
        inaudible and irrelevant to the model, but it is not irrelevant to a
        golden-vector comparison.
        """
        frames = []
        for start in range(0, block.shape[0], VAD_FRAME_SAMPLES):
            chunk = (block[start : start + VAD_FRAME_SAMPLES] / 32767).astype(np.float32)
            out, self.h, self.c = self.session.run(
                None,
                {"input": chunk[None,], "h": self.h, "c": self.c, "sr": self.sample_rate},
            )
            frames.append(float(out[0][0]))
        return float(np.mean(frames)), frames


# --- Test signal -----------------------------------------------------------


def generate_test_signal(blocks: int = 48) -> np.ndarray:
    """A deterministic, spectrally varied 16 kHz mono signal.

    Not speech. The fixture's job is numeric equivalence between two
    implementations of the same arithmetic, and for that a signal that exercises
    the whole filterbank is worth more than one that happens to trip a
    classifier. It does include digital silence at both ends, because silence is
    where a mishandled log or an uninitialized buffer hides.

    The noise source is a plain LCG rather than NumPy's RNG so the signal can be
    regenerated from this description in any language. The generated WAV is
    checked in regardless, so nothing depends on reproducing it bit for bit.

    Replace this with a real recording of the wake word when one exists — see
    the `--input` flag. Detection *behaviour* is a Phase 5 tuning question; this
    fixture only pins the arithmetic underneath it.
    """
    total = blocks * BLOCK_SAMPLES
    t = np.arange(total, dtype=np.float64) / SAMPLE_RATE
    duration = total / SAMPLE_RATE
    signal = np.zeros(total, dtype=np.float64)

    # Reproducible noise: glibc's LCG constants, mapped to [-1, 1).
    state = 20260811
    noise = np.empty(total, dtype=np.float64)
    for i in range(total):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        noise[i] = (state / 0x40000000) - 1.0

    def window(lo: float, hi: float) -> np.ndarray:
        return (t >= lo * duration) & (t < hi * duration)

    # Rising chirp, 200 Hz -> 4 kHz: sweeps energy across every mel bin.
    chirp = window(0.10, 0.31)
    if chirp.any():
        local = t[chirp] - t[chirp][0]
        span = local[-1] if local[-1] > 0 else 1.0
        phase = 2 * np.pi * (200 * local + (4000 - 200) / (2 * span) * local**2)
        signal[chirp] = 0.55 * np.sin(phase)

    # Three simultaneous tones over broadband noise.
    mixed = window(0.31, 0.52)
    signal[mixed] = 0.35 * (
        np.sin(2 * np.pi * 440 * t[mixed])
        + np.sin(2 * np.pi * 1250 * t[mixed])
        + np.sin(2 * np.pi * 3100 * t[mixed])
    ) / 3 + 0.25 * noise[mixed]

    # Low-level noise only: near the floor without being silent.
    quiet = window(0.52, 0.63)
    signal[quiet] = 0.02 * noise[quiet]

    # Amplitude-modulated burst train — a speech-like envelope at ~6 Hz.
    bursts = window(0.63, 0.84)
    envelope = 0.5 * (1 - np.cos(2 * np.pi * 6 * t[bursts]))
    signal[bursts] = 0.6 * envelope * np.sin(2 * np.pi * 700 * t[bursts])

    # Everything outside those windows stays digital silence.
    return np.clip(signal * 32767, -32768, 32767).astype(np.int16)


def lcg_floats(count: int, seed: int = 20260811) -> np.ndarray:
    """The same LCG as `generate_test_signal`, as floats in [-1, 1).

    Used to build stage-level probe inputs. Trivially portable, so the Kotlin
    test can regenerate the identical input rather than carrying it in the
    fixture.
    """
    state = seed
    out = np.empty(count, dtype=np.float64)
    for i in range(count):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        out[i] = (state / 0x40000000) - 1.0
    return out


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 16-bit mono")
        if handle.getframerate() != SAMPLE_RATE:
            raise SystemExit(f"{path}: need {SAMPLE_RATE} Hz, got {handle.getframerate()}")
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(samples.tobytes())


# --- Stage probes ----------------------------------------------------------
#
# The streaming records below pin the pipeline as a whole, but their classifier
# scores all sit near zero — the synthetic signal is not a wake word. A port
# whose classifier always returned 0.0 would match them. These probes fix that
# by driving each stage directly with an input chosen to land mid-range, and by
# scripting the gating state machine against synthetic scores.


def build_probes(pipeline: ReferencePipeline, thresholds: dict[str, float],
                 debounce_frames: int) -> dict:
    """Stage-level fixtures with non-degenerate outputs."""

    # Melspectrogram, with no buffer state involved: exactly one block plus its
    # lookback, of a 1 kHz tone. If this disagrees, nothing downstream matters.
    t = np.arange(BLOCK_SAMPLES + MELSPEC_LOOKBACK) / SAMPLE_RATE
    tone = (np.sin(2 * np.pi * 1000 * t) * 16000).astype(np.int16)
    mel_probe = pipeline.run_melspec(tone)

    # Embedding, from a fixed 76x32 window rather than from the pipeline, so a
    # buffer bug can't be mistaken for a model-wiring bug.
    window = lcg_floats(MEL_WINDOW_FRAMES * MEL_BINS).reshape(
        MEL_WINDOW_FRAMES, MEL_BINS
    ) * 4.0
    embedding_probe = pipeline.run_embedding(
        window.astype(np.float32)[None, :, :, None]
    )

    # Classifier, driven with feature values scaled to roughly the magnitude
    # real embeddings have (std ~16). Scale 8 puts both models well above their
    # 0.5 thresholds, so this probe also proves the *detection* path, not just
    # the arithmetic.
    raw = lcg_floats(CLASSIFIER_FRAMES * EMBEDDING_DIMS)
    classifier_probe = {}
    for scale in (1.0, 8.0):
        features = (raw.reshape(1, CLASSIFIER_FRAMES, EMBEDDING_DIMS) * scale).astype(
            np.float32
        )
        classifier_probe[str(scale)] = {
            name: round(pipeline.run_classifier(name, features), 6)
            for name in pipeline.classifiers
        }

    # The gating state machine, scripted. This is where the port is most likely
    # to go subtly wrong, and where the audio fixture gives no coverage at all
    # because the synthetic signal never crosses a threshold.
    name = next(iter(pipeline.classifiers))
    threshold = thresholds[name]
    script = (
        # Six sub-threshold frames: the first five are zeroed by warmup even
        # though the raw score is non-zero, the sixth passes through.
        [0.10] * 6
        # A crossing. Warmup is over, no recent hit: fires.
        + [0.90]
        # Immediately above threshold again: suppressed by the refractory
        # window. Note these suppressed frames are appended to the prediction
        # buffer as 0.0, so they do not themselves extend the refractory.
        + [0.95, 0.99]
        # Quiet for exactly long enough to clear the debounce window, then a
        # second crossing that must fire.
        + [0.0] * (debounce_frames - 1)
        + [0.80]
    )
    gate = {gname: deque(maxlen=PREDICTION_BUFFER_MAX) for gname in (name,)}
    gated_out = []
    for score in script:
        history = gate[name]
        value = 0.0 if len(history) < WARMUP_FRAMES else score
        if value != 0.0 and value >= threshold:
            if any(prior >= threshold for prior in list(history)[-debounce_frames:]):
                value = 0.0
        history.append(value)
        gated_out.append(round(value, 6))

    return {
        "melspectrogram": {
            "input": "sin(2*pi*1000*t) * 16000, %d samples" % len(tone),
            "inputSamples": len(tone),
            "frames": [[round(float(v), 6) for v in frame] for frame in mel_probe],
        },
        "embedding": {
            "input": "lcg_floats(76*32) reshaped (76,32), scaled by 4.0",
            "output": [round(float(v), 6) for v in embedding_probe.reshape(-1)],
        },
        "classifier": {
            "input": "lcg_floats(16*96) reshaped (1,16,96), scaled by the key",
            "scores": classifier_probe,
        },
        "gating": {
            "model": name,
            "threshold": threshold,
            "debounceFrames": debounce_frames,
            "rawScores": script,
            "gatedScores": gated_out,
        },
    }


# --- Cross-check against the library ---------------------------------------


def library_scores(
    blocks: list[np.ndarray],
    start_model: str,
    stop_model: str,
    thresholds: dict[str, float],
    refractory_seconds: float,
) -> list[dict[str, float]]:
    """Run the real openWakeWord over the same blocks, deterministically.

    The library's own initialization is random (see the module docstring), so
    its preprocessor state is overwritten with the deterministic equivalent
    before streaming. Everything after that is the library's code path,
    untouched.
    """
    from openwakeword.model import Model

    model = Model(
        wakeword_models=[start_model, stop_model], inference_framework="onnx"
    )
    pre = model.preprocessor
    pre.raw_data_buffer.clear()
    pre.melspectrogram_buffer = np.full((MEL_WINDOW_FRAMES, MEL_BINS), MEL_BUFFER_INIT)
    pre.accumulated_samples = 0
    pre.raw_data_remainder = np.empty(0)
    pre.feature_buffer = pre._get_embeddings(np.zeros(SEED_SAMPLES, dtype=np.int16))
    for buffer in model.prediction_buffer.values():
        buffer.clear()

    return [
        {
            name: float(value)
            for name, value in model.predict(
                block, threshold=thresholds, debounce_time=refractory_seconds
            ).items()
        }
        for block in blocks
    ]


# --- Main ------------------------------------------------------------------


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    default_out = repo_root / "fixtures" / "wakeword"

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="16 kHz mono 16-bit WAV to use")
    parser.add_argument("--out-dir", type=Path, default=default_out)
    parser.add_argument("--start-model", default="hey_jarvis")
    parser.add_argument("--stop-model", default="alexa")
    parser.add_argument("--start-threshold", type=float, default=0.5)
    parser.add_argument("--stop-threshold", type=float, default=0.5)
    parser.add_argument("--refractory-seconds", type=float, default=1.5)
    parser.add_argument(
        "--tolerance",
        type=float,
        default=1e-5,
        help="max allowed disagreement with openWakeWord",
    )
    args = parser.parse_args()

    import openwakeword

    model_dir = Path(openwakeword.__file__).parent / "resources" / "models"
    wake_models = {
        args.start_model: model_dir / f"{args.start_model}_v0.1.onnx",
        args.stop_model: model_dir / f"{args.stop_model}_v0.1.onnx",
    }
    for name, path in wake_models.items():
        if not path.exists():
            raise SystemExit(
                f"{path} is missing. Run:\n"
                "  .venv/bin/python -c 'import openwakeword.utils as u; u.download_models()'"
            )

    # Recorded in the fixture so a port can prove it loaded the same weights.
    # Every number below is a function of these five files; a port checked
    # against a differently-versioned model would fail with numeric noise and no
    # indication of why.
    model_files = {
        "melspectrogram": model_dir / "melspectrogram.onnx",
        "embedding": model_dir / "embedding_model.onnx",
        "vad": model_dir / "silero_vad.onnx",
        **wake_models,
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = args.out_dir / "input.wav"
    if args.input:
        samples = read_wav(args.input)
        usable = (samples.shape[0] // BLOCK_SAMPLES) * BLOCK_SAMPLES
        samples = samples[:usable]
        write_wav(wav_path, samples)
    else:
        samples = generate_test_signal()
        write_wav(wav_path, samples)

    blocks = [
        samples[i : i + BLOCK_SAMPLES]
        for i in range(0, samples.shape[0], BLOCK_SAMPLES)
    ]
    print(f"input: {len(blocks)} blocks, {samples.shape[0] / SAMPLE_RATE:.2f}s")

    thresholds = {
        args.start_model: args.start_threshold,
        args.stop_model: args.stop_threshold,
    }
    debounce_frames = int(
        np.ceil(args.refractory_seconds / (BLOCK_SAMPLES / SAMPLE_RATE))
    )

    pipeline = ReferencePipeline(model_dir, wake_models)
    vad = ReferenceVad(model_dir / "silero_vad.onnx")

    records = []
    for index, block in enumerate(blocks):
        result = pipeline.process_block(block)
        gated = pipeline.apply_gating(result["rawScores"], thresholds, debounce_frames)
        vad_mean, vad_frames = vad.score_block(block)
        records.append({**result, "gatedScores": gated, "vad": vad_mean,
                        "vadFrames": vad_frames, "block": index})

    # The whole point of the exercise: does the algorithm as described above
    # actually match the library it was read out of?
    print("cross-checking against openwakeword.Model ...")
    reference = library_scores(
        blocks,
        args.start_model,
        args.stop_model,
        thresholds,
        args.refractory_seconds,
    )
    worst = 0.0
    worst_at = -1
    for index, (ours, theirs) in enumerate(zip(records, reference)):
        for name in wake_models:
            delta = abs(ours["gatedScores"][name] - theirs[name])
            if delta > worst:
                worst, worst_at = delta, index
    print(f"  worst disagreement: {worst:.3e} at block {worst_at}")
    if worst > args.tolerance:
        print(
            f"FAIL: reference implementation diverges from openWakeWord "
            f"by {worst:.3e} (tolerance {args.tolerance:.1e}). "
            "Fixture not written.",
            file=sys.stderr,
        )
        return 1

    digest = hashlib.sha256(wav_path.read_bytes()).hexdigest()

    def rounded(values, places: int = 6):
        return [round(float(v), places) for v in values]

    fixture = {
        "$comment": (
            "Generated by client/tools/make_golden_vectors.py. Do not hand-edit. "
            "Cross-checked against openwakeword.Model at generation time; see the "
            "script docstring for what that check covers."
        ),
        "generator": "client/tools/make_golden_vectors.py",
        "input": {
            "file": "input.wav",
            "sha256": digest,
            "sampleRate": SAMPLE_RATE,
            "samples": int(samples.shape[0]),
            "blocks": len(blocks),
            "blockSamples": BLOCK_SAMPLES,
            "synthetic": args.input is None,
        },
        "config": {
            "startModel": args.start_model,
            "stopModel": args.stop_model,
            "thresholds": thresholds,
            "refractorySeconds": args.refractory_seconds,
            "debounceFrames": debounce_frames,
            "warmupFrames": WARMUP_FRAMES,
            "featureSeed": "silence",
            "featureSeedSamples": SEED_SAMPLES,
        },
        "models": {
            role: {
                "file": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for role, path in model_files.items()
        },
        "shapes": {
            "melWindowFrames": MEL_WINDOW_FRAMES,
            "melBins": MEL_BINS,
            "melBufferMaxFrames": MEL_BUFFER_MAX_FRAMES,
            "embeddingDims": EMBEDDING_DIMS,
            "featureBufferMaxFrames": FEATURE_BUFFER_MAX_FRAMES,
            "classifierFrames": CLASSIFIER_FRAMES,
            "vadFrameSamples": VAD_FRAME_SAMPLES,
        },
        "seedFeatureFrames": pipeline.seed_frames,
        "probes": build_probes(pipeline, thresholds, debounce_frames),
        # Per-block, for every block: enough to localize a divergence to a
        # stage. A port that gets the mel right and the embedding wrong looks
        # different here from one that gets the classifier window wrong.
        "blocks": [
            {
                "block": r["block"],
                "melFrameCount": len(r["melFrames"]),
                "melBufferFrames": r["melBufferFrames"],
                "featureBufferFrames": r["featureBufferFrames"],
                "embedding": rounded(r["embedding"]) if r["embedding"] else None,
                "rawScores": {k: round(v, 6) for k, v in r["rawScores"].items()},
                "gatedScores": {k: round(v, 6) for k, v in r["gatedScores"].items()},
                "vad": round(r["vad"], 6),
            }
            for r in records
        ],
        # Full mel slabs for a handful of blocks. Block 0 is the short-window
        # edge case; the rest sample the different signal regions.
        "melSlabs": {
            str(i): [rounded(frame) for frame in records[i]["melFrames"]]
            for i in (0, 1, 2, 12, 24, 36)
            if i < len(records)
        },
        # Per-frame VAD probabilities for the same blocks, to separate a framing
        # bug from a state-carry bug.
        "vadSlabs": {
            str(i): rounded(records[i]["vadFrames"])
            for i in (0, 1, 2, 12, 24, 36)
            if i < len(records)
        },
    }

    out_path = args.out_dir / "golden.json"
    out_path.write_text(json.dumps(fixture, indent=1) + "\n")
    print(f"wrote {out_path} ({out_path.stat().st_size / 1024:.0f} KiB)")
    print(f"wrote {wav_path} ({wav_path.stat().st_size / 1024:.0f} KiB)")

    fired = [
        (r["block"], name, score)
        for r in records
        for name, score in r["gatedScores"].items()
        if score >= thresholds[name]
    ]
    if fired:
        print(f"detections in fixture: {fired}")
    else:
        peak = max(
            (max(r["rawScores"].values()), r["block"]) for r in records
        )
        print(
            f"no detections in this signal (peak raw score {peak[0]:.4f} at block "
            f"{peak[1]}) — expected for the synthetic input; see --input"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
