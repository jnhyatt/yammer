# AGENTS.md

Working notes for AI agents (and humans) contributing to Yammer.

> **Status: v1 skeleton built, first live run underway.** Both halves exist and pass a protocol conformance check end to end. As of 2026-08-11 the pieces that had never happened — a real utterance through real STT, a real OpenCode turn, and wall-clock latency with a human in the loop — are happening: this conversation is itself the first live run.

## What Yammer is

A hands-free voice interface for talking to a codebase via OpenCode. Two wake words bracket an utterance; the audio goes to a server that transcribes it, routes it, and either forwards it to OpenCode or executes a meta-command; the response comes back as synthesized speech.

The primary use case is working on a project while unable to type or look at a screen. Two consequences follow from that and should inform basically every decision:

- **Sound is the only status channel.** If the user can't tell what state the system is in by ear, it's broken regardless of whether it works.
- **Latency is felt, not measured.** Time-to-first-audio matters more than total throughput.

[voice-opencode-requirements.md](voice-opencode-requirements.md) is the source of truth for scope. Read it before making design decisions. It is a functional requirements doc, not an implementation spec — where it names a technology, that's a considered default, and if you see a better option, raise it rather than silently deviating or silently complying.

## Architecture at a glance

```
┌─ client (Python) ──────────┐         ┌─ server (TypeScript) ─────────────┐
│  openWakeWord detection    │         │  Groq STT (whisper-large-v3-turbo)│
│  16kHz mono mic capture    │◄──WS───►│  routing LLM (via OpenRouter)     │
│  Silero VAD (answers only) │         │  OpenCode SDK (opencode serve)    │
│  earcons                   │         │  permission supervisor            │
│  audio playback            │         │  Kokoro TTS (two voices)          │
└────────────────────────────┘         └───────────────────────────────────┘
```

The client is deliberately thin — no STT, no TTS, no LLM calls — so future clients only reimplement audio capture, wake-word detection, and earcons.

**The two halves are in different languages on purpose** (openWakeWord is Python-native; the OpenCode SDK is TypeScript-native). This means the WebSocket protocol is a real cross-language contract, not a shared type definition. Treat protocol changes as breaking changes to both halves and keep the schema documented in one place.

## Repository layout

```
protocol/PROTOCOL.md   the cross-language wire contract — source of truth
server/                TypeScript. See server/README.md
client/                Python 3.11. See client/README.md
client/tools/          generators for the checked-in fixtures — not part of the client
android/               Kotlin. Second client, in progress. See android/README.md
android/core/          the wake-word feature pipeline — pure Kotlin/JVM, tested on the desktop
android/models/        the five .onnx files, checked in, digests pinned by the fixture
fixtures/              language-neutral test data every implementation is checked against — see fixtures/README.md
.opencode/agent/       the TTS-aware OpenCode agent every turn is prompted with
containers/            Containerfiles for the server and OpenCode images
quadlet/               Podman Quadlet units to run both as systemd services — see quadlet/README.md
voice-opencode-requirements.md   scope and design decisions
android-client-plan.md           the Android client's implementation plan (§9 of the above)
yammer-server-v2.md              per-project OpenCode containers: scope and design decisions
yammer-server-v2-plan.md         how and in what order that gets built, and how far it has got
```

Each half has a gitignored `.env` and a checked-in `.env.example`. `YAMMER_TOKEN`
must be identical in both — a mismatch closes the socket with 4001.

`protocol/PROTOCOL.md`, `server/src/protocol.ts`, and
`client/src/yammer_client/protocol.py` are three views of one contract. **Change
them together.** A mismatch between the two implementations will not show up as
a type error — the conformance test is the only thing that checks them against
each other, and it only can because the frames it decodes are dumped from the
real Python module. After any protocol change, regenerate that fixture:

```sh
cd client && .venv/bin/python tools/dump_protocol_frames.py
```

A diff there is the signal that the other views need the same change.

## Commands

```sh
# server
cd server && npm install
cp .env.example .env         # then fill it in
npm run typecheck
npm start

# client
cd client && uv venv --python 3.11 && uv pip install -e .
cp .env.example .env         # then fill in YAMMER_TOKEN
.venv/bin/yammer-client
.venv/bin/python -c "import openwakeword.utils as u; u.download_models()"

# android — no SDK, emulator or device needed for :core
cd android && ./gradlew :core:test
```

Config comes from the environment, with a `.env` loaded at startup — first file
found wins, files are never merged, and the real environment always beats the
file. Both READMEs document the search order.

`npm test` (server) runs eight suites. What they have in common is that all
eight guard failures that are **silent** — everything else here fails loudly,
since a bad model id 404s and a protocol mismatch closes the socket.

- `supervisor/keywords.test.ts` — the approve/deny matcher. A mistranscription
  classified as "approve" force-pushes a branch and looks like success.
- `protocol.test.ts` — cross-language codec conformance. The frames are dumped
  from the real Python client module (see above), so this genuinely checks two
  implementations against each other rather than checking JSON round-trips.
- `ws-server.test.ts` — handshake, close codes, busy rejection, and the error
  path, driving the real `startServer` with the four network dependencies faked.
  Its load-bearing assertion is the invariant below: **every turn exit path
  emits `turn.end`.** A path that skips it strands the client with no way back
  to idle.
- `registry/store.test.ts` — the workspace registry's parser. A file edited by
  hand into something slightly wrong must fail at startup naming the field; a
  parser that shrugs drops a workspace out of `list` while its directory, and
  the user's work in it, sit there untouched.
- `registry/reconcile.test.ts` — registry vs. the containers that actually
  exist. A workspace reported `ready` whose container was removed weeks ago
  sends the next `load` into a timeout with no explanation.
- `lifecycle.test.ts` — create/load/stop/delete against `container/fake.ts`.
  `load` has several distinct failure points and the requirements doc asks each
  to produce its own spoken error; two of them collapsing into one message is
  invisible until someone is standing there being told the wrong thing.
- `opencode/client.test.ts` — one test, for one hang observed against a real
  container. See the readiness-probe gotcha below.
- `router/commands.test.ts` — the workspace commands' spoken half. Two failure
  kinds reading out identically, a `load` that creates on a mishearing, and a
  `delete` that runs without a spoken yes are all invisible to a typechecker
  and expensive in exactly one place: out loud, to someone who can't see a
  screen.

**One thing is still worth promoting into a checked-in test**: the `.env` parser
parity check. `client/.../env.py` hand-implements Node's `process.loadEnvFile`
semantics; it was verified against the real Node parser on a 13-case fixture,
but nothing re-checks it. It guards the same class of bug as the two above —
two implementations of one contract silently drifting apart.

`cd android && ./gradlew :core:test` is the same idea in Kotlin: 39 tests that
reproduce `fixtures/wakeword/golden.json` from the ported feature pipeline. It
guards the most silent failure in the system — a wake-word pipeline that is
subtly wrong produces plausible scores that never cross threshold, with nothing
thrown and nothing logged. The tolerance is 1e-6, the fixture's own six-decimal
rounding and not a step more, because both sides run the same ONNX Runtime
version against the same weights; the observed worst case is 4.999e-07. Each
stage is checked separately, so a divergence localizes itself rather than
presenting as "the score is wrong".

Fixtures for all of this live in `fixtures/`, generated by `client/tools/` and
consumed by the server and Android suites. They are checked in and regenerating
them should produce no diff unless something genuinely changed — see
`fixtures/README.md`.

`npm run eval:router` (`server/src/router/eval/`) is a different kind of check
— not correctness, but a live quality/regression eval for whichever model
`YAMMER_ROUTER_MODEL` points at, run by hand when changing it. Needs
`YAMMER_ROUTER_API_KEY`; nothing else. It is also the control on the router's
*schema*: adding a slot changes what the model has to produce, so it gets
re-run when `META_COMMANDS` grows, not only when the model does. Current
standing: 73/73 for the default model, no critical misroutes.

## Conventions

- **Everything expected to change is configuration.** Wake-word model paths and
  thresholds, STT base URL and model, router model, TTS voice and dtype, and the
  transport token are all environment variables. No literals in code. New
  variables go in the config module, the README table, and `.env.example`.
- **Errors carry a spoken form.** Anything the user needs to know about becomes
  an earcon plus a sentence. Log lines are for the developer; they are not a
  channel the user has.
- **Output shape is the agent's job, not the server's.** Nothing between
  OpenCode and Kokoro strips markdown, and nothing should — the fix for
  unspeakable replies lives in `.opencode/agent/yammer.md`, which is prompt
  configuration, not a formatting pass in `turn.ts`. A sanitizer there would be
  the second place that decides how replies sound.
- **Safety is a control, not an instruction.** Destructive commands are gated by
  OpenCode's permission system and a spoken prompt (`src/supervisor/`), not by
  asking the agent nicely in its prompt. The earlier version did the latter, and
  it failed the first time it was tested: told to run `git push --force`, the
  agent read its own "describe it and stop" paragraph and narrated instead —
  which meant the *real* gate never fired either. If you catch yourself adding a
  rule to the agent's prompt to prevent an action, that belongs in its
  permission rules instead.
- **Every turn exit path emits `turn.end`,** including failures. The client uses
  it to leave the WAITING state — a path that skips it strands the client.
- Server: no build step. It runs under Node's type stripping, so **no TypeScript
  syntax that requires transformation** — see gotchas.
- Client: audio is buffered locally and flushed on the stop word, never streamed
  as captured. That is what makes stop-word trimming possible at all.

## Gotchas and hard-won context

Notes here should be things that cost someone time.

- **Anthropic has no speech-to-text API.** An earlier draft of the requirements
  doc specified one. It doesn't exist — the Messages API takes text, images, and
  PDFs only. STT is Groq.
- **`kokoro-js`'s `stream()` hangs when handed a plain string.** It builds a
  `TextSplitterStream`, pushes the text, and never closes it; the splitter
  withholds a sentence whose terminator lands at the buffer end in case more
  text follows, so the async iterator awaits forever. Construct the splitter
  yourself, `push()`, then `close()`. `src/tts/kokoro.ts` does this — don't
  "simplify" it back.
- **Node's type stripping rejects TypeScript parameter properties**
  (`constructor(private readonly x: T)`) with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
  and `tsc --noEmit` will not catch it — the error only appears at runtime.
  Declare fields explicitly and assign in the constructor body. The same applies
  to enums and namespaces.
- **openWakeWord's `predict()` requires `threshold` whenever `debounce_time` is
  used**, or it raises. Also, its loaded models are in `model.models`;
  `prediction_buffer` is populated lazily and is empty before the first predict.
- **The stop wake word ends up in the audio buffer.** If it isn't trimmed
  client-side it gets transcribed and forwarded to OpenCode as part of the
  prompt. openWakeWord reports *that* a word fired, not *where it began*, so the
  trim is a fixed duration, not a precise boundary — it's a tuning knob
  (`YAMMER_WAKE_STOP_TRIM_SECONDS`), and both directions cost something.
- **openWakeWord pins `tflite-runtime`,** which publishes no wheels past cp311 —
  hence the Python 3.11 pin, even though we run ONNX inference.
- **Headphones are a hard dependency, not a convenience.** v1 does no acoustic
  echo cancellation and does not gate the mic during playback, so TTS through a
  speaker will trigger the client's own wake-word detector.
- **Verbatim forwarding is a deliberate v1 constraint.** Resist the urge to
  clean up or reframe transcripts before they reach OpenCode. If it turns out to
  be necessary, that's a requirements change to discuss, not an implementation
  detail to sneak in.
- **Router-model IDs on OpenRouter go stale.** `google/gemini-2.0-flash-001`,
  the original default, was removed from the catalogue entirely (confirmed
  against `GET /api/v1/models`) — a live call would 404 on the first turn, not
  fail at config time. Before changing `YAMMER_ROUTER_MODEL`, check the model
  still exists and run `npm run eval:router` against it.
- **The default router model is `deepseek/deepseek-v4-flash`, chosen by
  running the eval, not by reading a scorecard.** First `npm run eval:router`
  pass: `google/gemini-2.5-flash-lite` scored 49/50 but its one miss routed
  "make it new" to `new_session` — a destructive false positive, the exact
  failure class the eval exists to catch. `deepseek/deepseek-v4-flash` scored
  50/50 with no critical misroutes; it's ~4s mean / ~9s p95 slower per call,
  which is fine per router.ts's own stated priority (accuracy over latency —
  an OpenCode turn already takes tens of seconds, and there's no dedicated
  "routing" earcon for the client to make that wait feel long). Two things
  broke while running this, worth remembering: **OpenRouter's
  `~deepseek/deepseek-v4-flash-latest` alias includes the `~` as part of the
  literal model ID** (drop it and every call 400s "not a valid model ID"),
  and it **doesn't reliably honor `response_format: json_schema` strict
  mode** — 4/50 calls returned prose instead of JSON, plus p95 latency over
  50s — so avoid the `-latest` alias regardless; the dated `deepseek-v4-flash`
  had neither problem. Re-run the eval before trusting a new model here; one
  case flipping a 98% score into a critical failure is why category-average
  accuracy alone is not the metric that matters.
- **Whisper decides for itself whether a two-word name is one word.** In one
  live sitting, "live check" came back as `LiveCheck` when the workspace was
  created and as `live check` when it was loaded — so the workspace was made as
  `livecheck` and then not found. Workspace names are therefore resolved on a
  key with *all* separators stripped (`lifecycle.ts`'s `workspaceMatchKey`),
  not on the hyphenated sanitized name, and `create` refuses a name that only
  sounds like an existing one. Anything else that matches a spoken name against
  stored state needs the same treatment; the sanitized form is for Podman, not
  for lookups.
- **`response_format: json_schema` strict mode is a hint, not a guarantee, and
  it gets flakier as the schema grows.** `deepseek/deepseek-v4-flash` was clean
  over 50 cases with a two-field schema; adding the `workspace` slot made it
  return its three fields as YAML-ish prose in ~3% of calls, and the observed
  rate on real turns was higher still. `Router.route` therefore asks exactly
  once more when the answer is unusable — malformed only, never a transport
  error or a non-2xx — which took a 70/73 eval to 73/73. Don't "simplify" it
  into a general retry: retrying a down provider just doubles the latency
  before the same failure.
- **OpenCode does not hot-reload agent files, and the SDK's `session.prompt()`
  is not `POST /session/{id}/prompt`.** Two things that will each waste an hour
  when touching the agent. Config-time files — `.opencode/agent/*.md`,
  `opencode.json`, skills, plugins — are read once when `opencode serve` boots,
  so an edited agent means nothing until it restarts; `OpenCodeClient.verifyAgent()`
  exists to turn that into a startup warning instead of a mystery. And when
  poking the API by hand, `session.prompt()` posts to `/session/{id}/message`
  (`prompt_async` is the one at a `/prompt`-shaped path) — the wrong path returns
  the web UI's HTML with a 200, which looks like a JSON parse bug rather than a
  404. Verify an agent loaded with `curl "http://127.0.0.1:4096/agent?directory=$YAMMER_PROJECT_DIR"`.
- **The installed `@opencode-ai/sdk` types lie about permissions.** They
  describe a `permission.updated` event and `POST /session/{id}/permissions/
  {permissionID}` with a `title` field. The running server emits
  **`permission.asked`**, has no `title`, and takes replies at
  **`POST /permission/{id}/reply`** with `{reply}`. This cost an hour of
  believing the permission system was broken, because a test grepping for
  `permission.updated` reported "no permission event" three times while the real
  event sat in the stream. `src/opencode/permissions.ts` therefore uses `fetch`
  against the real endpoints, not the SDK. **Get the truth from a running
  server** — `curl http://127.0.0.1:4096/doc` is the live OpenAPI spec — rather
  than from `node_modules`.
- **A rejected permission ends the OpenCode turn.** The model does not get to
  respond to the refusal: the assistant message closes with
  `finish: "tool-calls"` and **zero text parts**. Two consequences the code
  depends on. `prompt()`'s "empty response" error is the *expected* shape of a
  denial, which is why `TurnManager` checks `supervisor.wasDenied()` before
  treating it as a failure. And the supervisor has to speak the outcome itself,
  because the agent it's speaking for has already been stopped.
- **Aborting a turn does not harm the session.** Verified end to end: after an
  abort, a fresh prompt into the same session returns 200 and the agent
  accurately recounts what it had been doing and that the call was refused. A
  refused tool call lands in the history as a terminal `ToolStateError`, so
  there's no dangling `tool_use` block for the next prompt to choke on. This is
  what makes "resume" need no mechanism — it's just the next utterance.
- **openWakeWord already ships Silero VAD**, at
  `openwakeword/resources/models/silero_vad.onnx`, with an ONNX runtime already
  loaded. The answer-window VAD costs no new dependency. It is Silero **v4**,
  whose `predict()` takes a configurable `frame_size` and needs the input length
  to be an exact multiple of it — our 1280-sample blocks divide evenly by 320 or
  640, so no re-chunking is needed. The 512-sample framing that v5 requires does
  not apply; don't "fix" it to match the v5 docs.
- **Playback must be written in small slices or barge-in is a lie.**
  `Playback._writer` blocks inside `stream.write()` for the length of whatever
  it was handed, so queueing a whole sentence makes the shortest possible
  interruption one sentence long. `play()` slices to 40 ms on the way in for
  exactly this reason — `flush()` on its own does nothing about audio already
  being written.
- **Node's `fetch` cannot talk to a Unix socket,** which is how Podman's REST
  API is reached. There is no option for it on the global `fetch` and undici's
  is behind a custom dispatcher, so `src/container/podman.ts` uses `node:http`
  with `socketPath` instead. The URL still needs a host the parser accepts even
  though the transport ignores it. Also worth knowing before poking at it by
  hand: `podman ps` and the API disagree about defaults — the API returns only
  running containers unless you pass `all=true`, so a stopped workspace looks
  removed rather than stopped. Verify shapes against the live socket:
  `curl -s --unix-socket $XDG_RUNTIME_DIR/podman/podman.sock
  'http://d/v5.0.0/libpod/containers/json?all=true'`.
- **A rootless published port accepts connections before anything is listening
  behind it.** Podman's port forwarder binds the host port at container start,
  so during a workspace's first seconds a request is accepted and then simply
  never answered — not refused. `fetch` has no default timeout, so an unbounded
  readiness probe waits there indefinitely, and a poll loop whose probe never
  returns never gets back to checking its own deadline: `load` hangs forever
  with nothing after "waiting for OpenCode" in the log. `probeAgent` passes
  `AbortSignal.timeout` for this reason. Observed, not theorised; the
  reproduction is `opencode/client.test.ts`.
- **Podman assigns a published port at *create* time, not at start.** Asking for
  `host_port: 0` and reading it back from `inspect` works before the container
  has ever run, and the port survives stop/start. That is why the registry can
  record it at create time.
- **The workspace container's mounts nest deliberately.** `auth.json` mounts
  read-only *inside* the read-write per-workspace OpenCode state directory.
  Podman orders mounts by destination depth, so this works — but it means the
  two mounts are a pair, and changing one without the other silently gives every
  workspace either no credentials or a shared sqlite database.
- **OpenCode's own default model is not guaranteed to work, and the failure
  only shows up on the first forwarded turn.** `OpenCodeClient.resolveModel`
  falls back to `client.config.providers()`'s first default when
  `YAMMER_OPENCODE_PROVIDER`/`YAMMER_OPENCODE_MODEL` are unset — that default
  has pointed at a model the account can't actually use. Set both explicitly.
  `opencode/deepseek-v4-flash-free` is verified working end to end (real
  `OpenCodeClient.prompt()` call, real reply) with no extra credentials and no
  cost. The adjacent-looking `opencode-go`'s paid `deepseek-v4-flash` is a trap
  — same model family, cheap, but **region-locked to China**, 403s "requires
  explicit opt in" on first use. See server/README.md's "OpenCode model"
  section.

## Scope discipline

The requirements doc has an explicit non-goals list. It is load-bearing — most entries on it are things that are genuinely tempting and genuinely out of scope for v1. Check it before adding capability. If something on that list turns out to be necessary, say so and update the doc rather than quietly building it.
