#!/usr/bin/env python3
"""Measure the bandwidth of a WAV captured by the Android client.

Why this exists
---------------
"The microphone works" is not something you can establish by listening. A
Bluetooth headset on the classic HFP/SCO profile gives you 8 kHz of audio
resampled up to whatever rate you asked for: it plays back at the right speed,
it sounds like a phone call, and every sample above 4 kHz is interpolation. That
bandwidth is not recoverable downstream of the codec — no amount of work on the
wake word gets it back — so the *only* moment to catch it is here, by looking at
the spectrum of a real capture.

This is the desktop half of Phase 2's done-when. The phone records; this decides
whether what it recorded is full-bandwidth.

    LE Audio (LC3)          content up to ~7-8 kHz, no cliff
    classic SCO wideband    nothing above ~3.7 kHz, hard cliff
    classic SCO narrowband  nothing above ~3.4 kHz, hard cliff

The verdict looks for the cliff rather than for absolute energy, because a quiet
recording of a quiet room is also mostly low-frequency — but a real cliff is an
abrupt floor that a room does not produce.

Usage
-----
    adb pull /sdcard/Android/data/dev.yammer.android/files/capture-....wav
    cd android
    ../client/.venv/bin/python tools/check_capture.py capture-....wav

Needs numpy, which the client venv already has; there is no separate
environment for this.
"""

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

import numpy as np

# Speech energy above this is what a narrowband codec removes. Nyquist for the
# 8 kHz sample rate SCO actually carries is 4 kHz, so anything genuinely present
# above it means we are not on that path.
SCO_CLIFF_HZ = 4_000

# A band that a full-bandwidth capture reaches and a resampled one cannot.
WIDE_BAND = (4_500, 7_500)

# Below this, relative to the peak band, a band is "empty" rather than "quiet".
EMPTY_DB = -55.0


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        if wav.getsampwidth() != 2:
            raise SystemExit(f"{path}: {wav.getsampwidth() * 8}-bit samples, expected 16")
        rate = wav.getframerate()
        channels = wav.getnchannels()
        raw = wav.readframes(wav.getnframes())
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def spectrum(samples: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray]:
    """Average power spectrum over Hann-windowed half-overlapping frames."""
    size = 2048
    if len(samples) < size:
        raise SystemExit(f"only {len(samples)} samples; need at least {size}")
    window = np.hanning(size)
    frames = []
    for start in range(0, len(samples) - size, size // 2):
        frames.append(np.abs(np.fft.rfft(samples[start : start + size] * window)) ** 2)
    power = np.mean(frames, axis=0)
    freqs = np.fft.rfftfreq(size, 1.0 / rate)
    return freqs, power


def band_db(freqs: np.ndarray, power: np.ndarray, low: float, high: float, ref: float) -> float:
    band = power[(freqs >= low) & (freqs < high)]
    if band.size == 0:
        return float("-inf")
    mean = band.mean()
    return 10 * np.log10(mean / ref) if mean > 0 and ref > 0 else float("-inf")


def find_cliff(freqs: np.ndarray, power: np.ndarray, ref: float) -> float | None:
    """The lowest frequency above which everything stays below [EMPTY_DB]."""
    db = 10 * np.log10(np.maximum(power, 1e-30) / ref)
    above = db < EMPTY_DB
    # Walk down from Nyquist to the first bin that is *not* empty; everything
    # above it is the dead band.
    last_live = None
    for i in range(len(db) - 1, -1, -1):
        if not above[i]:
            last_live = i
            break
    if last_live is None or last_live == len(db) - 1:
        return None
    return float(freqs[last_live])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path, help="a WAV pulled from the phone")
    parser.add_argument(
        "--plot",
        type=Path,
        help="also write the spectrum as a PNG (needs matplotlib)",
    )
    args = parser.parse_args()

    if not args.wav.exists():
        raise SystemExit(f"{args.wav} does not exist")

    samples, rate = read_wav(args.wav)
    seconds = len(samples) / rate
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    rms = float(np.sqrt(np.mean(samples**2))) if len(samples) else 0.0

    print(f"{args.wav.name}")
    print(f"  {len(samples)} samples, {seconds:.2f}s at {rate} Hz")
    print(f"  peak {peak:.0f} ({20 * np.log10(max(peak, 1) / 32768):.1f} dBFS), "
          f"rms {rms:.1f} ({20 * np.log10(max(rms, 1e-9) / 32768):.1f} dBFS)")

    if peak == 0:
        print("\nVERDICT: silence. The microphone gave nothing at all.")
        return 1
    if rms < 30:
        print("\n  Very quiet — the bandwidth verdict below may not mean much.")

    freqs, power = spectrum(samples, rate)
    ref = float(power.max())

    print("\n  band            level")
    bands = [(0, 500), (500, 1000), (1000, 2000), (2000, 3000), (3000, 4000),
             (4000, 5000), (5000, 6000), (6000, 7000), (7000, int(rate // 2))]
    for low, high in bands:
        if low >= rate // 2:
            break
        level = band_db(freqs, power, low, high, ref)
        bar = "#" * max(0, int((level + 80) / 4))
        print(f"  {low:>5}-{high:<5} Hz  {level:7.1f} dB  {bar}")

    wide = band_db(freqs, power, WIDE_BAND[0], min(WIDE_BAND[1], rate // 2 - 1), ref)
    cliff = find_cliff(freqs, power, ref)

    print()
    if rate <= 2 * SCO_CLIFF_HZ:
        print(f"VERDICT: inconclusive — the file itself is only {rate} Hz, so there")
        print("is nothing above 4 kHz to look for. Record at 16 kHz.")
        return 1

    if cliff is not None and cliff < SCO_CLIFF_HZ + 500:
        print(f"VERDICT: BAND-LIMITED. Nothing above {cliff:.0f} Hz.")
        print("This is the classic-Bluetooth telephony path (HFP/SCO), not LE Audio.")
        print("The capture source or the routing is wrong — check which device the")
        print("app reported it was routed to. This audio cannot be repaired later.")
        return 1

    if wide < EMPTY_DB:
        print(f"VERDICT: BAND-LIMITED. The {WIDE_BAND[0]}-{WIDE_BAND[1]} Hz band is "
              f"{wide:.1f} dB down.")
        print("Either the stream is band-limited or the recording has no high-frequency")
        print("content in it — try again with some consonants ('sixty-six, fifty-five').")
        return 1

    print(f"VERDICT: FULL BANDWIDTH. The {WIDE_BAND[0]}-{WIDE_BAND[1]} Hz band is "
          f"{wide:.1f} dB relative to the peak,")
    print(f"and content continues to {cliff or rate // 2:.0f} Hz. This is not an SCO stream.")

    if args.plot:
        try:
            import matplotlib

            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError:
            print(f"\n(--plot needs matplotlib, which is not installed)", file=sys.stderr)
            return 0
        db = 10 * np.log10(np.maximum(power, 1e-30) / ref)
        plt.figure(figsize=(9, 4))
        plt.plot(freqs, db, linewidth=0.8)
        plt.axvline(SCO_CLIFF_HZ, color="red", linestyle="--", label="SCO ceiling")
        plt.ylim(-100, 5)
        plt.xlabel("Hz")
        plt.ylabel("dB relative to peak")
        plt.title(args.wav.name)
        plt.legend()
        plt.tight_layout()
        plt.savefig(args.plot, dpi=120)
        print(f"\nwrote {args.plot}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
