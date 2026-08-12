# Yammer v2 — Implementation Plan

The plan for getting from the v1 server (one client, one project, two static
containers) to the v2 architecture in
[`yammer-server-v2.md`](yammer-server-v2.md): one uncontainerized daemon
supervising several per-project OpenCode containers.

Read the requirements doc first. This file is *how* and *in what order*, not
*what* or *why* — where the two disagree, the requirements doc wins.

**Progress: phases 0, 1 and 2 are done** — the load-bearing ones. Each phase
below carries its own status, including what was deviated from and why. Phases
3–5 are unstarted.

## Where v1 was

Three things in `server/src/index.ts` bound the whole process to one project,
and every phase below is downstream of unpicking them:

- `OpenCodeSession(config.opencode)` — one base URL, one project directory, one
  session id, one resolved model. *(Phase 0: split into a per-workspace
  [`OpenCodeClient`](server/src/opencode/client.ts) and a per-(client,
  workspace) `WorkspaceSession`.)*
- `PermissionWatcher(baseUrl, projectDir)` — one SSE stream, started once at
  boot, filtered by a single `?directory=`. *(Phase 0: one stream per workspace,
  with a session-id routing table in front of it.)*
- `startServer` — closes a second client with `4004`. *(Still true; phase 4.)*

`TurnManager` and `PermissionSupervisor` are already built per-connection in
`handleConnection`, which was a genuine head start. They just closed over the
shared `OpenCodeSession`, so per-connection meant "per connection, same
project."

Deployment is two Quadlet units with a fixed `%h/yammer:/workspace` bind mount
and a shared `~/.local/share/opencode`.

## Phasing

Six phases. Each one leaves a working system, and each has a stated done-when
that is checkable rather than felt. Phases 0–2 are the load-bearing ones; 3–5
are additive.

| Phase | What lands | Depends on | Status |
|---|---|---|---|
| 0 | `Workspace` handle; one workspace, from today's config | — | **done** |
| 1 | Registry, persistence, startup reconciliation | 0 | **done** |
| 2 | Container lifecycle behind a runtime interface | 1 | **done** |
| 3 | Workspace meta-commands + router argument extraction | 2 | not started |
| 4 | Multi-client, per-client active workspace, protocol v3 | 3 | not started |
| 5 | Supervisor generalization + permission policy rework | 3 | not started |

Phase 5 depends on 3, not 4 — it can land in parallel with multi-client work.

---

## Phase 0 — the `Workspace` handle ✅

Pure refactor. No behavior change, no new capability, no config change. The
point is to make every OpenCode-bound singleton addressable by workspace while
there is still exactly one of them, so the fan-out is a mechanical change
reviewed on its own rather than tangled into orchestration work.

- Introduce a `Workspace` type owning `{name, baseUrl, workDir, status,
  OpenCodeSession, PermissionWatcher}`.
- Introduce a `WorkspaceRegistry` with, for now, exactly one entry constructed
  from `YAMMER_OPENCODE_URL` + `YAMMER_PROJECT_DIR`.
- `Deps.opencode` becomes `Deps.workspaces`. `TurnManager` resolves the
  workspace at the start of a turn rather than holding one from construction.
- **Sessions become per (client, workspace), not per workspace.** This is the
  shape the concurrency decision requires; building it now costs nothing and
  retrofitting it later touches every call site again. The session id moves out
  of `OpenCodeSession` into a per-connection map keyed by workspace.
- `PermissionWatcher.onAsked` currently filters against
  `deps.opencode.currentSessionId` and dispatches to one `TurnManager`. Replace
  with a `sessionId -> owning turn` registry. A request whose owner is gone is
  refused, which the existing `supervisor.refuse` path already does.

**Done when:** `npm test` passes unchanged, and a live turn still works end to
end against the existing Quadlet deployment.

**Watch for:** `OpenCodeSession.resolveModel` caches the resolved model on the
instance. Per-workspace instances mean per-workspace model resolution, which is
correct but means the "OpenCode's default model may not work" failure (see
AGENTS.md) now surfaces once per workspace rather than once per boot.

### What landed

[`workspace.ts`](server/src/workspace.ts) holds `Workspace`,
`WorkspaceRegistry`, `WorkspaceSession`, and `ClientWorkspaces` (one client's
active workspace plus its session in each one it has visited).
`opencode/session.ts` became [`opencode/client.ts`](server/src/opencode/client.ts)
because it no longer holds a session id; every session-scoped call takes one
explicitly.

Two deviations, both removing an ordering problem rather than adding scope:

- **The plan says `Workspace` owns an `OpenCodeSession`, and also that the
  session id moves out of it.** Those cannot both hold in one class, so it split
  in two: `OpenCodeClient` per workspace (transport, agent, cached model),
  `WorkspaceSession` per (client, workspace) (the id).
- **`PermissionSupervisor` no longer takes a watcher or an abort callback at
  construction.** It takes a `PermissionContext` (`reply` + `abortTurn`) per
  request. With a permission stream per workspace, "which server do I answer"
  has to travel with the request — and this is the shape phase 5 generalizes
  anyway. It also broke the circular construction between the supervisor and
  the turn manager.

Three tests were *added* to `ws-server.test.ts` rather than the suite passing
literally unchanged: the claim/refuse routing table is new code whose failure
mode is a silently wedged `opencode serve` holding a blocked tool call forever.

**Verified:** 93/93 tests, clean typecheck, and 13 checks driving the real
classes against a live `opencode serve` 1.18.15 — including two clients holding
distinct sessions in one workspace, which is the capability the phase adds. A
full voice turn was confirmed later, during phase 1 (see below).

---

## Phase 1 — registry, persistence, reconciliation ✅

Still no container orchestration. The registry gains a durable backing file and
learns to notice that the world disagrees with it.

- JSON registry at the platform data dir. `env-paths` is the obvious dependency
  and keeps with the doc's "don't hand-roll per-OS path logic". The server has
  three runtime dependencies today; this is worth being the fourth, and it is
  the only new one this plan adds.
- Persisted per workspace: name, container id, host directory, allocated port,
  status, creation time.
- Startup reconciliation: list containers carrying a `yammer.workspace` label,
  diff against the file, log and speak nothing — the doc's non-goal list is
  explicit that drift is reported, not healed.
- Registry writes are small and infrequent; write-temp-then-rename is enough,
  and there is no concurrent writer to design around because Yammer is one
  process.

**Done when:** killing a container out from under Yammer and restarting Yammer
produces an accurate status, and a registry file that has been hand-edited into
nonsense produces a clear startup error rather than a confusing later one.

### What landed

[`registry/store.ts`](server/src/registry/store.ts) is the file —
`~/.local/share/yammer/workspaces.json` via `env-paths`, temp-then-rename,
strict parsing. [`registry/reconcile.ts`](server/src/registry/reconcile.ts) is
the diff, a pure function over records and containers.
[`startup.ts`](server/src/startup.ts) sequences the two and is what `index.ts`
now calls.

**The one real deviation: the Podman socket work moved up from phase 2.** You
cannot list containers carrying a label without something that talks to a
runtime, and phase 1's done-when is specifically about status accuracy. So
[`container/runtime.ts`](server/src/container/runtime.ts) declares the narrow
interface reconciliation needs — `list(labelKey)`, nothing else — and
[`container/podman.ts`](server/src/container/podman.ts) implements it over the
REST socket. Phase 2 widens the interface to `create`/`start`/`stop`/`remove`/
`inspect` rather than inventing it. This front-loads the schedule risk named at
the bottom of this file, which turned out to be about half an hour rather than
the hour budgeted; the `node:http` `socketPath` gotcha is now in AGENTS.md.

Smaller decisions worth knowing:

- **A running container reads as `starting`, not `ready`.** `ready` means
  OpenCode inside it answered, and nothing at startup has spoken to OpenCode.
- **`missing` joined `WorkspaceStatus`** — registered, but the container is
  gone. It exists because drift is reported rather than healed, so "gone" has to
  be something Yammer can hold and say.
- **A removed container does not remove the record.** The host directory still
  holds the user's work.
- **An unreachable container runtime is a warning, not a fatal.** v1's workspace
  is an `opencode serve` started outside Yammer, so a machine with no
  `podman.socket` still runs Yammer fine — it just cannot verify statuses. That
  becomes fatal in phase 2, when the runtime is load-bearing.
- **A name in both the registry and `YAMMER_PROJECT_DIR` is a hard error**, not
  a precedence rule: silently shadowing one with the other would make `load` do
  something other than what the name says.
- New config: `YAMMER_STATE_DIR`, `YAMMER_PODMAN_SOCKET`. New dependency:
  `env-paths`, the only one this plan adds.

**Verified:** 123/123 tests (30 new), clean typecheck, and 13 live checks
against real Podman 6.0.2 — a real labelled container created, listed through
the real socket, reconciled, then `podman rm -f`'d out from under Yammer and
reconciled again to `missing` with the corrected status written back to disk.
The hand-edited-into-nonsense case fails at startup with:

```
the workspace registry at /…/workspaces.json is malformed:
workspace "x": `containerId` must be a non-empty string
```

Also done here, since it was outstanding from phase 0: **a real end-to-end voice
turn.** Kokoro synthesized the utterance, it went through real Groq STT
(transcript exact), the real routing model (2.0s), a real OpenCode turn (4.4s),
and came back as 14.8s of speech — `turn.end outcome=forwarded`, 13.4s to first
audio.

---

## Phase 2 — container lifecycle ✅

The first genuinely new subsystem. Everything here sits behind one interface so
that the lifecycle state machine is testable without a container runtime.

- Widen the `ContainerRuntime` interface phase 1 introduced — it has `list`
  today — to `create`, `start`, `stop`, `remove`, `inspect`, and add a fake for
  tests. This mirrors how `ws-server.test.ts` already fakes its four network
  dependencies, so the pattern is established rather than invented.
- The transport is already there:
  [`container/podman.ts`](server/src/container/podman.ts) talks to the REST
  socket over `node:http`. The two things that cost time — `fetch` not doing
  Unix sockets, and `all=true` — are settled and recorded in AGENTS.md.
- **An unreachable runtime becomes fatal in this phase.** Phase 1 treats it as a
  warning because v1's workspace needs no container; from here Yammer cannot do
  its job without one.
- Port allocation: bind `127.0.0.1:<port>:4096` per workspace, record the port
  in the registry, and handle the allocation race by letting the OS pick and
  reading it back rather than by scanning for a free port first.
- Per-workspace OpenCode state gets its own volume. Provider credentials mount
  read-only. The shared `~/.local/share/opencode` mount in
  [`quadlet/yammer-opencode.container`](quadlet/yammer-opencode.container) must
  not survive into the template — its own comment already warns about
  concurrent sqlite writers, and N workspaces makes that the normal case.
- The agent file bind-mounts read-only from a Yammer-owned host path.
- Readiness: poll the container's OpenCode until it answers, with a timeout that
  produces its own distinct spoken error. The doc requires spoken feedback
  during `starting`; the supervisor already establishes the pattern of speaking
  mid-turn, so this reuses it rather than needing new protocol.

  This is the edge that phase 1 deliberately left missing: reconciliation calls
  a running container `starting`, and nothing else promotes it, so `ready` is
  currently unreachable for a persisted workspace — and
  [`index.ts`](server/src/index.ts) only watches permissions for `ready` ones.

  **The probe is `app.agents()`**, i.e. the existing
  [`verifyAgent`](server/src/opencode/client.ts). OpenCode publishes no health
  endpoint — its `app` namespace is `log` and `agents`, nothing else — so
  readiness has to be a real request, and this one distinguishes three states
  that a TCP-level check collapses into one:

  - connection refused — the container is up but OpenCode has not bound the port
    yet. Retryable, and the common case.
  - answers, agent present → `ready`.
  - answers, agent absent → `failed` immediately, no further polling. Retrying
    cannot fix it: OpenCode reads `.opencode/agent/*.md` once at boot and never
    hot-reloads, so an agent file that was not visible when the container's
    OpenCode started never will be. That is exactly the bind-mount-went-wrong
    case this phase introduces, and `verifyAgent`'s own comment already notes it
    is otherwise invisible until the first forwarded turn — where it surfaces as
    an unshaped reply mid-conversation instead of an error at creation time.

  So readiness and agent verification are one call, and this phase merges them
  rather than polling and then verifying.

  Poll on `create` and `load`, where the user is waiting and can be spoken to.
  Startup additionally does one bounded, parallel, non-blocking pass over
  containers found running, so that `list` does not report `starting` for a
  workspace that has been up for a week; that pass must never delay `listening`.

  A timeout leaves the workspace `failed`, not `starting` — otherwise the next
  `load` starts polling a container that has already established it will not
  answer. Budget the timeout against a measured cold OpenCode boot in a fresh
  container rather than a guessed number.

**Done when:** the lifecycle state machine has tests against the fake runtime
covering each of `load`'s failure points, and a real create/load/delete cycle
works by hand against Podman.

**Watch for:** the OpenCode image is Arch + `pacman -Syu` at build time.
Creating a workspace must not rebuild it. Decide the image refresh story
explicitly — a stale pinned image is a better default than a workspace creation
that takes four minutes.

### What landed

[`lifecycle.ts`](server/src/lifecycle.ts) holds the four verbs;
[`container/runtime.ts`](server/src/container/runtime.ts) grew `create`,
`start`, `stop`, `remove` and `inspect`;
[`container/podman.ts`](server/src/container/podman.ts) implements them and
[`container/fake.ts`](server/src/container/fake.ts) is the in-memory equivalent
the tests run against. `WorkspaceLifecycleError` carries a `kind`, which is how
each of `load`'s failure points keeps its own spoken error in phase 3 — the
module itself says nothing aloud.

**Image refresh, decided:** a pinned image, never built on demand. `create`
against a missing image is an `image-missing` error naming the `podman build`
command. Rebuilding inside `create` would make "make me a workspace" a
four-minute wait on an Arch mirror, and a stale image is the better failure.

Decisions worth knowing:

- **Ports are allocated by asking for `host_port: 0`**, not by scanning. Podman
  assigns it at *create* time, so `inspect` reads it back before the container
  has run and the registry records it immediately. A port that later disagrees
  with the record is `port-drift` and refuses to load, because the client's base
  URL is already built and carrying on would mean prompting whatever else now
  answers there.
- **Credentials mount read-only inside the read-write per-workspace state
  mount.** Podman orders nested mounts by depth, so this works; it is verified
  live rather than assumed, in both directions (the state dir is writable, and
  `auth.json` is not).
- **`create` leaves the workspace stopped.** The doc's lifecycle has a
  "created, stopped" state, and a create that also waited for readiness would
  have two failure sets in one operation.
- **`delete` will not remove a directory outside `YAMMER_WORKSPACE_ROOT`.**
  `workDir` comes off a file a person can edit, and the function ends in a
  recursive delete.
- **Startup got a non-blocking status refresh**, after `listen` and deliberately
  not awaited: reconciliation can only say a container is up, so without it a
  workspace running for a week still reads `starting`.
- New config: `YAMMER_OPENCODE_IMAGE`, `YAMMER_WORKSPACE_ROOT`,
  `YAMMER_AGENT_FILE`, `YAMMER_OPENCODE_AUTH`,
  `YAMMER_WORKSPACE_READY_SECONDS`, `YAMMER_WORKSPACE_STOP_SECONDS`. No new
  dependencies.

**One thing the plan got wrong**, found by running it rather than by reading it:
a rootless published port is bound by Podman's port forwarder before OpenCode is
listening behind it, so a probe during that window is *accepted and then never
answered*. `fetch` has no default timeout, so the first live `load` hung
indefinitely with nothing in the log after "waiting for OpenCode" — the
readiness deadline never got a chance to fire, because the loop never got back
to checking it. `probeAgent` now takes a bounded `AbortSignal.timeout`, and
[`opencode/client.test.ts`](server/src/opencode/client.test.ts) reproduces the
hang against a socket that accepts and stays silent.

**Verified:** 154/154 tests (31 new), clean typecheck, and 28 live checks
against real Podman 6.0.2 covering the whole cycle — create, the four mounts,
readiness, stop, load again, a rejected duplicate name, delete, and `load` on a
deleted workspace. A cold container answers in about 2s; `load` returns ready in
about 7s, the difference being one bounded probe against that startup window.

---

## Phase 3 — meta-commands and router arguments

- Broaden `MetaCommand.run`. Today it takes a `SessionController`
  ([`commands.ts`](server/src/router/commands.ts)); it needs a context carrying
  the registry, the [`WorkspaceManager`](server/src/lifecycle.ts), and the
  active workspace's session where one applies.
- Add `create`, `load`, `list`, `delete`. The machinery exists — this phase is
  the voice on top of it, which means mapping each `WorkspaceLifecycleError`
  kind to its own spoken sentence, speaking during `starting` (~7s, measured),
  and putting `delete` behind the supervisor. **`load` does not create** — an
  unknown name is a spoken error. This is the single most important behavioral
  detail in the phase: `load` reaches Yammer as a routing model's reading of a
  Whisper transcript, and create-on-miss turns every mishearing into a junk
  container.
- Router schema gains a workspace-name slot. Name resolution is normalised
  matching against the registry (case, spacing, hyphenation) — phase 2's
  `sanitizeWorkspaceName` is that normalisation and already lands "Space Game"
  and "space game" on one workspace. A miss is an error rather than a
  nearest-neighbour guess.
- **Re-run `npm run eval:router`.** Two independent reasons, either sufficient:
  the schema is changing from a closed enum to an enum plus free text, and
  AGENTS.md already records a model that did not reliably honour strict
  `json_schema`; and the critical-misroute class now includes workspace delete,
  which is more destructive than the `new_session` false positive that set the
  current default model. Add workspace cases to
  [`cases.ts`](server/src/router/eval/cases.ts) before running it, not after.

**Done when:** the eval passes with no critical misroutes on the expanded case
set, and creating, loading, listing, and deleting a workspace all work by voice.

---

## Phase 4 — multi-client and protocol v3

- Drop the `4004` single-client close. Per-client state is already
  per-connection after phase 0; the active workspace joins it.
- **Busy stays per-connection.** A person cannot say two things at once, so
  `turn.rejected {reason: "busy"}` keeps its meaning for one client. Two clients
  sharing a workspace is supported and unlocked, per the doc's concurrency
  section — verified against a live OpenCode, two concurrent sessions in one
  directory with ~18s of real overlap and a consistent resulting tree.
- Protocol bump to 3: `4004` retired, new error codes (`workspace_unknown`,
  `workspace_start_failed`, and whatever phase 2's failure points need).
- The client learns nothing about workspaces. It has no screen; the user finds
  out which workspace they are in by hearing it.
- Per AGENTS.md, [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md),
  `server/src/protocol.ts`, and `client/src/yammer_client/protocol.py` change
  together, and the dumped frame fixture gets regenerated:
  `cd client && .venv/bin/python tools/dump_protocol_frames.py`.

**Done when:** two clients hold sessions in different workspaces simultaneously
without interfering, `protocol.test.ts` passes against regenerated fixtures, and
`ws-server.test.ts` covers the two-client case.

---

## Phase 5 — supervisor generalization and permission policy

- **Make the supervisor source-agnostic.** It currently takes an OpenCode
  `PermissionRequest` — id, permission name, patterns, an `always` field. A
  workspace delete has none of those. Introduce an approval-request abstraction
  (spoken description, whether "always" is even offered, a settle callback),
  with OpenCode permissions as one implementation and Yammer's own destructive
  meta-commands as another.
- Route workspace `delete` through it.
- Rework the agent's permission rules for the sandbox framing. Most of the
  current ask-list becomes `allow` — `git push` in particular needs no gate,
  because with no credentials in the container it simply fails. What stays is
  the short bind-mount sanity list: wholesale deletion and history-destroying
  resets, the "don't delete everything" class. Keep it short enough that a ~10s
  voice round trip stays rare.
- Grounding: any summarization the supervisor speaks must come from Yammer's own
  observation of the host-side directory (a real `git diff`), never from the
  container's description of itself. This is why workspace directories are
  Yammer-owned bind mounts in the first place.

**Done when:** `keywords.test.ts` still passes, a workspace delete prompts and
settles by voice, and a denied delete leaves the workspace intact.

---

## Cleanup, once phase 2 lands

Yammer no longer runs in a container, so these describe something that no longer
exists and should go rather than rot:

- [`containers/yammer-server/Containerfile`](containers/yammer-server/Containerfile)
- [`quadlet/yammer-server.container`](quadlet/yammer-server.container) and
  `yammer-server.build`
- [`quadlet/yammer.network`](quadlet/yammer.network) — containers never need to
  reach each other, and Yammer reaches them on published loopback ports.
- [`quadlet/yammer-opencode.container`](quadlet/yammer-opencode.container) stops
  being a unit and becomes the template Yammer applies per workspace.

`YAMMER_PROJECT_DIR` and `YAMMER_OPENCODE_URL` stop being meaningful as single
values and are replaced by a workspace root directory, image name, runtime
socket path, and readiness timeout. Per the repo's own convention, each goes in
the config module, the README table, and `.env.example` together.

## Risks worth naming

- **Router argument extraction is the highest-variance piece.** It is the only
  change that makes a model's output structurally harder, and the repo already
  has a recorded instance of a model quietly failing strict schema mode. The
  eval is the control; run it before trusting the phase.
- ~~**The Podman socket work is the likeliest schedule surprise.**~~ Retired in
  full. `list` landed in phase 1 in about half an hour; `create` with mounts,
  labels and a published port landed in phase 2 and was not where the trouble
  was. The trouble was on the *other* side of the socket — see phase 2's note on
  the port that accepts before anything is listening.
- **Container start latency is new user-facing latency.** Measured in phase 2:
  a cold container answers in ~2s, and `load` returns ready in ~7s. That is
  short enough that the spoken "one sec" covers it and long enough that it must
  be spoken. Phase 3 is where that sentence gets said.
- ~~**Disk.**~~ Largely retired. `delete` reclaims the container, the working
  directory and the per-workspace OpenCode state, verified live. What remains is
  ordinary: N working copies is N working copies, and nothing warns about it.
