"""Wake-word detection.

Two distinct words bracket an utterance: one starts recording, one stops it.
Detection scans continuously and can fire on the word appearing anywhere in the
stream — it is not anchored to utterance start.

The stop word is authoritative: the server never decides on its own when an
utterance is finished.
"""

from __future__ import annotations

import enum
import logging
import os
from dataclasses import dataclass

import numpy as np

from .config import WakeWordConfig

log = logging.getLogger(__name__)


class Wake(enum.Enum):
    START = "start"
    STOP = "stop"


@dataclass(frozen=True, slots=True)
class Detection:
    which: Wake
    score: float


class WakeWordError(Exception):
    """A wake-word model could not be loaded."""


def _model_key(identifier: str) -> str:
    """The key openWakeWord will use for a model in its prediction dict.

    Bundled models are keyed by their name; custom models by the filename stem.
    """
    if os.path.sep in identifier or identifier.endswith((".onnx", ".tflite")):
        return os.path.splitext(os.path.basename(identifier))[0]
    return identifier


class WakeWordDetector:
    """Feeds capture blocks to openWakeWord and reports threshold crossings."""

    def __init__(self, config: WakeWordConfig) -> None:
        self._config = config
        self._start_key = _model_key(config.start_model)
        self._stop_key = _model_key(config.stop_model)
        self._thresholds = {
            self._start_key: config.start_threshold,
            self._stop_key: config.stop_threshold,
        }

        if self._start_key == self._stop_key:
            raise WakeWordError(
                "start and stop wake words must be different models, both resolve to "
                f"{self._start_key!r}"
            )

        try:
            from openwakeword.model import Model
        except ImportError as exc:  # pragma: no cover - import guard
            raise WakeWordError(f"openwakeword is not importable: {exc}") from exc

        try:
            self._model = Model(
                wakeword_models=[config.start_model, config.stop_model],
                inference_framework="onnx",
            )
        except Exception as exc:
            raise WakeWordError(
                f"could not load wake-word models {config.start_model!r} and "
                f"{config.stop_model!r}: {exc}. If these are bundled models, run "
                "`python -c 'import openwakeword.utils as u; u.download_models()'` first."
            ) from exc

        # `models` holds the loaded models; `prediction_buffer` is populated
        # lazily on first predict() and is empty here.
        available = set(self._model.models.keys())
        missing = {self._start_key, self._stop_key} - available
        if missing:
            raise WakeWordError(
                f"loaded models are keyed {sorted(available)}, expected "
                f"{sorted({self._start_key, self._stop_key})}; missing {sorted(missing)}"
            )

        log.info(
            "wake words ready: start=%s stop=%s", self._start_key, self._stop_key
        )

    def process(self, block: bytes) -> Detection | None:
        """Score one capture block. Returns a detection on a threshold crossing.

        `debounce_time` suppresses repeat fires from a single spoken word, which
        would otherwise trigger across several consecutive frames. openWakeWord
        requires `threshold` whenever debouncing is used — it zeroes debounced
        scores itself, and needs to know what counts as a hit to do that.
        """
        samples = np.frombuffer(block, dtype=np.int16)
        scores = self._model.predict(
            samples,
            threshold=self._thresholds,
            debounce_time=self._config.refractory_seconds,
        )

        start_score = float(scores.get(self._start_key, 0.0))
        stop_score = float(scores.get(self._stop_key, 0.0))

        # Check the higher score first so that if both cross in the same block
        # (a rare near-simultaneous match) the stronger one wins rather than
        # start always taking precedence.
        if start_score >= stop_score:
            if start_score >= self._config.start_threshold:
                return Detection(Wake.START, start_score)
            if stop_score >= self._config.stop_threshold:
                return Detection(Wake.STOP, stop_score)
        else:
            if stop_score >= self._config.stop_threshold:
                return Detection(Wake.STOP, stop_score)
            if start_score >= self._config.start_threshold:
                return Detection(Wake.START, start_score)
        return None

    def reset(self) -> None:
        """Clear internal buffers, e.g. after a turn ends.

        Without this, audio from before the reset can still contribute to a
        detection afterwards.
        """
        self._model.reset()
