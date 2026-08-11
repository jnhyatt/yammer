# yammer-server

The thick half of Yammer. Terminates the WebSocket, transcribes utterances,
routes them, drives OpenCode, and synthesizes speech back.

Runs TypeScript directly under Node's type stripping — there is no build step.

## Requirements

- **Node 22+** (developed on 24).
- A running `opencode serve` (default `http://127.0.0.1:4096`).
- API keys for STT and the routing LLM.

The Kokoro weights (~90 MB at `q8`) download on first run and are cached by
`@huggingface/transformers`. The server loads them before it starts listening,
so the first utterance of a sitting doesn't pay cold start — expect a few
seconds of startup.

## Install and run

```sh
npm install
cp .env.example .env     # fill in the four required values

npm start        # or: npm run dev   (watch mode)
npm run typecheck
```

## Configuration

Everything is an environment variable. A `.env` file populates the environment
at startup, so in practice the secrets live there rather than in your shell
history.

Search order — **the first file found is used, and files are never merged**, so
a variable's meaning never depends on which of two files it appears in:

1. `$YAMMER_ENV_FILE`, if set (a missing file here is a hard error — you named it)
2. `server/.env`
3. the repository root `.env`

**Anything already set in the real environment wins over the file**, so
`YAMMER_LOG_LEVEL=debug npm start` does what you'd expect. The file that was
loaded is reported in the startup log line; if a token doesn't seem to be taking
effect, that tells you where to look.

Format is `KEY=value`, one per line: `#` starts a comment, a leading `export` is
ignored, and values may be wrapped in `"`, `'`, or backticks if they contain a
`#` or need leading/trailing spaces. Parsing is Node's built-in `.env` support,
and the client's parser matches it, so one file means the same thing to both
halves of the system.

| Variable | Default | Notes |
|---|---|---|
| `YAMMER_ENV_FILE` | *(search order above)* | Explicit `.env` path |
| `YAMMER_HOST` | `127.0.0.1` | Bind a private interface (e.g. Tailscale), never `0.0.0.0` |
| `YAMMER_PORT` | `8765` | |
| `YAMMER_TOKEN` | *(required)* | Shared secret, compared in constant time |
| `YAMMER_STT_BASE_URL` | `https://api.groq.com/openai/v1` | OpenAI-compatible |
| `YAMMER_STT_API_KEY` | *(required)* | |
| `YAMMER_STT_MODEL` | `whisper-large-v3-turbo` | |
| `YAMMER_ROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `YAMMER_ROUTER_API_KEY` | *(required)* | |
| `YAMMER_ROUTER_MODEL` | `deepseek/deepseek-v4-flash` | Fixed in config by design; see `npm run eval:router` |
| `YAMMER_OPENCODE_URL` | `http://127.0.0.1:4096` | |
| `YAMMER_PROJECT_DIR` | *(required)* | The only directory OpenCode can touch |
| `YAMMER_OPENCODE_PROVIDER` | *(OpenCode's default)* | See "OpenCode model" below before relying on the default |
| `YAMMER_OPENCODE_MODEL` | *(OpenCode's default)* | |
| `YAMMER_OPENCODE_AGENT` | `yammer` | The TTS-aware agent; see "OpenCode agent" below |
| `YAMMER_SUPERVISOR_VOICE` | `bm_george` | Approval-prompt voice; must differ audibly from `YAMMER_TTS_VOICE` |
| `YAMMER_SUPERVISOR_ANSWER_SECONDS` | `12` | How long one answer window stays open |
| `YAMMER_SUPERVISOR_MAX_ATTEMPTS` | `3` | Asks before giving up, then rejects and aborts |
| `YAMMER_TTS_MODEL` | `onnx-community/Kokoro-82M-v1.0-ONNX` | |
| `YAMMER_TTS_DTYPE` | `q8` | `fp32`/`fp16`/`q8`/`q4`/`q4f16` |
| `YAMMER_TTS_VOICE` | `af_heart` | |
| `YAMMER_TTS_DEVICE` | `cpu` | `cuda` — see "GPU offload" below before setting this |
| `YAMMER_LOG_LEVEL` | `info` | `debug` logs every routing decision |

### OpenCode model

Leaving `YAMMER_OPENCODE_PROVIDER`/`YAMMER_OPENCODE_MODEL` unset makes
`OpenCodeSession` ask OpenCode for its own default (`client.config.providers()`,
first provider's default model). That default is **not guaranteed to be a model
your OpenCode account can actually use** — it errors on every forwarded turn if
not, since the failure only surfaces on the first real prompt call.

`opencode/deepseek-v4-flash-free` is a verified-working pair — confirmed with a
real prompt through `OpenCodeSession.prompt()` end to end, no extra credentials
(it's on OpenCode's own built-in `opencode` provider), no cost. Set both:

```sh
YAMMER_OPENCODE_PROVIDER=opencode
YAMMER_OPENCODE_MODEL=deepseek-v4-flash-free
```

Two adjacent options that look right but aren't:

- `opencode-go`'s `deepseek-v4-flash` (non-free, `$0.07`/`$0.14` per M) is
  **region-locked to China** and 403s with "requires explicit opt in" — it's in
  the provider list and looks like the obvious pick, but fails on first use.
- The `-free` suffix names OpenCode's billing tier for its own gateway, not a
  degraded model — it's the same DeepSeek V4 Flash weights, same release date,
  as the OpenRouter model the router eval scored. It may carry a rate limit
  OpenCode doesn't expose in `config.providers()`; if it starts erroring under
  real use, that's the first thing to suspect.

To see what your account currently has, hit a running `opencode serve` directly:
`curl http://127.0.0.1:4096/config/providers | jq`.

### OpenCode agent

Every turn is prompted with an explicit agent — `yammer` by default, defined in
[`.opencode/agent/yammer.md`](../.opencode/agent/yammer.md) at the repository
root and checked in.

It exists because **OpenCode's default agent formats for a screen.** Headings,
bullet lists, code fences, and `src/path/to/file.ts` are all fine to read and
unusable to listen to — Kokoro reads them out literally, character by character
for a path, and a heading has no sentence-final punctuation to chunk on (see the
`kokoro-js` note in the root AGENTS.md). The agent's prompt bans all of that and
asks for short spoken prose with the answer in the first sentence, since that is
the sentence the user is guaranteed to hear.

Two things about it are load-bearing and easy to undo by accident:

- **Its permissions are all `allow`, deliberately.** A permission set to `ask`
  would hang the turn forever: the user has no keyboard and OpenCode has no way
  to put the question into their earbud. The judgment that a prompt would
  normally buy is pushed into the agent's own instructions, which tell it to
  describe destructive or outward-facing actions and stop rather than run them.
  `external_directory` is `deny`, preserving the directory scoping that
  `YAMMER_PROJECT_DIR` sets up.
- **OpenCode reads agent files once at boot and does not hot-reload them.** After
  editing the agent, restart `opencode serve` or nothing changes. The server logs
  `opencode agent available` at startup when the agent resolves, and warns if it
  does not — that warning almost always means a stale `opencode serve`.

The agent must be visible to OpenCode in whatever directory `YAMMER_PROJECT_DIR`
points at. When that's this repository, the checked-in file already is. Pointing
Yammer at another project needs a global copy:

```sh
mkdir -p ~/.config/opencode/agent
cp .opencode/agent/yammer.md ~/.config/opencode/agent/yammer.md
```

Both locations are valid (`.opencode/agent/` and `.opencode/agents/` are
accepted, project-scoped merging over global). To fall back to OpenCode's default
agent — expect screen formatting read aloud — set `YAMMER_OPENCODE_AGENT=build`.

### Permission supervisor

Destructive commands are gated by a spoken approval prompt in a second voice.
The flow is: OpenCode blocks the tool call and publishes `permission.asked`,
`src/supervisor/` says what is about to happen, the user answers with one word,
and the call is unblocked or refused.

Which commands prompt is **not** configured here — it lives in the agent's own
permission rules in [`.opencode/agent/yammer.md`](../.opencode/agent/yammer.md),
because that is where OpenCode reads it. Keep the list short: every entry costs
a ~10 second spoken round trip, so it covers things that leave the machine,
destroy work, or rewrite history, and nothing else.

Three behaviours worth knowing before changing any of it:

- **A denial ends the turn.** OpenCode does not resume the model loop after a
  rejected tool call — the assistant message finishes with no text at all
  (`finish: "tool-calls"`, zero text parts). So the supervisor speaks the
  outcome itself, and `TurnManager` treats the resulting empty reply as the
  expected shape of a denial rather than an OpenCode failure. The turn ends with
  `outcome: "denied"`.
- **Silence is treated as absence, not as a "no".** After
  `YAMMER_SUPERVISOR_MAX_ATTEMPTS` the call is rejected *and* the turn aborted,
  on the assumption that the realistic reason nobody answered is that the
  headphones are out. The session survives untouched, so resuming is just the
  next utterance — "what were you in the middle of?" works, and was verified
  against a live OpenCode.
- **"Always" is broader than what was asked about.** OpenCode's `always` field
  generalizes: answering "always" to `git push origin main --force` saves the
  pattern `git push *`. The supervisor reads that pattern out loud on the first
  ask for exactly that reason.

Answer matching is in `src/supervisor/keywords.ts` — a pure function with no
model behind it, and the one part of this repo with real unit tests
(`npm test`). It is asymmetric on purpose: strict for approving, lenient for
denying. "a prove" and "improve" reprompt rather than approving; "don't approve"
denies rather than matching the "approve" inside it.

Switching STT providers is a base-URL and model change; nothing in
`src/stt/` is Groq-specific.

### GPU offload

`YAMMER_TTS_DEVICE=cuda` routes Kokoro through onnxruntime-node's CUDA
execution provider instead of CPU. Worth it: at `q8` on a weak-ish CPU, Kokoro
synthesizes *slower* than real time (measured ~1.1–1.5x wall-clock per
sentence vs. its audio duration), so a multi-sentence reply falls further
behind playback with every sentence — that's the "long pause between
sentences" symptom. `q4` alone gets CPU synthesis to ~0.5x (comfortably
real-time); CUDA is for when that's still not enough, or the CPU is needed for
something else during a turn.

Two things have to be true, independent of the `YAMMER_TTS_DEVICE` env var:

1. **`onnxruntime-node`'s CUDA EP binary** (`libonnxruntime_providers_cuda.so`)
   isn't in the npm package by default — it's fetched by a postinstall script
   that only auto-runs for CUDA 12 on Linux x64. Force it if `npm install`
   happened before the GPU was in the picture:

   ```sh
   ONNXRUNTIME_NODE_INSTALL_CUDA=v12 node node_modules/onnxruntime-node/script/install.js
   ```

   (CUDA 11 exists as a flag but the script refuses to auto-install it — see
   the script's own error for the manual steps, if that's ever the version
   that matters.)

2. **The CUDA 12 runtime itself** has to be resolvable at load time —
   `libcudart`, `libcublas`, cuDNN, and (found by letting it fail and reading
   the next missing-library error, repeatedly) `libcurand`, `libcufft`,
   `libcusparse`, `libcusolver`, and `libnvrtc`. A machine with a real CUDA
   toolkit install already has all of this on the linker path. If it doesn't —
   e.g. a dev box with an NVIDIA driver but no system CUDA — the redistributable
   pip wheels are a no-root alternative to the system toolkit package:

   ```sh
   uv pip install --target .cuda-libs --python 3.12 \
     nvidia-cuda-runtime-cu12 nvidia-cublas-cu12 nvidia-cudnn-cu12 \
     nvidia-curand-cu12 nvidia-cufft-cu12 nvidia-cusparse-cu12 \
     nvidia-cusolver-cu12 nvidia-nvjitlink-cu12
   ```

   That's ~3.7 GB (cuDNN and cuSPARSE are most of it) and gitignored
   (`.cuda-libs/`) — user-space, no root, easy to delete, and still lighter
   than the full system toolkit package. Point the dynamic linker at all of it
   when starting the server:

   ```sh
   L=$PWD/.cuda-libs/nvidia
   LD_LIBRARY_PATH="$L/cuda_runtime/lib:$L/cublas/lib:$L/cudnn/lib:$L/curand/lib:$L/cufft/lib:$L/cusparse/lib:$L/cusolver/lib:$L/nvjitlink/lib:$L/cuda_nvrtc/lib" \
     YAMMER_TTS_DEVICE=cuda npm start
   ```

   `LD_LIBRARY_PATH` is an OS-level linker setting, not app config, which is
   why it's exported on the command line rather than read from `.env` — by
   the time `.env` is parsed the Node process has already started.

This repo's dev box (an old Quadro M1000M, Maxwell/compute capability 5.0) is
not the intended deployment target — it's here to validate the code path and
the setup steps, and it does: the CUDA EP loads and initializes cleanly.
Actual inference fails there with `cudaErrorNoKernelImageForDevice` — modern
prebuilt CUDA binaries (cuDNN 9 in particular) no longer ship kernels for
Maxwell. That's an obsolete-hardware wall, not a setup bug, and won't recur on
a real target GPU (Ada/Ampere/Turing are all still first-class). A box with a
real CUDA install and a modern GPU only needs step 1 (the EP binary) and
`YAMMER_TTS_DEVICE=cuda`; skip the pip-wheels dance entirely if
`ldconfig -p | grep cudart` already finds something.

## Shape

```
src/
  index.ts            entrypoint: config, warm-up, listen
  config.ts           environment → Config
  protocol.ts         wire types + codecs (mirrors ../protocol/PROTOCOL.md)
  ws-server.ts        handshake, framing, connection lifecycle
  turn.ts             turn state machine: STT → route → act → speak
  wav.ts              PCM/WAV helpers
  stt/groq.ts         OpenAI-compatible transcription
  router/commands.ts  the meta-command catalogue
  router/router.ts    the routing LLM call
  opencode/session.ts one continuous OpenCode session per sitting
  opencode/permissions.ts  watches for blocked tool calls, answers them
  supervisor/supervisor.ts spoken approval prompt in a second voice
  supervisor/keywords.ts   approve/always/deny matching (pure, tested)
  supervisor/speech.ts     turns a shell command into something hearable
  tts/kokoro.ts       sentence-chunked streaming synthesis
```

## Tests

```sh
npm test        # node --test over src/**/*.test.ts
```

Only `supervisor/keywords.ts` is covered, deliberately. Everything else in this
repo fails loudly — a bad model id 404s, a protocol mismatch closes the socket —
but a mistranscription classified as "approve" force-pushes a branch and looks
like nothing went wrong. The fixtures are real Whisper output shapes.

## Evaluating router models

```sh
npm run eval:router                                   # default: current default + two DeepSeek variants
npm run eval:router -- <model-id> [<model-id> ...]     # any OpenRouter-compatible model
```

Scores model(s) against `src/router/eval/cases.ts` by driving the real `Router`
class. Reports accuracy by category, latency, and — separately — any
**critical misroutes**: a `forward` case in the adversarial set (e.g. "start a
new file for the session handler") routed to `new_session` instead. Those are
the failure that matters; a wrong `report_usage` just answers a question that
wasn't asked, but a wrong `new_session` silently discards the conversation with
no undo. When two or more models run, disagreements between them are listed
separately at the end.

Needs only `YAMMER_ROUTER_API_KEY` (`.env` or exported) — nothing else the
server needs. Add cases to `cases.ts` whenever `META_COMMANDS` grows; that's the
moment the misroute surface changes and old scores stop being informative.

## Adding a meta-command

Append one entry to `META_COMMANDS` in `src/router/commands.ts`. The router's
prompt and its output schema are both derived from that array, and the handler
lives beside the description, so there is no second place to update.

Write the `description` to say *when it applies and when it doesn't* — the
router's failure mode is misrouting an ordinary coding instruction ("start a new
file") into a meta-command, so the boundaries matter more than the summary.
