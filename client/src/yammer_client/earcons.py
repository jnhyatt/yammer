"""Earcons — the system's only status channel.

With no screen and no keyboard, these carry everything the user knows about
what state Yammer is in. The five are deliberately distinguishable from each
other and from synthesized speech:

    start       two rising tones      "I'm listening"
    stop        two falling tones     "got it, working"
    busy        low double blip       "I'm still on the last one"
    error       descending buzz       "that failed"
    permission  rising two-note query "answer me before I do this"

The permission earcon exists even though the supervisor's second voice already
signals a question: the earcon lands in a few hundred milliseconds, before any
speech has been synthesized, and it is what tells the user to stop talking and
start listening.

They are synthesized rather than shipped as audio files so they always match
the playback rate the server declared, whatever that is.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

# Loud enough to hear over a room, quiet enough not to startle next to speech.
AMPLITUDE = 0.28


def _tone(freq: float, seconds: float, rate: int, *, fade: float = 0.008) -> np.ndarray:
    """A sine burst with short fades, so it clicks at neither end."""
    samples = int(seconds * rate)
    t = np.arange(samples, dtype=np.float32) / rate
    wave = np.sin(2.0 * np.pi * freq * t, dtype=np.float32)

    ramp = max(1, int(fade * rate))
    if samples > 2 * ramp:
        envelope = np.ones(samples, dtype=np.float32)
        envelope[:ramp] = np.linspace(0.0, 1.0, ramp, dtype=np.float32)
        envelope[-ramp:] = np.linspace(1.0, 0.0, ramp, dtype=np.float32)
        wave *= envelope

    return wave


def _silence(seconds: float, rate: int) -> np.ndarray:
    return np.zeros(int(seconds * rate), dtype=np.float32)


def _sweep(start: float, end: float, seconds: float, rate: int) -> np.ndarray:
    """Linear frequency sweep — reads as a single gesture rather than two notes."""
    samples = int(seconds * rate)
    t = np.arange(samples, dtype=np.float32) / rate
    freq = np.linspace(start, end, samples, dtype=np.float32)
    phase = 2.0 * np.pi * np.cumsum(freq, dtype=np.float32) / rate
    wave = np.sin(phase, dtype=np.float32)

    ramp = max(1, int(0.008 * rate))
    if samples > 2 * ramp:
        envelope = np.ones(samples, dtype=np.float32)
        envelope[:ramp] = np.linspace(0.0, 1.0, ramp, dtype=np.float32)
        envelope[-ramp:] = np.linspace(1.0, 0.0, ramp, dtype=np.float32)
        wave *= envelope
    return wave


def _to_pcm(wave: np.ndarray) -> bytes:
    scaled = np.clip(wave * AMPLITUDE, -1.0, 1.0)
    return (scaled * 32767.0).astype("<i2").tobytes()


@lru_cache(maxsize=None)
def start_record(rate: int) -> bytes:
    """Rising major third. Opens upward: something has begun."""
    return _to_pcm(
        np.concatenate(
            [_tone(660.0, 0.07, rate), _silence(0.02, rate), _tone(880.0, 0.09, rate)]
        )
    )


@lru_cache(maxsize=None)
def stop_record(rate: int) -> bytes:
    """The same interval inverted. Closes downward: handed off."""
    return _to_pcm(
        np.concatenate(
            [_tone(880.0, 0.07, rate), _silence(0.02, rate), _tone(660.0, 0.09, rate)]
        )
    )


@lru_cache(maxsize=None)
def busy(rate: int) -> bytes:
    """Low, flat, repeated — a closed door, not a failure."""
    return _to_pcm(
        np.concatenate(
            [_tone(330.0, 0.06, rate), _silence(0.05, rate), _tone(330.0, 0.06, rate)]
        )
    )


@lru_cache(maxsize=None)
def permission(rate: int) -> bytes:
    """Two rising notes ending on an unresolved interval — an audible question.

    Deliberately not the start-record earcon: that one means "I am recording
    what you say next", this one means "I am blocked until you answer". They sit
    in different registers so a half-heard one is still unambiguous.
    """
    return _to_pcm(
        np.concatenate(
            [
                _tone(520.0, 0.08, rate),
                _silence(0.03, rate),
                _tone(740.0, 0.08, rate),
                _silence(0.03, rate),
                _tone(990.0, 0.12, rate),
            ]
        )
    )


@lru_cache(maxsize=None)
def error(rate: int) -> bytes:
    """A long fall. Unmistakably different from the two-tone pair."""
    return _to_pcm(_sweep(440.0, 180.0, 0.35, rate))
