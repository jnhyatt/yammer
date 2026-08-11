"""Client configuration, entirely from the environment.

Everything the requirements doc expects to change is a variable here rather than
a literal in code: the wake-word model paths, thresholds, and the server URL and
token.

A `.env` beside the package populates the environment first, without overriding
anything already set — see `env.py`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .env import EnvError, load_env_file


class ConfigError(Exception):
    """Configuration is missing or unusable."""


@dataclass(frozen=True, slots=True)
class WakeWordConfig:
    # Either a bundled openWakeWord model name ("hey_jarvis") or a path to a
    # custom-trained .onnx. v1 ships with the bundled pair; the eventual
    # "hey yammer" / "yammer stop" models are a drop-in swap.
    start_model: str
    stop_model: str
    start_threshold: float
    stop_threshold: float
    # How much audio to drop from the end of the buffer when the stop word
    # fires. openWakeWord reports that a word was detected, not where it began,
    # so this is a fixed trim rather than a precise boundary. Too small and the
    # stop word reaches OpenCode as part of the prompt; too large and it eats
    # the end of the sentence.
    stop_trim_seconds: float
    # Ignore repeat detections within this window, so one spoken wake word
    # doesn't fire across several consecutive frames.
    refractory_seconds: float


@dataclass(frozen=True, slots=True)
class VadConfig:
    """Silero VAD, used only for the permission answer window.

    Not a general end-of-utterance detector — see vad.py on why that stays out
    of scope.
    """

    # Speech probability above which a frame counts as voiced. Silero is well
    # calibrated around 0.5; raise it in a noisy room.
    threshold: float
    # Consecutive voiced capture blocks (80 ms each) needed to open the window.
    # Two is enough to reject a cough without clipping a word.
    onset_blocks: int
    # Trailing silence that closes the window. Long enough to survive the pause
    # inside "always... allow", short enough not to feel laggy.
    silence_seconds: float
    # Audio kept from before onset and prepended to the answer. Onset detection
    # lags, so without this a one-word answer loses its first syllable.
    preroll_seconds: float
    # How long the window waits for any speech at all before telling the server
    # nobody answered. The server has its own, slightly longer deadline as the
    # backstop; this one just lets it reprompt sooner.
    answer_seconds: float


@dataclass(frozen=True, slots=True)
class Config:
    server_url: str
    token: str
    wake: WakeWordConfig
    vad: VadConfig
    input_device: str | int | None
    output_device: str | int | None
    log_level: str
    # The `.env` that was loaded, or None. Reported at startup so a token that
    # isn't taking effect is diagnosable without guessing.
    env_file: Path | None


def _required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise ConfigError(f"missing required environment variable {name}")
    return value


def _optional(name: str, fallback: str) -> str:
    value = os.environ.get(name, "")
    return value or fallback


def _float(name: str, fallback: float) -> float:
    raw = os.environ.get(name, "")
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


def _device(name: str) -> str | int | None:
    """Device selectors may be an index or a substring of the device name."""
    raw = os.environ.get(name, "")
    if not raw:
        return None
    return int(raw) if raw.lstrip("-").isdigit() else raw


def load_config() -> Config:
    # Before any read of os.environ below, and non-overriding, so an explicit
    # `FOO=bar yammer-client` still beats the file.
    try:
        env_file = load_env_file()
    except EnvError as exc:
        raise ConfigError(str(exc)) from exc

    return Config(
        env_file=env_file,
        server_url=_optional("YAMMER_SERVER_URL", "ws://127.0.0.1:8765"),
        token=_required("YAMMER_TOKEN"),
        wake=WakeWordConfig(
            start_model=_optional("YAMMER_WAKE_START_MODEL", "hey_jarvis"),
            stop_model=_optional("YAMMER_WAKE_STOP_MODEL", "alexa"),
            start_threshold=_float("YAMMER_WAKE_START_THRESHOLD", 0.5),
            stop_threshold=_float("YAMMER_WAKE_STOP_THRESHOLD", 0.5),
            stop_trim_seconds=_float("YAMMER_WAKE_STOP_TRIM_SECONDS", 0.7),
            refractory_seconds=_float("YAMMER_WAKE_REFRACTORY_SECONDS", 1.5),
        ),
        vad=VadConfig(
            threshold=_float("YAMMER_VAD_THRESHOLD", 0.5),
            onset_blocks=int(_float("YAMMER_VAD_ONSET_BLOCKS", 2)),
            silence_seconds=_float("YAMMER_VAD_SILENCE_SECONDS", 0.8),
            preroll_seconds=_float("YAMMER_VAD_PREROLL_SECONDS", 0.4),
            answer_seconds=_float("YAMMER_VAD_ANSWER_SECONDS", 10.0),
        ),
        input_device=_device("YAMMER_INPUT_DEVICE"),
        output_device=_device("YAMMER_OUTPUT_DEVICE"),
        log_level=_optional("YAMMER_LOG_LEVEL", "INFO").upper(),
    )
