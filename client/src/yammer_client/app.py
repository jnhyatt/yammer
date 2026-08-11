"""Client turn state machine and transport.

    IDLE       ── start word ─────────▶ RECORDING
    RECORDING  ── stop word  ─────────▶ WAITING     (buffer flushed to the server)
    RECORDING  ── start word ─────────▶ RECORDING   (restart: discard and re-arm)
    WAITING    ── permission.ask ─────▶ ANSWERING   (VAD-delimited answer window)
    ANSWERING  ── permission.resolved ▶ WAITING
    WAITING    ── turn.end   ─────────▶ IDLE

Audio is buffered locally and flushed on the stop word rather than streamed as
it is captured. That is what makes stop-word trimming possible at all — once a
frame is on the wire it cannot be taken back.

ANSWERING is the one state where wake words are not what delimits speech. The
user is being asked a direct question and answers it with one word, so the
window is opened by the server and closed by silence — see vad.py. Wake-word
detection is suspended for its duration: "hey jarvis" is not an answer to
"approve or deny", and treating it as one would start a turn the server would
only reject.
"""

from __future__ import annotations

import asyncio
import enum
import logging
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection, connect

from . import earcons, protocol
from .audio import BLOCK_BYTES, BLOCK_SAMPLES, Capture, Playback
from .config import Config
from .protocol import (
    CLOSE_REASONS,
    CAPTURE_FORMAT,
    DEFAULT_SPEECH_FORMAT,
    AudioFormat,
    ProtocolError,
)
from .vad import SpeechGate
from .wakeword import Detection, Wake, WakeWordDetector

log = logging.getLogger(__name__)

# Audio is flushed in chunks rather than one large frame, to keep individual
# WebSocket messages a sane size.
FLUSH_CHUNK_BYTES = 16 * 1024


class State(enum.Enum):
    IDLE = "idle"
    RECORDING = "recording"
    WAITING = "waiting"
    ANSWERING = "answering"


class YammerClient:
    def __init__(
        self, config: Config, detector: WakeWordDetector, gate: SpeechGate
    ) -> None:
        self._config = config
        self._detector = detector
        self._gate = gate
        self._state = State.IDLE
        self._turn = 0
        self._buffer: list[bytes] = []
        self._playback: Playback | None = None
        self._speech_format: AudioFormat = DEFAULT_SPEECH_FORMAT

        # Permission answer state, all cleared together by _leave_answering().
        self._request_id: str | None = None
        self._answering = False
        self._answer: list[bytes] = []
        self._idle_blocks = 0

    async def run(self) -> None:
        log.info("connecting to %s", self._config.server_url)
        try:
            async with connect(self._config.server_url, max_size=None) as ws:
                await self._handshake(ws)
                await self._session(ws)
        except websockets.exceptions.ConnectionClosed as exc:
            reason = CLOSE_REASONS.get(exc.rcvd.code if exc.rcvd else 0)
            if reason:
                log.error("connection closed: %s", reason)
            else:
                log.error("connection closed: %s", exc)
        except OSError as exc:
            log.error("could not connect to %s: %s", self._config.server_url, exc)
        finally:
            if self._playback is not None:
                self._playback.stop()

    async def _handshake(self, ws: ClientConnection) -> None:
        await ws.send(protocol.hello(self._config.token))
        raw = await ws.recv()
        if isinstance(raw, bytes):
            raise ProtocolError("server sent a binary frame before hello.ok")

        msg = protocol.decode_server_message(raw)
        if msg["t"] != "hello.ok":
            raise ProtocolError(f"expected hello.ok, got {msg['t']}")

        # Honour the server's declared rate rather than assuming Kokoro's.
        self._speech_format = AudioFormat.from_json(
            msg.get("audio"), DEFAULT_SPEECH_FORMAT
        )
        log.info(
            "connected to %s, playback %d Hz",
            msg.get("server", "unknown"),
            self._speech_format.rate,
        )

        self._playback = Playback(self._config.output_device, self._speech_format)
        self._playback.start()

    async def _session(self, ws: ClientConnection) -> None:
        loop = asyncio.get_running_loop()
        blocks: asyncio.Queue[bytes] = asyncio.Queue()
        capture = Capture(self._config.input_device)
        capture.start(loop, blocks)

        log.info("listening — say the start wake word")
        try:
            await asyncio.gather(
                self._pump_microphone(ws, blocks),
                self._read_server(ws),
            )
        finally:
            capture.stop()

    # --- microphone side ---------------------------------------------------

    async def _pump_microphone(
        self, ws: ClientConnection, blocks: asyncio.Queue[bytes]
    ) -> None:
        while True:
            block = await blocks.get()

            # The answer window owns the microphone while it is open: speech is
            # delimited by the VAD, and wake words mean nothing here.
            if self._state is State.ANSWERING:
                await self._on_answer_block(ws, block)
                continue

            detection = self._detector.process(block)

            if detection is not None:
                await self._on_detection(ws, detection)
                # The block containing the wake word is deliberately not
                # buffered: for the start word it holds the word itself, and
                # for the stop word the buffer has already been flushed.
                continue

            if self._state is State.RECORDING:
                self._buffer.append(block)

    async def _on_detection(self, ws: ClientConnection, detection: Detection) -> None:
        log.debug("wake word %s (%.2f)", detection.which.value, detection.score)

        if detection.which is Wake.START:
            if self._state is State.WAITING:
                # A turn is already in flight. Reject locally so the earcon is
                # immediate; the server's own busy rejection remains the
                # authoritative backstop if the two ever disagree.
                log.info("ignoring start word, turn %d still in flight", self._turn)
                self._play(earcons.busy(self._speech_format.rate))
                return

            if self._state is State.RECORDING:
                # "Wait, let me say that again" — discard and re-arm.
                log.info("restarting utterance, discarding turn %d", self._turn)
                await ws.send(protocol.utterance_cancel(self._turn, "restart"))

            self._turn += 1
            self._buffer.clear()
            self._state = State.RECORDING
            await ws.send(protocol.utterance_begin(self._turn))
            self._play(earcons.start_record(self._speech_format.rate))
            return

        # Stop word.
        if self._state is not State.RECORDING:
            log.debug("ignoring stop word outside recording")
            return

        await self._flush(ws)

    async def _flush(self, ws: ClientConnection) -> None:
        """Trim the stop word off the tail, send the buffer, close the utterance."""
        audio = b"".join(self._buffer)
        self._buffer.clear()

        trim = self._trim_bytes()
        kept = audio[:-trim] if trim and len(audio) > trim else (b"" if trim else audio)
        log.info(
            "utterance %d: %d bytes captured, %d after trimming the stop word",
            self._turn,
            len(audio),
            len(kept),
        )

        for offset in range(0, len(kept), FLUSH_CHUNK_BYTES):
            chunk = kept[offset : offset + FLUSH_CHUNK_BYTES]
            await ws.send(protocol.encode_audio_frame(self._turn, chunk))

        await ws.send(protocol.utterance_end(self._turn))
        self._state = State.WAITING
        self._play(earcons.stop_record(self._speech_format.rate))

    # --- permission answers ------------------------------------------------

    async def _on_answer_block(self, ws: ClientConnection, block: bytes) -> None:
        """Drive the VAD-delimited answer window with one capture block."""
        request_id = self._request_id
        if request_id is None:
            return

        edge = self._gate.process(block)

        if edge == "start":
            # Barge-in: the user is answering over the supervisor, so drop
            # whatever is still queued rather than making them wait it out.
            if self._playback is not None:
                self._playback.flush()
            self._answering = True
            # Onset detection lags, so the pre-roll is what stops a one-word
            # answer arriving with its first syllable missing. It already
            # includes the block that triggered onset — appending `block` again
            # here would duplicate 80 ms of audio.
            self._answer = [self._gate.preroll()]
            await ws.send(protocol.answer_begin(self._turn, request_id))
            log.info("answering permission %s", request_id)
            return

        if self._answering:
            self._answer.append(block)
            if edge == "end":
                await self._flush_answer(ws, request_id)
            return

        # No speech yet. The server has its own deadline; this one just lets it
        # reprompt sooner when the user clearly isn't there.
        self._idle_blocks += 1
        if self._idle_blocks * _block_seconds() >= self._config.vad.answer_seconds:
            log.info("no answer heard for %s", request_id)
            self._idle_blocks = 0
            await ws.send(protocol.answer_timeout(self._turn, request_id))

    async def _flush_answer(self, ws: ClientConnection, request_id: str) -> None:
        audio = b"".join(self._answer)
        self._answer = []
        self._answering = False
        log.info("answer captured: %d bytes", len(audio))

        for offset in range(0, len(audio), FLUSH_CHUNK_BYTES):
            await ws.send(
                protocol.encode_audio_frame(self._turn, audio[offset : offset + FLUSH_CHUNK_BYTES])
            )
        await ws.send(protocol.answer_end(self._turn, request_id))

    def _enter_answering(self, request_id: str) -> None:
        self._state = State.ANSWERING
        self._request_id = request_id
        self._answering = False
        self._answer = []
        self._idle_blocks = 0
        self._gate.reset()

    def _leave_answering(self) -> None:
        self._state = State.WAITING
        self._request_id = None
        self._answering = False
        self._answer = []
        self._idle_blocks = 0
        self._gate.reset()
        # The supervisor's voice is in the detector's buffer now; without this
        # it can still contribute to a wake-word detection afterwards.
        self._detector.reset()

    def _trim_bytes(self) -> int:
        """Bytes to drop from the tail so the stop word doesn't reach OpenCode.

        openWakeWord reports that a word was detected, not where it began, so
        this is a fixed trim rather than a precise boundary.
        """
        seconds = self._config.wake.stop_trim_seconds
        raw = int(seconds * CAPTURE_FORMAT.rate) * 2
        # Round to whole capture blocks so we never split a sample.
        return (raw // BLOCK_BYTES) * BLOCK_BYTES

    # --- server side -------------------------------------------------------

    async def _read_server(self, ws: ClientConnection) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                self._on_audio(raw)
            else:
                self._on_control(protocol.decode_server_message(raw))

    def _on_audio(self, frame: bytes) -> None:
        turn, pcm = protocol.decode_audio_frame(frame)
        if turn != self._turn:
            log.debug("dropping speech audio for stale turn %d", turn)
            return
        # Once the user has started answering, the rest of the supervisor's
        # question is stale — playing it would talk over them and then ask a
        # question they already answered.
        if self._answering:
            log.debug("dropping supervisor audio, an answer is in progress")
            return
        self._play(pcm)

    def _on_control(self, msg: dict[str, Any]) -> None:
        kind = msg["t"]

        if kind == "turn.accepted":
            log.debug("turn %s accepted", msg.get("turn"))

        elif kind == "turn.rejected":
            log.info("turn %s rejected: %s", msg.get("turn"), msg.get("reason"))
            self._buffer.clear()
            self._state = State.WAITING if self._state is State.WAITING else State.IDLE
            self._play(earcons.busy(self._speech_format.rate))

        elif kind == "turn.status":
            log.debug("turn %s: %s", msg.get("turn"), msg.get("state"))

        elif kind == "transcript":
            # Logged rather than spoken — the cheapest way to diagnose a
            # misroute is to see what the STT layer actually heard.
            log.info("heard: %s", msg.get("text"))

        elif kind == "speech.begin":
            log.debug("speech segment %s (%s)", msg.get("seg"), msg.get("voice", "agent"))

        elif kind == "speech.end":
            pass

        elif kind == "permission.ask":
            request_id = msg.get("id")
            log.info(
                "permission asked (attempt %s): %s",
                msg.get("attempt", 0),
                msg.get("question", ""),
            )
            if isinstance(request_id, str):
                # The earcon lands before any synthesized speech does, which is
                # what actually tells the user to stop and listen.
                if self._state is not State.ANSWERING:
                    self._play(earcons.permission(self._speech_format.rate))
                    self._enter_answering(request_id)
                else:
                    # A reprompt for the same request: re-arm without replaying
                    # the earcon over the supervisor's second question.
                    self._enter_answering(request_id)

        elif kind == "permission.resolved":
            log.info(
                "permission %s resolved: %s", msg.get("id"), msg.get("response")
            )
            if msg.get("response") == "timeout":
                self._play(earcons.error(self._speech_format.rate))
            self._leave_answering()

        elif kind == "error":
            log.warning("server error [%s]: %s", msg.get("code"), msg.get("message"))
            self._play(earcons.error(self._speech_format.rate))

        elif kind == "turn.end":
            log.info("turn %s ended: %s", msg.get("turn"), msg.get("outcome"))
            # A turn can end while an answer window is still open — a supervisor
            # failure, or an abort — so tear that down rather than stranding it.
            if self._state is State.ANSWERING:
                self._leave_answering()
            self._state = State.IDLE
            self._buffer.clear()
            # Drop buffered audio so the tail of one turn can't contribute to a
            # detection in the next.
            self._detector.reset()

        else:
            log.debug("ignoring unknown message type %s", kind)

    def _play(self, pcm: bytes) -> None:
        if self._playback is not None:
            self._playback.play(pcm)


def _block_seconds() -> float:
    return BLOCK_SAMPLES / CAPTURE_FORMAT.rate
