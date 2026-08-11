"""Microphone capture and speaker playback.

Capture runs at the protocol's capture rate and hands fixed-size blocks to the
asyncio loop. Playback runs at whatever rate the server declared in `hello.ok`,
which is also the rate earcons are synthesized at, so both share one stream.

There is no echo cancellation and the microphone is not gated during playback:
v1 assumes headphones. Through a speaker, synthesized speech will be picked up
by the microphone and can trigger the client's own wake words.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
from typing import Any

import sounddevice as sd

from .protocol import CAPTURE_FORMAT, AudioFormat

log = logging.getLogger(__name__)

# openWakeWord expects 80 ms blocks (1280 samples at 16 kHz). Capture at exactly
# that size so detection needs no re-chunking, and reuse the same blocks as
# network frames.
BLOCK_SAMPLES = 1280
BYTES_PER_SAMPLE = 2

BLOCK_BYTES = BLOCK_SAMPLES * BYTES_PER_SAMPLE


class AudioError(Exception):
    """The audio device could not be opened or has failed."""


class Capture:
    """Microphone → asyncio queue of fixed-size int16 blocks."""

    def __init__(self, device: str | int | None) -> None:
        self._device = device
        self._stream: sd.RawInputStream | None = None

    def start(self, loop: asyncio.AbstractEventLoop, sink: asyncio.Queue[bytes]) -> None:
        def callback(indata: Any, _frames: int, _time: Any, status: Any) -> None:
            if status:
                # Overflows mean we dropped samples; the utterance is still
                # usable, so log and carry on rather than failing the turn.
                log.warning("input stream status: %s", status)
            loop.call_soon_threadsafe(sink.put_nowait, bytes(indata))

        try:
            self._stream = sd.RawInputStream(
                samplerate=CAPTURE_FORMAT.rate,
                blocksize=BLOCK_SAMPLES,
                device=self._device,
                channels=CAPTURE_FORMAT.channels,
                dtype="int16",
                callback=callback,
            )
            self._stream.start()
        except Exception as exc:  # sounddevice raises a variety of types
            raise AudioError(f"could not open input device: {exc}") from exc

        log.info(
            "capturing at %d Hz in %d-sample blocks", CAPTURE_FORMAT.rate, BLOCK_SAMPLES
        )

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


#: Playback is written in slices this long so that `flush()` can take effect
#: mid-sentence. Writing a whole sentence in one blocking call would make the
#: shortest possible interruption the length of that sentence, which is what
#: makes barge-in feel broken rather than immediate. 40 ms is well under the
#: threshold where a cut sounds laggy, and coarse enough not to thrash the
#: device.
PLAYBACK_SLICE_MS = 40


class Playback:
    """Speaker output fed by a background writer thread.

    Earcons and speech share this queue, so an earcon queued during playback is
    heard after the current audio rather than clobbering it.
    """

    def __init__(self, device: str | int | None, fmt: AudioFormat) -> None:
        self._device = device
        self._format = fmt
        self._queue: queue.Queue[bytes | None] = queue.Queue()
        self._stream: sd.RawOutputStream | None = None
        self._thread: threading.Thread | None = None
        self._slice_bytes = max(
            1, int(fmt.rate * PLAYBACK_SLICE_MS / 1000) * BYTES_PER_SAMPLE * fmt.channels
        )

    @property
    def format(self) -> AudioFormat:
        return self._format

    def start(self) -> None:
        try:
            self._stream = sd.RawOutputStream(
                samplerate=self._format.rate,
                device=self._device,
                channels=self._format.channels,
                dtype="int16",
            )
            self._stream.start()
        except Exception as exc:
            raise AudioError(f"could not open output device: {exc}") from exc

        self._thread = threading.Thread(target=self._writer, name="yammer-playback", daemon=True)
        self._thread.start()
        log.info("playing back at %d Hz", self._format.rate)

    def _writer(self) -> None:
        while True:
            chunk = self._queue.get()
            if chunk is None:
                return
            stream = self._stream
            if stream is None:
                return
            try:
                stream.write(chunk)
            except Exception as exc:
                log.error("playback write failed: %s", exc)

    def play(self, pcm: bytes) -> None:
        """Queue PCM at the playback format's rate.

        Sliced on the way in rather than written whole: the writer thread blocks
        for the duration of each `stream.write`, so the slice size is the
        granularity at which `flush()` can interrupt playback.
        """
        for offset in range(0, len(pcm), self._slice_bytes):
            self._queue.put(pcm[offset : offset + self._slice_bytes])

    def flush(self) -> None:
        """Drop anything not yet written. Audio already handed to the device
        still plays — this bounds the interruption to roughly one slice plus the
        device's own buffer, not to zero."""
        try:
            while True:
                self._queue.get_nowait()
        except queue.Empty:
            pass

    def stop(self) -> None:
        self._queue.put(None)
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
