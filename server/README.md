# yammer-server

The thick half of Yammer. Terminates the WebSocket, transcribes utterances,
routes them, drives OpenCode, and synthesizes speech back.

Runs TypeScript directly under Node's type stripping — there is no build step.

## Requirements

- **Node 22+** (developed on 24).
- **Rootless Podman**, with its user socket enabled
  (`systemctl --user enable --now podman.socket`). Yammer runs each workspace as
  a container and exits at startup if it cannot reach the socket.
- The workspace image, built once — see "Workspace containers" below.
- API keys for STT and the routing LLM.

There is no `opencode serve` to run by hand any more: every workspace is a
container Yammer starts, and a fresh install has none until you say "create a
workspace".

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
| `YAMMER_OPENCODE_PROVIDER` | *(OpenCode's default)* | See "OpenCode model" below before relying on the default |
| `YAMMER_OPENCODE_MODEL` | *(OpenCode's default)* | |
| `YAMMER_OPENCODE_AGENT` | `yammer` | The TTS-aware agent; see "OpenCode agent" below |
| `YAMMER_STATE_DIR` | *(platform data dir)* | Holds `workspaces.json`; `~/.local/share/yammer` on Linux |
| `YAMMER_PODMAN_SOCKET` | `$XDG_RUNTIME_DIR/podman/podman.sock` | Required: the server exits if it cannot be reached |
| `YAMMER_OPENCODE_IMAGE` | `localhost/yammer-opencode:latest` | Never built on demand; see "Workspace containers" below |
| `YAMMER_WORKSPACE_ROOT` | `~/yammer-workspaces` | Where workspace working directories live on the host |
| `YAMMER_AGENT_FILE` | `<repo>/.opencode/agent/<agent>.md` | Bind-mounted read-only into every workspace |
| `YAMMER_OPENCODE_AUTH` | `~/.local/share/opencode/auth.json` | Provider credentials, mounted read-only |
| `YAMMER_WORKSPACE_READY_SECONDS` | `60` | How long `load` waits for OpenCode inside the container |
| `YAMMER_WORKSPACE_STOP_SECONDS` | `10` | Grace period before a stop becomes a kill |
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
`OpenCodeClient` ask OpenCode for its own default (`client.config.providers()`,
first provider's default model). That default is **not guaranteed to be a model
your OpenCode account can actually use** — it errors on every forwarded turn if
not, since the failure only surfaces on the first real prompt call.

`opencode/deepseek-v4-flash-free` is a verified-working pair — confirmed with a
real prompt through `OpenCodeClient.prompt()` end to end, no extra credentials
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

To see what your account currently has, ask a running workspace's OpenCode
directly — its port is in the registry:
`curl http://127.0.0.1:<port>/config/providers | jq`.

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

- **Its permissions are `allow` except for a short list, deliberately.** The
  container is the safety boundary, so inside it the agent gets an ordinary
  shell. What stays behind an `ask` is the handful of commands that destroy
  unrecoverable work through the bind mount — recursive or forced `rm`,
  `git reset --hard`, `clean`, `checkout --`, `restore`, `branch -D` — because
  the working directory is a real host directory and no sandbox undoes that.
  Commands that need credentials are not on the list: there are none in the
  container, so they fail by themselves. `external_directory` is `deny`, which
  is what keeps the agent inside the project directory.
- **OpenCode reads agent files once at boot and does not hot-reload them.** After
  editing the agent, restart the workspace container or nothing changes. The
  server logs `opencode agent available` when a workspace's agent resolves, and
  warns if it does not — that warning almost always means a container that has
  been up since before the edit.

Nothing has to be copied anywhere: `YAMMER_AGENT_FILE` is bind-mounted read-only
into every workspace container, so a fresh workspace with an empty working
directory still gets the agent. That is deliberate — an agent that lived in the
project being worked on would leave every new workspace running with screen-
shaped output and no permission gate at all. Editing it needs no image rebuild,
but does need the affected container restarted.

To fall back to OpenCode's default agent — expect screen formatting read aloud —
set `YAMMER_OPENCODE_AGENT=build`.

### Supervisor

Destructive things are gated by a spoken approval prompt in a second voice. The
flow is: something asks, `src/supervisor/` says what is about to happen, the user
answers with one word, and it is settled either way.

**Two things ask, and the supervisor cannot tell them apart.** OpenCode blocks a
tool call and publishes `permission.asked`; or Yammer itself is about to do
something irreversible outside any container, which today means a workspace
`delete`. Both arrive as an `ApprovalRequest`
([`src/supervisor/approval.ts`](src/supervisor/approval.ts)) — something to say,
optionally a pattern "always" would widen to, optionally a directory whose
contents are at stake, and a way to settle it. Everything source-specific is in
the two adapters and in `speech.ts`; the ask-listen-settle loop never branches on
where a request came from. Adding a third source means writing an adapter, not
touching the loop.

Which agent commands prompt is **not** configured here — it lives in the agent's
own permission rules in
[`.opencode/agent/yammer.md`](../.opencode/agent/yammer.md), because that is
where OpenCode reads it. Keep the list short: every entry costs a ~10 second
spoken round trip, and the container is what makes the list short in the first
place.

**What the prompt says about state, Yammer looked at itself.** Before asking, it
runs real `git` against the host-side working directory
([`src/git.ts`](src/git.ts)) and adds one clause: uncommitted changes, untracked
files, and — when the directory itself is going — commits that are on no remote.
A delete of an empty workspace and a delete of a week's work must not sound the
same. The observation never comes from the container: a summary written by the
thing being supervised is not evidence. It fails soft, and says nothing when
there is nothing to say, so that the clause stays worth hearing.

Four behaviours worth knowing before changing any of it:

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
- **An answer is never offered where it has nowhere to go.** Yammer's own
  actions have no pattern to remember, so the menu is "approve or deny" and a
  heard "always" settles as a one-time yes rather than reporting `always` — which
  would tell the user they had configured something that does not exist.

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

## Workspace containers

Each workspace is one container running one `opencode serve`, created by Yammer
over Podman's REST socket. Podman must be reachable — the server exits at
startup if it is not, because a Yammer that cannot create or load a workspace
would accept an utterance and then fail every command it is given:

```sh
systemctl --user enable --now podman.socket
```

**The image is never built on demand.** It is Arch plus `pacman -Syu`, so
building it inside `create` would turn "make me a workspace" into a four-minute
wait for a mirror. A missing image is an error naming the fix instead:

```sh
podman build -t localhost/yammer-opencode:latest -f containers/yammer-opencode/Containerfile .
```

A stale pinned image is the deliberate default; rebuild it when you want a newer
OpenCode. Four mounts go into each container:

| Host | Container | |
| --- | --- | --- |
| `$YAMMER_WORKSPACE_ROOT/<name>` | `/workspace` | rw — the work itself |
| `$YAMMER_STATE_DIR/opencode/<name>` | `/root/.local/share/opencode` | rw — **per workspace** |
| `$YAMMER_OPENCODE_AUTH` | `…/opencode/auth.json` | ro — the one shared thing |
| `$YAMMER_AGENT_FILE` | `/root/.config/opencode/agent/<agent>.md` | ro |

OpenCode's state directory is per workspace because N containers writing one
sqlite database is a corruption risk rather than a theoretical one. Credentials
are the exception, and they are laid back over the top of that mount read-only —
Podman orders nested mounts by path depth, so the shallower state directory
mounts first and `auth.json` lands inside it.

The agent comes from Yammer rather than from the project being worked on: a
fresh workspace has an empty working directory, so an agent living there would
mean new workspaces silently running with no TTS shaping and no permission gate.
Editing `$YAMMER_AGENT_FILE` needs no image rebuild, but does need the workspace
restarted — OpenCode reads agent files once at boot and never hot-reloads.

Ports are published on `127.0.0.1` only, with the host port chosen by the OS at
create time and recorded in the registry. Containers never need to reach each
other, so there is no shared network.

## Workspaces by voice

Four spoken commands, handled by Yammer itself and never forwarded to OpenCode:

| Say | What happens |
| --- | --- |
| "create a workspace called space game" | container and directory, left **stopped** |
| "load space game" | starts it if stopped, waits for OpenCode, moves *this client* into it |
| "what workspaces do I have" | each name, its state, and which one you are in |
| "delete the space game workspace" | spoken approve/deny prompt, then the container, directory and record |

Three things about these are deliberate and worth knowing before changing them.

**`load` does not create.** A name Yammer does not know is a spoken error. The
name arrives as a routing model's reading of a Whisper transcript, so a name
that fails to resolve is at least as likely to be a mishearing as an intention,
and create-on-miss turns every mishearing into a junk container.

**Names are matched with separators removed.** Whisper decides on its own
whether a two-word name is one word — the same utterance came back as
"LiveCheck" and as "live check" in one sitting — so `space-game`, `space game`
and `SpaceGame` are one workspace. `create` refuses a name that only *sounds*
like an existing one, because two workspaces nobody can tell apart by voice are
two workspaces nobody can use.

**`delete` goes through the supervisor**, in its second voice, and silence is a
no. It is the most destructive thing in the system and it is triggered by the
least reliable input in it. The prompt says what is in the directory — Yammer's
own `git status` of it, not the workspace's account of itself — because "delete
space game" has to sound different when space game holds a week of uncommitted
work.

**A connection starts in no workspace, and `load` is how you enter one.** There
is no default: with several workspaces, any default is a guess about which
project an utterance meant, made by the side of the system with no screen to
show its guess. Speaking before entering one is an error that names the way out
(`no_workspace`), which costs one utterance and is never wrong. A reconnecting
client says `load` again.

**The active workspace is per connection.** Several clients may be connected at
once, each in its own workspace, and nothing one client says moves another. Two
clients in the same workspace is supported too, and they get a conversation
each — sharing one would interleave two people's dialogue into one history. One
turn at a time is likewise per connection: `busy` means "you are busy", never
"the server is".

Each failure has its own sentence — `src/router/commands.ts`'s
`spokenWorkspaceError` is the whole list, one per `LifecycleFailure`. That is
the point of the kinds existing: "OpenCode inside it never answered" and "it
doesn't know the agent" mean different things to go and do.

## Shape

```
src/
  index.ts            entrypoint: config, warm-up, listen
  startup.ts          reads the workspace registry and checks it against Podman
  lifecycle.ts        create/load/stop/delete for one workspace
  config.ts           environment → Config
  protocol.ts         wire types + codecs (mirrors ../protocol/PROTOCOL.md)
  ws-server.ts        handshake, framing, connection lifecycle
  turn.ts             turn state machine: STT → route → act → speak
  workspace.ts        projects, and the sessions clients hold in them
  git.ts              what is actually at stake in a working directory
  wav.ts              PCM/WAV helpers
  stt/groq.ts         OpenAI-compatible transcription
  container/runtime.ts     what Yammer needs from a container runtime
  container/podman.ts      that, over Podman's REST socket
  container/fake.ts        that, in memory, for tests
  registry/store.ts        the workspace registry's file on disk
  registry/reconcile.ts    registry vs. reality, as a pure diff
  router/commands.ts  the meta-command catalogue
  router/router.ts    the routing LLM call
  opencode/client.ts  the HTTP client for one workspace's OpenCode
  opencode/permissions.ts  watches for blocked tool calls, answers them
  supervisor/supervisor.ts spoken approval prompt in a second voice
  supervisor/approval.ts   what gets approved, whoever asked for it
  supervisor/keywords.ts   approve/always/deny matching (pure, tested)
  supervisor/speech.ts     every sentence the supervisor says
  tts/kokoro.ts       sentence-chunked streaming synthesis
```

## Tests

```sh
npm test        # node --test over src/**/*.test.ts
```

Coverage is deliberately narrow, and the thing every suite has in common is that
it guards a **silent** failure. Most of this repo fails loudly — a bad model id
404s, a protocol mismatch closes the socket — so those paths need no test.

- `supervisor/keywords.test.ts` — a mistranscription classified as "approve"
  force-pushes a branch and looks like nothing went wrong. The fixtures are real
  Whisper output shapes.
- `protocol.test.ts` — cross-language codec conformance, against frames dumped
  from the real Python client.
- `ws-server.test.ts` — handshake, close codes, busy rejection, permission
  routing, and the invariant that every turn exit path emits `turn.end`. Also
  the two-client cases: server-side state that looks per-client but is not
  raises nothing at all, it just answers one person out of another person's
  project.
- `registry/store.test.ts` and `registry/reconcile.test.ts` — a workspace that
  quietly drops out of the registry, or a status that is confidently wrong,
  produce no error at the time and a mystery later.
- `lifecycle.test.ts` — `load` has several distinct failure points and each owes
  the user a different spoken sentence. Two of them collapsing into one message
  is invisible until someone is standing there being told the wrong thing.
- `opencode/client.test.ts` — one test, for one observed hang: a rootless
  published port accepts connections before OpenCode is listening behind it, and
  an unbounded probe waits there forever with nothing in the log.
- `router/commands.test.ts` — the spoken half of the workspace commands: that
  every failure kind reads out differently, that `load` never creates, and that
  a denied `delete` deletes nothing. All three are silent in the only way that
  counts here — they typecheck, log nothing, and are wrong out loud.
- `supervisor/approval.test.ts` — what the user was asked and what their answer
  did: that "always" is never offered where nothing can be remembered, and that
  an unreachable OpenCode still leaves the agent stopped.
- `git.test.ts` — the grounded clause, against real repositories in temporary
  directories. A fake `git` would only prove this module agrees with someone's
  memory of porcelain output, which is exactly the thing that would be wrong.

## Evaluating router models

```sh
npm run eval:router                                   # default: current default + two DeepSeek variants
npm run eval:router -- <model-id> [<model-id> ...]     # any OpenRouter-compatible model
```

Scores model(s) against `src/router/eval/cases.ts` by driving the real `Router`
class. Reports accuracy by category, latency, and — separately — any
**critical misroutes**: a `forward` case in the adversarial set (e.g. "start a
new file for the session handler") routed to a destructive command instead.
Those are the failure that matters; a wrong `report_usage` just answers a
question that wasn't asked, but a wrong `new_session` silently discards the
conversation and a wrong `delete_workspace` destroys a working directory. When
two or more models run, disagreements between them are listed separately at the
end.

Workspace cases are scored on the **extracted name** as well as the action,
compared after the same normalisation the server applies — so a model that
answers "Space Game" for `space-game` is right, and one that answers "parser
project" for `parser` is a miss reported in its own section.

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

Set `takesWorkspace: true` if it needs a name, and read it from
`context.argument` — the router fills that slot only for commands that declare
it, so a name the model volunteers on a `forward` can never be read as an
argument. `context.say` speaks before the command finishes (for anything with a
wait in it) and `context.confirm` is the spoken approve/deny gate.
