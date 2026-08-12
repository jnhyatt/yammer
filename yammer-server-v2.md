# Yammer — Architecture & Requirements (v2)

## Purpose and status

This doc supersedes the earlier "Voice Interface for OpenCode — v1 Requirements" doc for architecture purposes. That doc's functional goals (hands-free voice control of a codebase via OpenCode) still hold; this doc reflects how the system has evolved during design: from a thin client + single always-on OpenCode server, to a single coordinating daemon ("Yammer") that supervises multiple isolated per-project OpenCode instances.

As before: this is a functional/architectural requirements doc, not an implementation spec. Named technologies are defaults, not mandates — raise a better option if you see one rather than silently deviating or silently complying with a worse one.

## Naming

The always-on server-side daemon is called **Yammer**. It is the single long-lived process that owns STT, TTS, routing, meta-commands, OpenCode-container orchestration, and permission supervision. "Yammer" refers to this whole daemon, not just the voice/audio pipeline piece of it.

## High-level architecture

```
[Client: desktop app, later mobile]
   — wake-word detection (local)
   — audio framing
   — WebSocket connection to Yammer
        |
        v
[Yammer daemon — single long-lived process, ON THE HOST, not containerized]
   — STT (Whisper, via API)
   — Routing LLM (OpenRouter, cheap/fast model)
   — Meta-command handling (including workspace lifecycle)
   — TTS (Kokoro)
   — Supervisor (non-LLM approve/deny gate)
   — Workspace registry (workspace name -> container/socket/status)
   — Container lifecycle (drives the container runtime directly)
        |
        v  (per active workspace, one of potentially several)
[OpenCode container: "space-game"]      [OpenCode container: "yammer"]      ...
   — OpenCode server, scoped to one
     project's working directory
     inside the container
```

Each project the user works on gets its own container ("workspace"), each running its own isolated OpenCode server instance. Yammer is the single point of contact for clients and the single thing that talks to all the OpenCode containers — clients never talk to an OpenCode container directly.

**Yammer itself runs uncontainerized, as an ordinary host process.** This is a requirement, not an incidental deployment choice. Yammer creates, starts, stops, and deletes containers, and it owns the host directories those containers mount; a containerized Yammer would need the container runtime's own socket, which would make the Yammer container host-equivalent and defeat the isolation the design is built on. The containers are the sandbox; Yammer is the thing outside it holding the keys.

## Components

### 1. Client (desktop, v1)

Unchanged from the prior doc:
- Runs wake-word detection locally (two distinct wake words: start/stop recording).
- Frames audio at 16kHz mono, sends one complete buffer per utterance to Yammer over WebSocket, followed by an explicit end-of-audio marker.
- Plays back synthesized audio received from Yammer over the same connection.
- Carries no STT/TTS/LLM logic of its own — stays thin so future clients (mobile, etc.) only need to reimplement audio capture and wake-word detection.

The client is not aware of workspaces. Active workspace is server-side state (see "Workspace lifecycle"); the user learns which workspace they are in by hearing it, not by anything the client renders or tracks.

### 2. Yammer daemon

The single always-on server-side process. Responsibilities:

**STT** — Whisper via hosted API (not self-hosted for now). Converts a client's audio buffer into a transcript. **One STT path serves the whole system**, including permission answers — there is no second transcription stack.

**Routing LLM** — a cheap, fast OpenRouter model that receives the transcript and decides what happens to it:
- Forward it as a prompt to the currently active workspace's OpenCode instance, or
- Treat it as a meta-command (see below) and handle it directly, without involving OpenCode at all.
- Router scope for v1: transcripts route only to the client's **active workspace**. No cross-workspace addressing (e.g. asking about a different project without switching to it first) in v1 — explicit non-goal, revisit if it turns out to be needed in practice.
- Router inputs: transcript, plus minimal state needed to route well (active workspace, enough context to sanity-check things like "new session" or "compact"). Not full conversation history.
- **Workspace meta-commands carry an argument** — a workspace name — which the router must extract from the transcript rather than merely classifying into. Names arrive from speech recognition and will vary in spacing, hyphenation, and capitalisation for one underlying workspace. Yammer resolves the spoken name against the registry by normalised match. A name that does not resolve is an error spoken back to the user; it is never silently coerced to the nearest candidate, and it never implicitly creates a workspace.

**Meta-commands** — triggered via the router, executed directly by Yammer without going to OpenCode. Two categories:
- *Carried over from v1*: usage/cost reporting, session compaction, starting a new session. Not an exhaustive list — expect to grow.
- *New in v2*: workspace lifecycle — create, load, list, delete. See "Workspace lifecycle" below.
- Meta-command results are spoken back via canned/templated responses (e.g. "workspace loaded") rather than routed through an LLM to phrase — keeps these fast and predictable.

**TTS** — Kokoro, server-side (not client-side), for the reasons already established: keeps future clients from needing a local TTS runtime.

**Supervisor** — a non-LLM approve/deny gate for a narrow set of operations. Key design points:
- **What it gates is operations that cross the container boundary, plus a short list of in-sandbox actions that destroy unrecoverable work through the bind mount.** It is deliberately *not* a general gate on what an agent does inside its own sandbox — see "Sandboxing and the safety boundary" below.
- It is invoked from two directions, and both must be supported: by an OpenCode permission event from inside a container, and **directly by Yammer itself** for its own destructive meta-commands. Workspace `delete` goes through the supervisor. The request the supervisor speaks and settles is therefore an abstraction over both sources, not OpenCode's permission payload specifically.
- The approval loop is deliberately LLM-free end to end: the request being read aloud is not paraphrased or summarized by an LLM at speech-generation time. Any summarization needed must be grounded in Yammer's own observation of actual state — for example a real `git diff` run by Yammer against the host-side workspace directory — never accepted as a description handed over by the OpenCode container.
- The spoken response is captured via Silero VAD on the client for turn-framing, transcribed through the same STT path as everything else, and compared against exact strings ("approve" / "always" / "deny") — anything else triggers a re-prompt, with a timeout that resolves to deny rather than looping indefinitely.
- Scope for v1: one global policy, applied uniformly across all workspaces. Per-workspace policy is an explicit non-goal for now.

**Workspace registry** — Yammer's map of workspace name to container handle, connection info (socket/port), host-side directory, and status. Persisted (see "Persistence" below) so Yammer can reconcile its view of the world against reality (e.g. actual running containers) on restart, rather than losing track of everything.

### 3. OpenCode containers ("workspaces")

- One container per project. A container holds one running OpenCode server instance, scoped to that project's working directory inside the container's filesystem — this is the access boundary that keeps OpenCode from ever seeing the host's full file tree.
- Naming: workspace name is user-chosen at creation (e.g. "space-game", "yammer") and used both as the container identifier and as the name used in voice meta-commands. Yammer sanitizes it into a valid container/DNS name; collisions are rejected with a spoken error rather than resolved automatically.
- **Working directories are host directories that Yammer owns, bind-mounted into the container.** Yammer needs to read them directly — that is what makes supervisor prompts groundable in a real `git diff` rather than in agent narration, and what lets Yammer mediate anything that has to leave the machine.
- Provisioning: a freshly created workspace starts with an empty working directory. Populating it is an explicit step, and for v1 it is an ordinary agent action — the container has network egress and public repositories need no credentials, so `git clone` of a public repo is just work the agent does. **Private repositories are out of scope for v1**; when that breaks down, the answer is a new meta-command or a Yammer-mediated tool, not credentials in the container.
- **The agent definition and its permission rules come from Yammer, not from the project being worked on.** A freshly created workspace has an empty working directory and therefore no project-level agent config; if the agent lived there, new workspaces would silently run with screen-shaped output and no permission gate at all. Bind-mounting it read-only from a Yammer-owned host path is preferred over baking it into the image: it gives every workspace the same agent while keeping the prompt editable without an image rebuild. (A restart of the affected container is still required either way — OpenCode reads agent files once at boot.)
- **Yammer reaches each container over a published loopback port**, allocated per workspace and recorded in the registry. Containers never need to reach each other, so no shared container network is required.
- Each OpenCode container runs the `yammer` agent (per the v1 doc's agent-selection design) for anything Yammer forwards to it — TTS-appropriate output, no code blocks/markdown, spoken-language descriptions of code.
- No push credentials live inside these containers. Anything touching a remote is mediated by Yammer.

## Sandboxing and the safety boundary

This section replaces the "tool surface philosophy" of an earlier draft, which stated the intent far too strongly and implied design work that is not needed.

- **The container is the safety boundary.** Not the tool surface, and not command-string filtering. The agent is sandboxed; within that sandbox it gets a general-purpose shell and the ordinary tool surface, because that is what makes it useful.
- **Almost anything the agent can do from inside the sandbox is acceptable.** There is no tiered classification of shell commands to design, maintain, or reason about. Vanilla sandboxing does nearly all of the work.
- **The two things that are not inside the sandbox get handled directly.** Credentials that would let the agent affect the outside world are simply not present in the container — push credentials above all. And operations Yammer performs on the user's behalf outside the container (deleting a workspace) go through the supervisor, because those genuinely escape the boundary.
- **The bind mount is the one hole in "the container is the boundary", and it keeps a small permission gate.** A workspace working directory is a host directory, so destructive shell actions inside the container reach real work outside it. Committed work is cheap to re-provision; uncommitted work is not recoverable by any means. So a short list of obvious sanity gates stays — wholesale deletion and history-destroying resets, the "don't delete everything" class — routed through the supervisor like any other approval. This is a deliberately small list, not a revival of tiered tool policy: it exists because a bind mount is not a sandbox, and it should stay short enough that a voice round trip is rare.
- **Work leaves a workspace via the host, not via the container.** Yammer owns the working directory, so pushing is something the user does from the host afterward. v1 builds no push mechanism, mediated or otherwise.

## Workspace lifecycle

Exposed to the user as voice meta-commands: create, load, list, delete. Internally, more state than those four verbs suggests:

- **Not yet created** — workspace name is unknown to Yammer.
- **Created, stopped** — container exists but isn't running.
- **Starting** — container is up, OpenCode server inside it isn't ready yet. Yammer should give spoken feedback during this state (e.g. "starting up space-game, one sec") rather than leaving the user hanging.
- **Ready / active** — container running, OpenCode server responding, and (for the requesting client) marked as that client's active workspace.
- **Torn down** — deleted; container and its associated directory removed.

`load` is a compound operation (start-if-stopped → wait-for-OpenCode-ready → mark active for this client) with several distinct failure points — container fails to start, OpenCode inside it fails to come up, port/socket never becomes reachable. Each failure mode should produce a distinct spoken error (per the existing error-handling approach: synthesize and speak what went wrong, don't attempt automatic recovery).

**`load` does not create.** Loading a name Yammer does not know is a spoken error, not an implicit creation — `create` is the only thing that creates a workspace. Workspace names reach Yammer through speech recognition and a routing model, so a name that fails to resolve is at least as likely to be a mishearing as an intention, and the cost of guessing wrong is a junk container named after a mistranscription. The cost of the alternative is one extra utterance the first time a workspace is used.

**`delete` goes through the supervisor.** It is the most destructive operation in the system, it is triggered by a routing model's reading of an imperfect transcript, and it destroys a working directory. It gets a spoken approve/deny prompt like any other boundary-crossing action.

**Active workspace is per-client, not global.** Each client connection tracks its own active workspace. A second client (e.g. a future mobile client) connecting concurrently must not disturb another client's active workspace — this was a deliberate correction from an earlier draft of this design that assumed a single global "active workspace" pointer.

## Concurrency

v1 allows concurrency, deliberately.

- **Multiple clients may connect at once**, each with its own active workspace. The earlier one-client-at-a-time restriction is lifted.
- **Multiple clients may share one workspace.** Two clients with the same active workspace drive the same OpenCode server, and that is a supported workflow — one agent investigating while another makes changes, or two agents making disjoint changes, is a normal way to work.
- **An OpenCode session belongs to a (client, workspace) pair, not to a workspace.** Two clients in one workspace get two independent conversations. Sharing one session between clients would interleave two people's dialogue into one history, which is not the workflow anyone wants.
- **Keeping concurrent agents from clobbering each other is the user's responsibility, not Yammer's.** They occasionally fight. That is a known and accepted cost of the workflow, not a problem for Yammer to solve with locking.
- **Verified, not assumed:** OpenCode supports this. Two sessions prompted concurrently against one `opencode serve` in one working directory both completed successfully with ~18 seconds of genuine overlap, each running multiple file-writing tool calls, with a consistent resulting tree. No session lock is required.
- **One turn at a time remains true per client.** A person cannot say two things at once, so an utterance arriving while that client's turn is in flight is still rejected with the busy earcon rather than queued. This is a per-connection rule now, not a global one.
- Permission requests are matched to the client that owns them by session identity. A permission whose owning client has disconnected is refused rather than left blocking the container.

## Persistence

Yammer needs durable state across its own restarts for at least:
- The workspace registry (name → container identifier/handle → host directory → status → creation time).

Store this in the OS-appropriate application data directory rather than a hardcoded path — e.g. `~/.local/share/yammer/` on Linux, `~/Library/Application Support/yammer/` on macOS, `%LOCALAPPDATA%\yammer\` on Windows. Use a library that resolves this correctly per-platform rather than hand-rolling path logic per OS.

Format: a flat file (JSON) is sufficient for v1 — no need for a database given the expected size and query complexity of this data. On startup, Yammer should reconcile its persisted view against actual running containers (e.g. query the container runtime) to catch drift — containers that died externally, or that exist but aren't in Yammer's records.

Per-workspace OpenCode state (its database, snapshots, logs) is per-workspace. It must not be a single host directory shared by every container: concurrent writers to one OpenCode database across N containers is a corruption risk, not a theoretical one. Provider credentials are the exception — those are shared into each container read-only.

## Explicit non-goals for v2

- Cross-workspace routing (addressing a non-active workspace without switching to it first).
- Per-workspace tool or permission policy (global policy only, for now).
- Private-repository provisioning, and any credential handling inside containers beyond the read-only provider credentials OpenCode needs to call its model.
- Any Yammer-mediated push or other remote-write mechanism. Work leaves a workspace by the user pushing from the host.
- Locking, queueing, or any other mechanism for keeping concurrent agents in one workspace out of each other's way.
- Mobile client (still desktop-only; architecture is designed to make a future mobile client's addition low-effort, per-client active-workspace tracking being one concrete example of that).
- Automatic reconciliation/recovery beyond "detect drift on startup and report it" — no self-healing of crashed containers, no automatic retries.

## Carried over from v1 (still applicable, not restated in full here)

- Framing/verbatim transcript forwarding to OpenCode.
- Agent selection: `yammer` agent used for all Yammer-forwarded prompts, selected per-session/per-call rather than via `default_agent`, so TUI usage is unaffected.
- Error handling: synthesize and speak errors via Kokoro; no voice-based error recovery.
- Two-wake-word delimiting on the client; no semantic/adaptive end-of-utterance detection.
