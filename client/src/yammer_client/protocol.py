"""Wire protocol types and codecs.

Mirrors protocol/PROTOCOL.md and server/src/protocol.ts. All three change
together — this is a cross-language contract, not a shared type definition.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any, Final

PROTOCOL_VERSION: Final = 2

CLIENT_ID: Final = "yammer-client/0.1.0"


# Application-specific WebSocket close codes.
class CloseCode:
    AUTH_FAILED: Final = 4001
    UNSUPPORTED_PROTOCOL: Final = 4002
    PROTOCOL_VIOLATION: Final = 4003
    ALREADY_CONNECTED: Final = 4004


CLOSE_REASONS: Final[dict[int, str]] = {
    CloseCode.AUTH_FAILED: "the server rejected the token",
    CloseCode.UNSUPPORTED_PROTOCOL: "the server speaks a different protocol version",
    CloseCode.PROTOCOL_VIOLATION: "the server reported a protocol violation",
    CloseCode.ALREADY_CONNECTED: "another client is already connected",
}


@dataclass(frozen=True, slots=True)
class AudioFormat:
    codec: str
    rate: int
    channels: int

    def to_json(self) -> dict[str, Any]:
        return {"codec": self.codec, "rate": self.rate, "channels": self.channels}

    @staticmethod
    def from_json(raw: Any, fallback: AudioFormat) -> AudioFormat:
        if not isinstance(raw, dict):
            return fallback
        return AudioFormat(
            codec=str(raw.get("codec", fallback.codec)),
            rate=int(raw.get("rate", fallback.rate)),
            channels=int(raw.get("channels", fallback.channels)),
        )


# The client captures at this rate; the server does not resample.
CAPTURE_FORMAT: Final = AudioFormat(codec="pcm_s16le", rate=16_000, channels=1)

# Kokoro's native rate. Only a fallback — the real value arrives in hello.ok and
# must be honoured rather than assumed.
DEFAULT_SPEECH_FORMAT: Final = AudioFormat(codec="pcm_s16le", rate=24_000, channels=1)


class ProtocolError(Exception):
    """The peer sent something that violates PROTOCOL.md."""


# --- Client → Server -------------------------------------------------------


def hello(token: str) -> str:
    return json.dumps(
        {
            "t": "hello",
            "proto": PROTOCOL_VERSION,
            "token": token,
            "client": CLIENT_ID,
            "audio": CAPTURE_FORMAT.to_json(),
        }
    )


def utterance_begin(turn: int) -> str:
    return json.dumps({"t": "utterance.begin", "turn": turn})


def utterance_end(turn: int) -> str:
    return json.dumps({"t": "utterance.end", "turn": turn})


def utterance_cancel(turn: int, reason: str) -> str:
    return json.dumps({"t": "utterance.cancel", "turn": turn, "reason": reason})


def answer_begin(turn: int, request_id: str) -> str:
    """The user has started answering a permission prompt; audio frames follow.

    Answers reuse the ordinary turn-tagged binary frames — an answer happens
    inside a turn, so it carries the request id rather than a tag of its own.
    """
    return json.dumps({"t": "answer.begin", "turn": turn, "id": request_id})


def answer_end(turn: int, request_id: str) -> str:
    return json.dumps({"t": "answer.end", "turn": turn, "id": request_id})


def answer_timeout(turn: int, request_id: str) -> str:
    """The answer window closed with no speech in it at all."""
    return json.dumps({"t": "answer.timeout", "turn": turn, "id": request_id})


# --- Framing ---------------------------------------------------------------

_HEADER = struct.Struct("<I")


def encode_audio_frame(turn: int, pcm: bytes) -> bytes:
    """Prefix PCM with its 4-byte little-endian turn tag."""
    return _HEADER.pack(turn & 0xFFFFFFFF) + pcm


def decode_audio_frame(data: bytes) -> tuple[int, bytes]:
    """Split a binary frame into its turn tag and PCM payload."""
    if len(data) < _HEADER.size:
        raise ProtocolError("binary frame shorter than its header")
    (turn,) = _HEADER.unpack_from(data, 0)
    return turn, data[_HEADER.size :]


def decode_server_message(raw: str) -> dict[str, Any]:
    """Parse a control frame, validating only that it is a tagged object."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"control frame is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ProtocolError("control frame is not an object")
    if not isinstance(parsed.get("t"), str):
        raise ProtocolError("control frame has no message type")
    return parsed
