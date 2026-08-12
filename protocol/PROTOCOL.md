# Yammer WebSocket Protocol v3

The contract between the Python client and the TypeScript server. Because the two
halves are in different languages, this file is the single source of truth — the
implementations in `client/src/yammer_client/protocol.py` and
`server/src/protocol.ts` both mirror it and must be changed together.

## Framing

Mixed-mode WebSocket.

- **Control messages** are JSON text frames, always an object with a `t` field.
- **Audio** is binary frames: a 4-byte little-endian `uint32` `turn_id` prefix
  followed by raw PCM.

```
┌────────────┬──────────────────────────────────┐
│ turn_id    │ audio payload                    │
│ uint32 LE  │ raw PCM, format declared by the  │
│ 4 bytes    │ preceding control message        │
└────────────┴──────────────────────────────────┘
```

Only one turn is ever in flight **per connection** (the server rejects an
utterance arriving while that client's turn is running), so the `turn_id` is
not for multiplexing. It exists so that **late frames from a rejected or
cancelled turn are discarded unambiguously** rather than by timing heuristic.
Receivers MUST drop any binary frame whose `turn_id` does not match the turn
they are currently accepting audio for.

`turn_id`s are per connection and are not coordinated between clients. Two
clients using the same number are two different turns, and neither can see the
other's frames.

`turn_id` is allocated by the client, starts at 1, and increments per turn. It
wraps at 2^32.

## Handshake

The client's first frame MUST be a `hello` text frame. A binary frame or any
other message type before `hello` is a protocol violation.

The server either replies `hello.ok` or closes the connection. It never replies
with an error message to a failed handshake — the close code carries the reason.

| Close code | Meaning |
|---|---|
| `4001` | Authentication failed (bad or missing token) |
| `4002` | Unsupported protocol version |
| `4003` | Protocol violation |

**`4004` was retired in v3** and is not reused. The server accepts as many
clients as connect; see "Connection lifecycle".

## Audio formats

Formats are negotiated in the handshake rather than hardcoded, so either side can
move without a lockstep change. An audio format object is:

```json
{ "codec": "pcm_s16le", "rate": 16000, "channels": 1 }
```

`pcm_s16le` is the only codec. The client captures at 16 kHz mono; Kokoro
emits 24 kHz mono. The client MUST honour the `audio` format in `hello.ok`
rather than assuming 24 kHz.

**Binary frames have no fixed payload size, and receivers MUST NOT assume one.**
A frame is a turn tag and however much PCM the sender had to hand; utterance
boundaries are carried by the control messages, never by frame count or size.

What the Python client actually does, as one valid strategy rather than a
requirement: it buffers the whole utterance locally while recording, trims the
stop word off the tail once it fires, and only then sends the result as frames
of up to 16 KiB (8192 samples, 512 ms) followed immediately by `utterance.end`.
Nothing is streamed during capture — the trim has to happen after the tail is
known, so there is nothing to send until the utterance is over.

The client's *internal* capture granularity is 1280 samples (80 ms), because
that is the block size openWakeWord accumulates to. That number never reaches
the wire and no other client is obliged to adopt it.

There is no latency argument for smaller frames here: a busy server rejects at
`utterance.begin`, before any audio exists, precisely so the user finds out when
they say the wake word rather than after speaking a sentence.

## Client → Server messages

### `hello`
First frame. Carries auth and capture format.
```json
{ "t": "hello", "proto": 3, "token": "<shared secret>",
  "client": "yammer-client/0.1.0",
  "audio": { "codec": "pcm_s16le", "rate": 16000, "channels": 1 } }
```

### `utterance.begin`
Start wake word fired; binary frames follow.
```json
{ "t": "utterance.begin", "turn": 7 }
```

### `utterance.end`
Stop wake word fired. The explicit end-of-audio marker — the server does not
decide on its own when an utterance is done.
```json
{ "t": "utterance.end", "turn": 7 }
```

### `utterance.cancel`
The start word fired again mid-recording (`reason: "restart"`), or the client
aborted for its own reasons. The server drops all state for that turn.
```json
{ "t": "utterance.cancel", "turn": 7, "reason": "restart" }
```

### `answer.begin` / `answer.end` / `answer.timeout`
Answers to a `permission.ask`. The client opens an answer window on receiving the
ask; when its VAD detects speech it sends `answer.begin`, streams ordinary
turn-tagged binary frames, and closes with `answer.end` on trailing silence.

**Answers are not wake-word bracketed.** Saying "hey jarvis approve alexa" would
be absurd, and the fixed stop-word trim would swallow a one-word answer whole.
The window is opened by the server's ask and closed by silence.

Audio frames between `answer.begin` and `answer.end` carry the same `turn` tag as
any other audio — an answer happens *inside* a turn, so the `id` identifies the
request it answers rather than a new stream.

The client MUST include pre-roll: a few hundred milliseconds of audio captured
*before* the VAD fired, because onset detection lags and a one-word answer
loses its first syllable otherwise.

```json
{ "t": "answer.begin", "turn": 7, "id": "per_ff18..." }
{ "t": "answer.end", "turn": 7, "id": "per_ff18..." }
```

`answer.timeout` means the window closed with no speech in it at all — distinct
from speech that failed to transcribe. The server may reprompt or give up.
```json
{ "t": "answer.timeout", "turn": 7, "id": "per_ff18..." }
```

## Server → Client messages

### `hello.ok`
```json
{ "t": "hello.ok", "proto": 3, "server": "yammer-server/0.1.0",
  "audio": { "codec": "pcm_s16le", "rate": 24000, "channels": 1 } }
```

### `turn.accepted`
Sent in response to `utterance.begin`. Means "I am listening, keep going" — not
"I have your audio".
```json
{ "t": "turn.accepted", "turn": 7 }
```

### `turn.rejected`
Also sent in response to `utterance.begin`, when a turn is already in flight.
The client stops recording immediately, discards its buffer, and plays the busy
earcon.

Rejection happens at `utterance.begin` rather than `utterance.end` so the user
finds out the system is busy when they say the wake word, rather than after
speaking a whole sentence into the void.
```json
{ "t": "turn.rejected", "turn": 7, "reason": "busy" }
```

### `turn.status`
Advisory progress. The v1 client ignores these; the field exists so a progress
earcon can be added later without a protocol change.
```json
{ "t": "turn.status", "turn": 7, "state": "transcribing" }
```
`state` ∈ `transcribing` | `routing` | `working` | `speaking`.

### `transcript`
Informational — what the STT layer actually heard. Not spoken. Useful for
diagnosing misroutes.
```json
{ "t": "transcript", "turn": 7, "text": "add a test for the session handler" }
```

### `speech.begin`
Opens a speech segment; binary frames follow. One segment per sentence, so the
client can start playback before the whole response is synthesized.
```json
{ "t": "speech.begin", "turn": 7, "seg": 0, "voice": "agent",
  "audio": { "codec": "pcm_s16le", "rate": 24000, "channels": 1 } }
```
`voice` ∈ `agent` | `supervisor`. Two voices is the only cue the user has for
"the agent is answering you" versus "something is asking your permission", so it
is protocol rather than presentation. It also says what may be interrupted:
**supervisor segments are interruptible, agent segments are not.**

### `speech.end`
```json
{ "t": "speech.end", "turn": 7, "seg": 0 }
```

### `permission.ask`
A tool call is blocked pending a spoken answer. The client plays the permission
earcon and opens an answer window. `question` is what the supervisor is saying —
sent for the log, not for the client to render, since the client has no screen.
`attempt` is 0 for the first ask and increments on each reprompt.
```json
{ "t": "permission.ask", "turn": 7, "id": "per_ff18...", "attempt": 0,
  "question": "The agent wants to run git push origin main, with the force flag. Say approve or deny." }
```

### `permission.resolved`
The request is settled and the client leaves the answer window. Sent for every
outcome, including timeouts — a path that skips it strands the client exactly as
a missing `turn.end` would.
```json
{ "t": "permission.resolved", "turn": 7, "id": "per_ff18...", "response": "once" }
```
`response` ∈ `once` | `always` | `reject` | `timeout`. The first three are
OpenCode's own reply vocabulary; `timeout` is Yammer's and means nobody answered.

### `error`
The client plays the error earcon on receipt. The spoken explanation follows as
ordinary `speech.*` segments, then `turn.end`.
```json
{ "t": "error", "turn": 7, "code": "opencode_unreachable",
  "message": "Could not reach OpenCode." }
```
Codes: `stt_failed`, `stt_empty`, `router_failed`, `opencode_unreachable`,
`opencode_error`, `tts_failed`, `supervisor_failed`, `workspace_unknown`,
`workspace_start_failed`, `workspace_failed`, `internal`. `turn` is omitted for
errors not associated with a turn.

The three workspace codes are new in v3 and split by what the user would do
about it: `workspace_unknown` is a name that resolves to nothing (never an
implicit create), `workspace_start_failed` is a workspace that exists and did
not come up, `workspace_failed` is everything else — a name clash, an unbuilt
image. The spoken `message` is finer-grained than the code, deliberately: the
code drives the client's earcon, the sentence is what the person acts on.

**A client MUST tolerate an unrecognised code**, playing its error earcon and
speaking nothing of its own. Codes are expected to grow; a new one is not a
protocol version bump.

### `turn.end`
The server is idle again; the client may start a new turn.
```json
{ "t": "turn.end", "turn": 7, "outcome": "forwarded" }
```
`outcome` ∈ `forwarded` | `meta_command` | `error` | `cancelled` | `denied`.
`denied` means a tool call was refused at the supervisor prompt, which ends the
OpenCode turn — see below.

## Happy path

```
C → hello
S → hello.ok

  [start wake word → start-record earcon]
C → utterance.begin {turn:7}
S → turn.accepted {turn:7}
  [stop wake word → stop-record earcon; stop word trimmed from tail]
C → «binary» 7 + pcm × N
C → utterance.end {turn:7}

S → turn.status {turn:7, state:"transcribing"}
S → transcript {turn:7, text:"..."}
S → turn.status {turn:7, state:"routing"}
S → turn.status {turn:7, state:"working"}
S → turn.status {turn:7, state:"speaking"}
S → speech.begin {turn:7, seg:0, voice:"agent"}   ← playback starts here
S → «binary» 7 + pcm × N
S → speech.end {turn:7, seg:0}
S → speech.begin {turn:7, seg:1, voice:"agent"}
    ...
S → turn.end {turn:7, outcome:"forwarded"}
```

## Busy rejection

```
C → utterance.begin {turn:8}
S → turn.rejected {turn:8, reason:"busy"}   ← busy earcon, buffer discarded
    (the client stops recording here; any binary frames tagged 8 that are
     already in flight are dropped by the server)
```

## Permission prompt

Mid-turn, so `turn` stays 7 throughout and the client stays in its waiting state
rather than returning to idle.

```
S → turn.status {turn:7, state:"working"}
S → permission.ask {turn:7, id:"per_…", attempt:0, question:"…"}
                                            ← permission earcon fires here
S → speech.begin {turn:7, seg:0, voice:"supervisor"}
S → «binary» 7 + pcm × N
S → speech.end {turn:7, seg:0}
    [user speaks over the supervisor: client flushes playback and drops any
     further supervisor segments for this request]
C → answer.begin {turn:7, id:"per_…"}       ← includes pre-roll audio
C → «binary» 7 + pcm × N
C → answer.end {turn:7, id:"per_…"}
S → permission.resolved {turn:7, id:"per_…", response:"once"}
    (turn continues; the agent's own reply follows in voice:"agent")
```

Unrecognized answers reprompt with the same `id` and `attempt` incremented. After
the configured number of attempts the server replies `reject` to OpenCode,
aborts the turn, and sends `permission.resolved` with `response: "timeout"`.

**A denial ends the OpenCode turn.** OpenCode does not resume the model loop
after a rejected tool call — the assistant message finishes with no text at all —
so the supervisor speaks the outcome itself and the turn ends with
`outcome: "denied"`. The session survives; the user resumes by asking about it on
the next utterance.

## Error path

```
S → error {turn:7, code:"stt_empty", message:"I didn't catch that."}
                                            ← error earcon fires here
S → speech.begin/…/speech.end               ← spoken explanation
S → turn.end {turn:7, outcome:"error"}
```

## Connection lifecycle

Disconnection abandons that connection's in-flight turn. There is no resumption:
the server drops the work, and the client starts clean on reconnect. Do not
build session recovery.

**Several clients may be connected at once** (v3; v2 closed the second with
`4004`). Each connection is independent:

- Its own **active workspace**. Nothing a client says moves another client, and
  no frame tells a client which workspace it is in — it hears it. The client
  holds no workspace state at all.
- Its own **turn**. One turn at a time is a per-connection rule: a person cannot
  say two things at once, but two people can, and `turn.rejected {reason:
  "busy"}` means "you are busy", never "the server is".
- Its own **OpenCode session per workspace**. Two clients in one workspace get
  two independent conversations against the same OpenCode server, which is a
  supported way to work rather than an accident.

Permission prompts go to the client whose session raised them, matched by
session identity. A prompt whose client has disconnected is refused rather than
left blocking the container.

## Why JSON

Control messages are tiny and infrequent; the bulk payload is already binary.
Hand-inspectable frames are worth more than the bytes msgpack would save when
debugging a protocol that spans two languages and two type systems.
