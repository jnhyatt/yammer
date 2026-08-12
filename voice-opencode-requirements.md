# Yammer — Voice Interface for OpenCode — v1 Requirements

## Purpose

A hands-free voice interface for talking to a codebase via OpenCode. Primary use case: working on projects while physically unable to type or look at a screen (e.g. holding a baby). This doc scopes a minimal but real v1 — not a prototype to throw away, but intentionally small.

This is a **functional requirements doc**, not an implementation spec. Where a specific technology or approach is named below, treat it as a reasonable default, not a mandate — if you (Claude Code) see a better way to satisfy the requirement, raise it before building rather than silently deviating or silently complying with a worse option.

## Architecture

Client/server split, connected over a single WebSocket connection.

- **Server**: hosts OpenCode, the STT client, Kokoro (TTS), and the routing LLM. Runs on an always-on machine (location TBD — not the developer's primary desktop). Talks to OpenCode locally. Written in **TypeScript**, so it can use OpenCode's official SDK natively.
- **Client (v1 = desktop app)**: runs wake-word detection locally, captures and frames microphone audio, streams it to the server, plays back synthesized speech received from the server, and produces local audio feedback (see §7). Intentionally kept "thin" — no STT, no TTS, no LLM calls — so that future clients (mobile, etc.) only need to reimplement audio capture, wake-word detection, and earcons, not any of the intelligence. Written in **Python**, so it can use openWakeWord natively.

The two halves are in different languages by deliberate choice: each uses the library that is native to its job. The cost is that the WebSocket protocol is a real cross-language contract rather than a shared type definition — see §2, which raises it from an implementation detail to a specified component.

The client only operates within a specific project directory it's configured for; OpenCode's filesystem access is scoped to that directory. No remote-repo access, no credentials handling beyond the transport token (§2), no elevated permissions in v1.

## Operating assumptions

These are choices, not incidental facts. Changing one invalidates parts of the design.

- **The user is wearing headphones or an earbud.** v1 does no acoustic echo cancellation and does not gate the microphone during playback, so synthesized speech played through a speaker will be picked up by the microphone and can trigger the client's own wake words. The earbud is a hard dependency, not a convenience. Revisit if v1 proves this impractical in the actual use context.
- ~~**One user, one project, one client at a time.**~~ **Superseded by [yammer-server-v2.md](yammer-server-v2.md).** One user still, and no session sharing — but v2 runs a workspace per project and lifts the one-client rule: several clients may connect at once, each with its own active workspace, and two clients may share a workspace and get a conversation each. "One turn at a time" survives as a per-connection rule. This bullet is left here because it was load-bearing for v1's design and the parts of that design it shaped (per-connection turn state, the `busy` rejection) are still in place.
- **The network between client and server is trusted-ish but not open.** See §2 for the minimum bar.

## Components

### 1. Wake-word detection (client-side)

- Two distinct wake words: one to start recording, one to stop recording.
- Detection scans continuously and can fire on the wake word appearing anywhere in the audio stream (not anchored to utterance-start).
- Library: **openWakeWord** (open-source, ONNX-based, free custom wake-word training).
  - **v1 uses the shipped pretrained models** — `hey jarvis` to start, `alexa` to stop — so there is zero training cost to get moving.
  - Custom-trained models (the eventual `hey yammer` / `yammer stop` pair) are a drop-in ONNX swap later and must not require changes to any other component. Keep the model paths configurable.
- On start-word detection: begin buffering microphone audio.
- On stop-word detection: close the buffer and send it to the server as a single unit, followed by an explicit end-of-audio marker over the websocket. The server does not independently decide when an utterance is "done" — the client's stop word is authoritative.
- **The stop word must be trimmed from the buffer before sending.** The detector knows the offset at which it fired; the audio from that point onward is the user saying the stop word, and if left in it will be transcribed and forwarded to OpenCode as part of the prompt. Trimming client-side is preferred over stripping it from the transcript server-side.
- **If the start word fires again while already recording**: discard the buffer and start a new one. This is the "wait, let me say that again" gesture and should be treated as a correction, not an error. Play the start-record earcon again so the user knows it took.
- Audio format: client is responsible for producing 16kHz mono audio (the format Whisper expects). The server should not need to resample.

### 2. Audio transport (client → server)

- Single WebSocket connection between client and server.
- Client sends one complete audio buffer per utterance (everything captured between start and stop wake words), followed by an explicit "end of audio" message.
- Streaming the buffer up in chunks instead of sending it as one blob after the fact is an acceptable alternative if it turns out to be simpler to implement — the requirement is "one utterance, clearly delimited," not "one network call."
- **The wire protocol is a specified artifact, not an emergent one.** Because client and server are in different languages, the message types, binary framing, and control messages must be written down and agreed before either half is built. At minimum this covers: the auth handshake, audio frames, end-of-audio, synthesized-audio frames returning, and server status messages (busy / working / error).
- **Authentication: a shared secret token in the first frame, plus network-level scoping.** The server runs an agent with filesystem write access to a project directory and is reachable over the network from an always-on machine. That is a meaningful capability and it must not sit behind an unauthenticated socket. The bar for v1 is deliberately low but non-zero: bind the listener to a private network interface (e.g. Tailscale) and reject any connection whose first frame does not present the configured token. Anything more (TLS, per-client credentials, rotation) is out of scope.

### 3. Speech-to-text (server-side)

- **Groq, `whisper-large-v3-turbo`** — hosted, **not self-hosted** for v1, since the usual self-hosting target (a home server named Ramius) is currently down and location for long-term hosting is undecided. Revisit self-hosting once a stable server location exists.
  - Chosen over alternatives on cost and latency: roughly $0.04/hr of audio and ~228× realtime, against ~$0.36/hr for OpenAI's Whisper endpoint. For utterances measured in seconds, transcription latency is effectively free.
  - Groq's API is OpenAI-compatible, so switching providers is a base-URL and model-name change. Keep both configurable.
  - **Note:** an earlier draft of this doc named an "Anthropic-adjacent hosted API" for Whisper. No such thing exists — Anthropic offers no speech-to-text endpoint. This section is the correction.
- Input: the audio buffer received from the client for one utterance.
- Output: plain transcript text, handed to the routing layer (see below).

### 4. Routing layer (server-side)

This is the core new piece of intelligence in v1, and the main thing distinguishing this from "just pipe STT into OpenCode."

- A lightweight LLM call (via OpenRouter) receives the transcript and decides what to do with it. Options include, at minimum:
  - Forward the transcript to OpenCode as a prompt (the default/common case).
  - Execute a meta-command instead of forwarding to OpenCode — commands OpenCode itself has no way to trigger, such as:
    - Report usage/cost stats.
    - Compact the current session.
    - Start a new session (replacing the current continuous one).
  - The set of meta-commands above is the v1 starting set, not exhaustive — expect to add more over time, and structure the router so adding a new meta-command doesn't require rearchitecting.
- Router inputs: the transcript, plus minimal session state needed to route well (at least: current session ID, and enough context to know whether "new session" or "compact" makes sense right now). Avoid overloading the router with full conversation history — it's making a routing decision, not answering the question.
- Router should be cheap and fast (this is explicitly the "low-latency, no deep thinking" tier of model) since it runs on every single utterance before anything else happens. **That said, do not over-optimize it**: relative to an OpenCode turn measured in tens of seconds, a few hundred milliseconds of routing latency is noise.
- **The real risk is misrouting, not latency.** A legitimate coding prompt — "start a new file for the session handler" — must not be classified as `new_session`. The router must be biased hard toward `forward`, and meta-command classification should require the utterance to be unambiguously *about* the session rather than about the code. When in doubt, forward.
- Output of a routing decision should be structured (e.g. JSON: action + payload) rather than freeform text, so downstream code doesn't need to parse natural language. Prefer a structured-output or tool-use mechanism over parsing a JSON string out of freeform completion text.

### 5. OpenCode integration (server-side)

- One continuous OpenCode session per work sitting (not one session per utterance). A "new session" meta-command exists precisely so this can be reset deliberately by voice rather than implicitly per-turn.
- Transcript is forwarded to OpenCode **verbatim** in v1 — no reformatting, no injected context beyond what OpenCode's own session/agent config already provides. Prompt framing/enrichment is an explicit non-goal for v1; revisit if verbatim forwarding proves insufficient in practice.
- OpenCode should be configured (via its own agent/system-prompt mechanism) to produce TTS-appropriate output: no code blocks, no markdown formatting, no file-path-heavy output, spoken-language descriptions of code rather than literal code. This configuration lives in OpenCode's own config, not in the routing layer.
- Use OpenCode's server mode (`opencode serve`) and its official SDK for programmatic access, rather than shelling out to the CLI.
- **Concurrency: reject, don't queue.** OpenCode turns can run for minutes. If an utterance arrives while a turn is still in flight, the server rejects it and tells the client to play the busy earcon; the audio buffer is discarded. No queueing, no interruption of the running turn. This is the simplest correct behavior and keeps the server stateless with respect to pending work.

### 6. Text-to-speech (server-side)

- Kokoro, run on the server (not the client) — this keeps future clients (e.g. a mobile app) from needing a local TTS runtime.
- Input: text response (from OpenCode, or from the routing layer for meta-command results/errors).
- Output: synthesized audio sent back to the client over the same WebSocket connection.
- **Prefer sentence-chunked streaming synthesis** over synthesizing the full response and then sending it. As OpenCode's response streams in, synthesize and send each sentence as it completes. Kokoro is small enough (82M params, runs comfortably on CPU) that this is not difficult, and it is the difference between hearing the first words in about a second versus waiting for the entire response to be generated and synthesized before anything plays. This was previously scoped as "pick whichever is simpler" — it is being upgraded to a preference because the latency difference is user-facing and large.

### 7. Audio feedback / earcons (client-side)

With no screen and no keyboard, sound is the only status channel. This is a named component rather than an implementation detail because the "reject on busy" concurrency decision (§5) and the no-echo-cancellation assumption both depend on the user being able to tell system state by ear.

Minimum set of distinct, short, non-speech tones:

| Earcon | Fires when |
|---|---|
| **Start-record** | Start wake word detected, buffering has begun (also replays on mid-recording restart) |
| **Stop-record** | Stop wake word detected, utterance sent to the server |
| **Busy** | Server rejected the utterance because an OpenCode turn is in flight (§5) |
| **Error** | Any failure path from §8 — played *before* the spoken error message |
| **Permission** | A tool call is blocked pending a spoken answer (§7a) — played *before* the supervisor speaks, since it lands sooner than synthesized speech can |

These must be immediately distinguishable from each other by ear alone, and distinguishable from Kokoro speech. They are generated and played entirely on the client — the server sends a status message, the client decides what it sounds like.

Not in scope for v1: a progress indicator during long OpenCode turns. It is likely to be wanted; it is not required to ship.

### 7a. Permission supervisor (added after v1 skeleton)

**This section amends two entries on the non-goals list below.** It is recorded
here rather than built quietly because the original scope deliberately excluded
both, and the reasoning that excluded them turned out to be wrong in one case
and incomplete in the other.

The problem it solves: OpenCode gates destructive tool calls behind a permission
prompt, and v1 had no way to answer one. The only options were to set every
permission to `allow` — handing an unattended agent `git push --force` — or to
`ask` and have the turn hang forever with no channel to answer on. v1 chose
`allow` plus an instruction in the agent's own prompt telling it to describe
destructive actions and stop. That is a promise, not a control, and it was
observed failing in exactly the way promises do.

- A blocked tool call is announced in **a second, distinct Kokoro voice** — the
  supervisor. Two voices is the only cue distinguishing "the agent is answering
  you" from "something needs your permission", so the voice is part of the
  contract, not presentation.
- The answer is matched by **exact keyword, not by the routing LLM**. Approve,
  always, and deny (OpenCode's own three replies; there is no "deny always").
  Matching is asymmetric on purpose: strict for approving, lenient for denying.
  An unrecognized answer reprompts rather than guessing.
- **No answer is treated as "the user isn't here",** which is the realistic
  case — headphones out. After the configured attempts the call is rejected and
  the turn aborted. The OpenCode session survives, so the user resumes by asking
  what happened whenever they come back. No resume mechanism is needed for this:
  it is just the next utterance into the same session.
- **The user can talk over the supervisor.** This is barge-in, which the
  non-goals list excluded. It is scoped to supervisor speech only — agent
  replies still play to completion — and it is delimited by voice activity
  detection rather than wake words, because "hey jarvis approve alexa" is
  absurd and the fixed stop-word trim would eat a one-word answer whole.
- **VAD stays scoped to the answer window.** Adaptive end-of-utterance detection
  on the main utterance path remains a non-goal; the two-wake-word bracket is
  still what delimits an ordinary utterance.
- Which calls prompt is configuration, in the agent's own permission rules. A
  voice round trip costs ~10 seconds, so prompting on everything would make the
  system unusable — the list is scoped to things that leave the machine, destroy
  work, or rewrite history.

### 8. Error handling (v1 scope)

- No voice-based error recovery in v1 — if something fails (OpenCode unreachable, empty/failed transcription, router failure, etc.), synthesize a spoken error message via Kokoro describing what went wrong, play it to the client, and stop — don't attempt automatic retry or repair logic.
- Minimum errors to handle this way: STT failure or empty transcript, OpenCode API unreachable or erroring, routing LLM failure.
- The error earcon (§7) plays first, so the user knows a failure is coming before the sentence explaining it.
- Transport-level failures (WebSocket drop, auth rejection) are the client's own responsibility to surface, since the server may not be reachable to synthesize anything.

### 9. Android client (added after v1)

**This section amends one entry on the non-goals list below.** It is recorded
here rather than built quietly because "mobile client" was excluded outright,
and the reason it was excluded — that it was a large unknown — turned out to be
answerable by measurement.

The architecture above already anticipated this: the client was kept thin
specifically "so that future clients (mobile, etc.) only need to reimplement
audio capture, wake-word detection, and earcons, not any of the intelligence."
That held. **No server work is in scope** — an Android client is a second
client, not a redesign.

- **The ML is not the obstacle it looked like.** All five models (melspectrogram,
  Google `speech_embedding`, two wake-word classifiers, Silero VAD) are plain
  ONNX totalling 6.2 MB and run unmodified on `onnxruntime-android` — no
  conversion, no quantization, no NNAPI or GPU delegate. Measured on a 2015
  laptop CPU with a single inference thread, the full wake pipeline costs 3.7 ms
  per 80 ms block (4.6% of one core) and the VAD 1.0 ms. The Python 3.11 pin in
  `client/README.md` does not follow either — it exists only because
  `tflite-runtime` publishes no wheels past cp311, which is a PyPI packaging
  artifact rather than a real dependency.
- **The real work is the feature pipeline**, which openWakeWord performs in
  Python around the models and which has to be reimplemented in Kotlin. It is
  buffer arithmetic, and its failure mode is silent — plausible scores that
  never cross threshold. It is therefore pinned to checked-in golden vectors
  (`fixtures/wakeword/`) rather than trusted.
- **LE Audio bidirectional earbuds are a hard requirement**, which implies
  Android 13+ and a compatible phone and buds. This is a scope decision, not an
  implementation detail: classic Bluetooth has no high-bandwidth microphone path
  at all — A2DP is output-only and HFP/SCO caps at 8 kHz CVSD or 16 kHz mSBC —
  so no amount of client code fixes it and no better classic-BT headset helps.
  Shipped as a documented "your mileage may vary" requirement rather than a
  compatibility matrix to satisfy.
- **Headphones remain assumed** (§ Operating assumptions), unchanged. Android's
  `VOICE_COMMUNICATION` capture path brings acoustic echo cancellation along
  with it, but that is a bonus, not a licence to support speakers.
- **Device selection stays dumb**: default input and output, no pinning. The one
  necessary exception is declaring the capture *use case*, because a headset mic
  is a communication route — in a media context an LE Audio link runs
  unidirectional and the buds' mics do not stream at all, so capture would
  silently fall back to the phone's own microphone.

Still a non-goal, and listed below: an iOS client, a screen or transcript UI,
and any compatibility work for devices without LE Audio.

One thing this **does not** resolve. The client's operating directory (see
§ Architecture) is server-side already, so nothing breaks — but a phone has no
local checkout to fall back on, which makes a single fixed project directory a
tighter constraint than it was on the desktop. Workspace/project sandboxing is
the open design question that follows from this, and is deliberately not
answered here.

Implementation plan, including phasing and the risks that need measuring rather
than reasoning about: [`android-client-plan.md`](android-client-plan.md).

## Explicit non-goals for v1

- ~~Mobile client (desktop only for now; openWakeWord has existing community Android ports via ONNX Runtime if/when this becomes relevant, but that's future work).~~ **Superseded by §9 for Android.** The guess about ONNX Runtime was right and the "future work" framing was the only thing wrong with it: the models run as-is and the cost is a Kotlin reimplementation of openWakeWord's feature pipeline, not a porting problem. **iOS remains a non-goal**, as does any support for devices without LE Audio.
- Acoustic echo cancellation. Still assumed away by headphones. **Barge-in is no longer a non-goal** — it was added, narrowly, for the permission supervisor (§7a): the user can talk over the supervisor's question, but not over an agent reply.
- Queueing or interrupting in-flight OpenCode turns — v1 rejects concurrent utterances outright.
- ~~MCP-based approval-gated tool access for OpenCode~~. **Superseded by §7a.** Directory scoping is still the boundary, but destructive commands inside that boundary are now gated by a spoken approval prompt rather than by an instruction in the agent's prompt. The MCP mechanism named here was never the right one; OpenCode's own permission system already does this and only needed a voice.
- Prompt framing/enrichment beyond verbatim transcript forwarding.
- Self-hosted STT/TTS infrastructure decisions beyond "runs on the server" (i.e., don't design around a specific home server that's currently offline).
- Semantic/adaptive end-of-utterance detection **on the main utterance path** — the two-wake-word approach fully replaces this. VAD is used to delimit a permission answer (§7a) and nowhere else.
- Voice-driven error recovery.
- Transport security beyond a shared token on a private network — no TLS, no per-client credentials, no rotation.
- Progress indication during long OpenCode turns.

## Resolved since first draft

- STT provider is Groq `whisper-large-v3-turbo`; the previously-named Anthropic STT API does not exist.
- Client is Python, server is TypeScript; the WebSocket protocol is therefore a specified artifact.
- Echo handling: none — headphones assumed.
- Concurrent utterances: rejected with a busy earcon, not queued.
- Start word firing mid-recording: discard and restart the buffer.
- Router LLM choice: fixed in config for v1, not runtime-configurable.

## Open questions / flag before building

- Exact WebSocket message schema (§2) — needs to be written down before either half is built.
- Whether the four earcons in §7 are sufficient in practice, or whether a "working" heartbeat becomes necessary immediately.
- Where the server actually runs. Does not block development (it can run on the desktop during build-out), but blocks anything resembling daily use.
- Whether verbatim forwarding (§5) survives contact with real spoken prompts, or whether transcripts need light cleanup before reaching OpenCode.
