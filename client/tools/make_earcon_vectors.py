#!/usr/bin/env python3
"""Generate the cross-language golden vectors for the earcons.

Why this exists
---------------
Earcons are the system's only status channel — with no screen and no keyboard,
they carry everything the user knows about what state Yammer is in. The Android
client synthesizes them from the same sine math as the desktop client, and a
port that drifts is another *silent* failure: a wrong ramp length or a segment
truncated one sample short still produces five audible, plausible beeps. You
find out that "stop" and "start" have stopped being distinguishable by
misreading the system's state, not by reading a stack trace.

Unlike the wake-word fixture, there is no second implementation here to
cross-check against: `client/src/yammer_client/earcons.py` *is* the reference.
So this script imports that module rather than reimplementing it, which means
the fixture is by construction the audio the desktop client plays. Change the
earcons and the fixture changes with them; that diff is the signal that the
Kotlin port needs the same change.

What's recorded
---------------
For each earcon, at each rate: the whole PCM buffer (base64, little-endian
int16), the sample count, the peak, and the segment layout the earcon was
concatenated from.

The segment layout is the load-bearing part for the rates. Every duration in
`earcons.py` is a float count of seconds turned into samples by `int(seconds *
rate)`, so at some rates segments truncate and at others they don't — 0.07 s is
1120 samples at 16 kHz but 1543.5 truncated to 1543 at 22.05 kHz. Recording the
per-segment counts pins that arithmetic directly instead of leaving it to be
inferred from a total length that several different bugs produce.

Three rates, chosen for what they catch:

    24000   Kokoro's native rate — the one that actually plays
    16000   the capture rate; every duration lands on a whole sample
    22050   nothing divides evenly, so truncation shows up everywhere

Tolerance
---------
The comparison this feeds is **not** byte-exact, and shouldn't be. `np.sin` on
float32 and Kotlin's `sin(Double).toFloat()` may differ by an ulp, and the final
`.astype("<i2")` truncates toward zero — so a sample whose scaled value lands
within an ulp of an integer boundary can legitimately truncate to either side.
At these amplitudes that is a handful of samples per earcon, each off by one
LSB, which is 90 dB below the signal and inaudible. The Kotlin tests allow ±1
and assert exact equality on everything structural: lengths, segment
boundaries, and that the silences are digital zero.

Usage
-----
    cd client
    .venv/bin/python tools/make_earcon_vectors.py
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from yammer_client import earcons  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "fixtures" / "earcons" / "golden.json"

# See the module docstring for why these three.
RATES = (16_000, 22_050, 24_000)

# The segment layout of each earcon, mirroring the `np.concatenate` calls in
# `earcons.py`. Durations only — the sample counts are computed per rate, which
# is the point. `("sweep", start_hz, end_hz, seconds)` for the one glissando.
LAYOUTS: dict[str, tuple[tuple, ...]] = {
    "start_record": (
        ("tone", 660.0, 0.07),
        ("silence", 0.02),
        ("tone", 880.0, 0.09),
    ),
    "stop_record": (
        ("tone", 880.0, 0.07),
        ("silence", 0.02),
        ("tone", 660.0, 0.09),
    ),
    "busy": (
        ("tone", 330.0, 0.06),
        ("silence", 0.05),
        ("tone", 330.0, 0.06),
    ),
    "permission": (
        ("tone", 520.0, 0.08),
        ("silence", 0.03),
        ("tone", 740.0, 0.08),
        ("silence", 0.03),
        ("tone", 990.0, 0.12),
    ),
    "error": (("sweep", 440.0, 180.0, 0.35),),
}

GENERATORS = {
    "start_record": earcons.start_record,
    "stop_record": earcons.stop_record,
    "busy": earcons.busy,
    "permission": earcons.permission,
    "error": earcons.error,
}


def segments(layout: tuple[tuple, ...], rate: int) -> list[dict]:
    """Per-segment sample counts, plus the fade ramp length that applies."""
    ramp = max(1, int(0.008 * rate))
    out: list[dict] = []
    for seg in layout:
        if seg[0] == "silence":
            out.append(
                {"kind": "silence", "seconds": seg[1], "samples": int(seg[1] * rate)}
            )
        elif seg[0] == "tone":
            samples = int(seg[2] * rate)
            out.append(
                {
                    "kind": "tone",
                    "freq": seg[1],
                    "seconds": seg[2],
                    "samples": samples,
                    # The envelope is only applied when the burst is longer than
                    # both ramps; every earcon segment is, but the port has to
                    # implement the same guard.
                    "ramp": ramp if samples > 2 * ramp else 0,
                }
            )
        else:
            samples = int(seg[3] * rate)
            out.append(
                {
                    "kind": "sweep",
                    "startFreq": seg[1],
                    "endFreq": seg[2],
                    "seconds": seg[3],
                    "samples": samples,
                    "ramp": ramp if samples > 2 * ramp else 0,
                }
            )
    return out


def describe(name: str, rate: int) -> dict:
    pcm = GENERATORS[name](rate)
    samples = np.frombuffer(pcm, dtype="<i2")

    layout = segments(LAYOUTS[name], rate)
    total = sum(seg["samples"] for seg in layout)
    if total != len(samples):
        raise SystemExit(
            f"{name} at {rate}: layout sums to {total} samples but the earcon is "
            f"{len(samples)}. The layout table no longer matches earcons.py."
        )

    # Silences must be digital zero, and it must be *exactly* zero rather than a
    # decayed tail — the port concatenating a nonzero gap would still sound fine.
    offset = 0
    silences = []
    for seg in layout:
        if seg["kind"] == "silence":
            chunk = samples[offset : offset + seg["samples"]]
            if np.any(chunk != 0):
                raise SystemExit(f"{name} at {rate}: silence segment is not zero")
            silences.append([offset, offset + seg["samples"]])
        offset += seg["samples"]

    return {
        "samples": len(samples),
        "peak": int(np.max(np.abs(samples))) if len(samples) else 0,
        "segments": layout,
        "silences": silences,
        "pcmBase64": base64.b64encode(pcm).decode("ascii"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="regenerate and compare against the checked-in fixture without writing",
    )
    args = parser.parse_args()

    fixture = {
        "note": (
            "Generated by client/tools/make_earcon_vectors.py from "
            "client/src/yammer_client/earcons.py. Compare with a tolerance of 1 "
            "LSB on sample values and none at all on lengths, segment "
            "boundaries or silences — see the generator's docstring."
        ),
        "amplitude": earcons.AMPLITUDE,
        "fadeSeconds": 0.008,
        "rates": list(RATES),
        "earcons": {
            name: {str(rate): describe(name, rate) for rate in RATES}
            for name in GENERATORS
        },
    }

    text = json.dumps(fixture, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not OUT.exists():
            print(f"{OUT} does not exist", file=sys.stderr)
            return 1
        if OUT.read_text() != text:
            print(f"{OUT} differs from a fresh generation", file=sys.stderr)
            return 1
        print(f"{OUT} is up to date")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)

    total = sum(
        entry["samples"]
        for per_rate in fixture["earcons"].values()
        for entry in per_rate.values()
    )
    print(f"wrote {OUT} — {len(GENERATORS)} earcons × {len(RATES)} rates, {total} samples")
    for name, per_rate in fixture["earcons"].items():
        shape = ", ".join(
            f"{rate} Hz: {entry['samples']} samples peak {entry['peak']}"
            for rate, entry in sorted(per_rate.items())
        )
        print(f"  {name:<13} {shape}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
