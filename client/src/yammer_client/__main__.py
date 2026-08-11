"""Client entrypoint."""

from __future__ import annotations

import asyncio
import logging
import sys

from .app import YammerClient
from .audio import AudioError
from .config import ConfigError, load_config
from .vad import SpeechGate, VadError
from .wakeword import WakeWordDetector, WakeWordError


def main() -> int:
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger(__name__).info("env file: %s", config.env_file or "(none)")

    try:
        # Loading before connecting keeps model failures separate from network
        # ones, which are otherwise easy to confuse at startup.
        detector = WakeWordDetector(config.wake)
    except WakeWordError as exc:
        print(f"wake-word setup failed: {exc}", file=sys.stderr)
        return 1

    try:
        gate = SpeechGate(config.vad)
    except VadError as exc:
        print(f"VAD setup failed: {exc}", file=sys.stderr)
        return 1

    client = YammerClient(config, detector, gate)
    try:
        asyncio.run(client.run())
    except AudioError as exc:
        print(f"audio error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(file=sys.stderr)
        logging.getLogger(__name__).info("interrupted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
