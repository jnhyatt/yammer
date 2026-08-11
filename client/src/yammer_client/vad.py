"""Voice activity detection for the permission answer window.

Answers to a permission prompt are not wake-word bracketed — saying "hey jarvis
approve alexa" is absurd, and the fixed stop-word trim would swallow a one-word
answer whole. So the window is delimited by speech itself: it opens when the
server asks, starts capturing when the user starts talking, and closes on
trailing silence.

**This deliberately does not replace the two-wake-word bracket on the main
utterance path.** Adaptive end-of-utterance detection is on the requirements
doc's non-goals list, and for good reason — VAD thresholds are twitchy in a way
wake words are not. Its scope here is one short answer to a direct question.

The model is Silero, which openWakeWord already ships and already has an ONNX
runtime loaded for, so this costs no new dependency and no new download. Note
that the bundled copy is Silero **v4**, whose `predict()` takes a configurable
`frame_size` and requires the input length to be an exact multiple of it. Our
capture blocks are 1280 samples, so 320 (20 ms) and 640 (40 ms) both divide
evenly; the 512-sample framing that Silero v5 insists on does not apply here.
"""

from __future__ import annotations

import logging
from collections import deque

import numpy as np

from .config import VadConfig

log = logging.getLogger(__name__)

# Divides 1280 evenly (4 frames per capture block). 20 ms is a good tradeoff:
# fine enough to catch onset quickly, coarse enough to be stable.
FRAME_SAMPLES = 320


class VadError(Exception):
    """The VAD model could not be loaded."""


class SpeechGate:
    """Tracks speech onset and offset across a stream of capture blocks.

    Onset needs several consecutive speech frames so a cough or a key press
    doesn't open the window; offset needs a longer run of silence so a pause
    between "approve" and nothing doesn't close it early.
    """

    def __init__(self, config: VadConfig) -> None:
        self._config = config

        try:
            from openwakeword.vad import VAD
        except ImportError as exc:  # pragma: no cover - import guard
            raise VadError(f"openwakeword's VAD is not importable: {exc}") from exc

        try:
            self._vad = VAD()
        except Exception as exc:
            raise VadError(f"could not load the Silero VAD model: {exc}") from exc

        self._speaking = False
        self._speech_run = 0
        self._silence_run = 0

        # Onset detection lags by design, so a one-word answer would lose its
        # first syllable without this. Everything here is prepended to the
        # buffer when speech starts.
        preroll_blocks = max(1, int(config.preroll_seconds / _block_seconds()))
        self._preroll: deque[bytes] = deque(maxlen=preroll_blocks)

        log.info(
            "VAD ready: threshold=%.2f onset=%d blocks silence=%.2fs preroll=%d blocks",
            config.threshold,
            config.onset_blocks,
            config.silence_seconds,
            preroll_blocks,
        )

    def reset(self) -> None:
        """Clear state between answer windows."""
        self._speaking = False
        self._speech_run = 0
        self._silence_run = 0
        self._preroll.clear()
        self._vad.reset_states()

    @property
    def speaking(self) -> bool:
        return self._speaking

    def preroll(self) -> bytes:
        """Audio captured just before onset. Consumed when the window opens."""
        return b"".join(self._preroll)

    def score(self, block: bytes) -> float:
        samples = np.frombuffer(block, dtype=np.int16)
        return float(self._vad.predict(samples, frame_size=FRAME_SAMPLES))

    def process(self, block: bytes) -> str:
        """Feed one capture block.

        Returns `"start"` on speech onset, `"end"` on trailing silence after
        speech, and `""` otherwise.
        """
        voiced = self.score(block) >= self._config.threshold

        if not self._speaking:
            self._preroll.append(block)
            self._speech_run = self._speech_run + 1 if voiced else 0
            if self._speech_run >= self._config.onset_blocks:
                self._speaking = True
                self._silence_run = 0
                return "start"
            return ""

        if voiced:
            self._silence_run = 0
            return ""

        self._silence_run += 1
        if self._silence_run * _block_seconds() >= self._config.silence_seconds:
            self._speaking = False
            self._speech_run = 0
            return "end"
        return ""


def _block_seconds() -> float:
    from .audio import BLOCK_SAMPLES
    from .protocol import CAPTURE_FORMAT

    return BLOCK_SAMPLES / CAPTURE_FORMAT.rate
