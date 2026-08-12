/**
 * Workspaces, and the sessions people hold in them.
 *
 * A **workspace** is one project Yammer can work on: a host directory, a
 * container running an OpenCode scoped to it, and the permission stream that
 * OpenCode publishes. Every one of them is created by Yammer, so a fresh
 * install has none at all and a client is in none until it says `load`.
 *
 * A **session** is a conversation, and belongs to a (client, workspace) pair
 * rather than to the workspace. Two people working on the same project get two
 * conversations; one person moving between projects gets one conversation per
 * project, each of which survives being left and come back to. That is why
 * `OpenCodeClient` holds no session id and `WorkspaceSession` does.
 *
 * The consequence worth stating is the permission routing. OpenCode publishes
 * permission requests on a stream that is per *server*, tagged with a session
 * id — so with more than one conversation in flight against one workspace, the
 * session id is the only thing that says whose question it is. `claimSession`
 * builds that routing table, and a request whose owner has gone away is refused
 * rather than left blocking OpenCode forever.
 */

import type { Config } from "./config.ts";
import { CONTAINER_WORKDIR } from "./container/runtime.ts";
import { log } from "./log.ts";
import { OpenCodeClient, type UsageStats } from "./opencode/client.ts";
import { PermissionWatcher, type PermissionRequest } from "./opencode/permissions.ts";
import type { WorkspaceRecord } from "./registry/store.ts";
import type { PermissionContext } from "./supervisor/approval.ts";

/**
 * Where a workspace is in its lifecycle.
 *
 * `stopped`, `starting` and `ready` are the container states the requirements
 * doc names; `failed` is a start that did not finish. `missing` is the odd one
 * out and is not a lifecycle state at all — it means the registry has a
 * workspace whose container has been removed out from under Yammer. It exists
 * because drift is reported rather than healed, so "gone" has to be something
 * Yammer can hold and say rather than something it silently repairs.
 *
 * Phase 2 is what makes anything other than `ready` and `missing` occur; today
 * the one workspace's OpenCode is started outside Yammer and assumed up.
 */
export const WORKSPACE_STATUSES = [
  "stopped",
  "starting",
  "ready",
  "failed",
  "missing",
] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Whoever is listening for a blocked tool call in a session it owns. */
export interface PermissionOwner {
  handlePermission(request: PermissionRequest, context: PermissionContext): void;
}

/**
 * A name that resolves to nothing. Carries the name, because the spoken form of
 * this is "I don't know a workspace called X" — saying which one failed is the
 * whole difference between a useful error and a shrug.
 */
/**
 * The client is not in a workspace, and has asked for something that needs one.
 *
 * Its own type rather than a `WorkspaceUnknownError` with an empty name: "I
 * don't know a workspace called nothing" is not a sentence, and the fix is
 * different — there is nothing wrong with what they said, they just have to say
 * where first.
 */
export class NoWorkspaceError extends Error {
  constructor() {
    super("no active workspace");
  }
}

export class WorkspaceUnknownError extends Error {
  readonly workspace: string;

  constructor(name: string) {
    super(`no workspace called ${name}`);
    this.workspace = name;
  }
}

export class Workspace {
  readonly name: string;
  /** Host-side directory, which Yammer owns and bind-mounts from phase 2. */
  readonly workDir: string;
  readonly baseUrl: string;
  readonly opencode: OpenCodeClient;
  readonly permissions: PermissionWatcher;

  /**
   * The container this workspace runs in, or null when it is not Yammer's to
   * manage. Nothing builds a null one now that every workspace comes from the
   * registry — but the lifecycle still refuses to stop, remove or delete the
   * directory of one, because that guard is the last thing between a bad record
   * and a recursive delete.
   */
  readonly containerId: string | null;

  /** Published loopback port, or null for a workspace Yammer did not publish. */
  readonly port: number | null;

  /** ISO 8601. Informational — nothing branches on it. */
  readonly createdAt: string;

  status: WorkspaceStatus;

  /** sessionId -> whoever is driving that conversation right now. */
  private readonly owners = new Map<string, (request: PermissionRequest) => void>();

  private watching = false;

  constructor(options: {
    name: string;
    workDir: string;
    baseUrl: string;
    opencode: OpenCodeClient;
    permissions: PermissionWatcher;
    containerId?: string | null;
    port?: number | null;
    createdAt?: string;
    status?: WorkspaceStatus;
  }) {
    this.name = options.name;
    this.workDir = options.workDir;
    this.baseUrl = options.baseUrl;
    this.opencode = options.opencode;
    this.permissions = options.permissions;
    this.containerId = options.containerId ?? null;
    this.port = options.port ?? null;
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.status = options.status ?? "ready";
  }

  /**
   * What to persist, or null for a workspace that is not Yammer's to persist.
   *
   * The live objects are the single source of truth and records are derived
   * from them, rather than the two being kept in step by hand — which is how a
   * status ends up correct in memory and stale on disk.
   */
  toRecord(): WorkspaceRecord | null {
    if (this.containerId === null || this.port === null) return null;
    return {
      name: this.name,
      containerId: this.containerId,
      workDir: this.workDir,
      port: this.port,
      status: this.status,
      createdAt: this.createdAt,
    };
  }

  /**
   * Begin consuming this workspace's permission stream.
   *
   * Idempotent, because `load` calls it on every load and a workspace can be
   * loaded by a second client while the first is still in it. Without the
   * guard that would register a second handler and answer every permission
   * twice, and OpenCode's second reply is a 4xx on an already-settled request.
   */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    this.permissions.onAsked((request) => this.dispatch(request));
    this.permissions.start();
  }

  stopWatching(): void {
    this.watching = false;
    this.permissions.stop();
  }

  claimSession(sessionId: string, deliver: (request: PermissionRequest) => void): void {
    this.owners.set(sessionId, deliver);
  }

  releaseSession(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  /**
   * Hand a blocked tool call to whoever owns its session.
   *
   * An unowned request is one nobody can hear: a session from a disconnected
   * client, or another OpenCode client's prompt entirely. Refusing is the only
   * safe answer — leaving it would wedge `opencode serve` holding the tool call
   * indefinitely, and answering it would be approving something unattended.
   */
  private dispatch(request: PermissionRequest): void {
    const deliver = this.owners.get(request.sessionID);
    if (!deliver) {
      log.warn("permission for an unowned session, refusing", {
        workspace: this.name,
        id: request.id,
        session: request.sessionID,
      });
      void this.permissions.reply(request.id, "reject").catch((cause) => {
        log.error("could not refuse an unowned permission", {
          id: request.id,
          error: String(cause),
        });
      });
      return;
    }
    deliver(request);
  }
}

/**
 * Every workspace Yammer knows about: one per persisted record, and nothing
 * else.
 *
 * It can legitimately be **empty**. A fresh install has created no workspaces
 * yet, and there is no longer a config-derived fallback standing in for one —
 * that was v1's single `opencode serve`, and keeping it would mean a name in
 * `list` that answers on a port nothing serves.
 */
export class WorkspaceRegistry {
  private readonly byName = new Map<string, Workspace>();

  constructor(workspaces: readonly Workspace[] = []) {
    for (const workspace of workspaces) this.byName.set(workspace.name, workspace);
  }

  get(name: string): Workspace | undefined {
    return this.byName.get(name);
  }

  /** Resolve a name, or fail in the way `spokenWorkspaceError` reads out. */
  require(name: string): Workspace {
    const workspace = this.byName.get(name);
    if (!workspace) throw new WorkspaceUnknownError(name);
    return workspace;
  }

  list(): Workspace[] {
    return [...this.byName.values()];
  }

  /** Register a newly created workspace. Names are unique; a clash is a bug. */
  add(workspace: Workspace): void {
    if (this.byName.has(workspace.name)) {
      throw new Error(`workspace ${workspace.name} already exists`);
    }
    this.byName.set(workspace.name, workspace);
  }

  remove(name: string): void {
    this.byName.delete(name);
  }

  /** Everything worth persisting, in registration order. */
  records(): WorkspaceRecord[] {
    return this.list()
      .map((workspace) => workspace.toRecord())
      .filter((record): record is WorkspaceRecord => record !== null);
  }
}

/** Structural contract the meta-commands depend on. */
export interface SessionController {
  prompt(text: string, signal?: AbortSignal): Promise<string>;
  startNewSession(): Promise<void>;
  compact(): Promise<void>;
  usage(): Promise<UsageStats>;
}

/**
 * One client's conversation in one workspace.
 *
 * Holds the session id, keeps the workspace's permission routing table pointed
 * at its owner, and is the thing meta-commands are handed.
 */
export class WorkspaceSession implements SessionController {
  readonly workspace: Workspace;
  private readonly owner: PermissionOwner;
  private sessionId: string | null = null;

  constructor(workspace: Workspace, owner: PermissionOwner) {
    this.workspace = workspace;
    this.owner = owner;
  }

  /** Null until the first turn in this workspace creates a session. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** What the supervisor needs to settle a request raised by this session. */
  permissionContext(): PermissionContext {
    return {
      reply: (id, reply) => this.workspace.permissions.reply(id, reply),
      abortTurn: () => this.abort(),
    };
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const id = await this.workspace.opencode.createSession();
    this.adopt(id);
    log.info("opencode session started", { workspace: this.workspace.name, session: id });
    return id;
  }

  /** Take ownership of a session id, giving up the previous one. */
  private adopt(id: string): void {
    if (this.sessionId) this.workspace.releaseSession(this.sessionId);
    this.sessionId = id;
    this.workspace.claimSession(id, (request) =>
      this.owner.handlePermission(request, this.permissionContext()),
    );
  }

  async prompt(text: string, signal?: AbortSignal): Promise<string> {
    const id = await this.ensureSession();
    return this.workspace.opencode.prompt(id, text, signal);
  }

  /** No-op before the first turn — there is nothing running to stop. */
  async abort(): Promise<void> {
    if (!this.sessionId) return;
    await this.workspace.opencode.abort(this.sessionId);
  }

  async startNewSession(): Promise<void> {
    const previous = this.sessionId;
    const id = await this.workspace.opencode.createSession();
    this.adopt(id);
    log.info("opencode session replaced", {
      workspace: this.workspace.name,
      previous,
      session: id,
    });
  }

  async compact(): Promise<void> {
    await this.workspace.opencode.compact(await this.ensureSession());
  }

  async usage(): Promise<UsageStats> {
    return this.workspace.opencode.usage(await this.ensureSession());
  }

  /** The client is gone. Stop claiming permissions nobody can answer. */
  release(): void {
    if (!this.sessionId) return;
    this.workspace.releaseSession(this.sessionId);
  }
}

/**
 * One client's view of the workspaces: which one it is in, and its conversation
 * in each one it has visited.
 *
 * Sessions are created lazily and kept after leaving a workspace, so going back
 * resumes rather than restarts. `load` is the only thing that moves a client,
 * and it moves exactly one — the active workspace is per connection, so a
 * second client is never dragged along by the first.
 *
 * **A client starts in no workspace at all**, and says `load` to enter one.
 * There is no default to fall into: with several workspaces, picking one would
 * mean forwarding "fix the parser bug" into whichever project happened to sort
 * first, and the user has no screen to notice from. Being nowhere is a spoken
 * error naming the fix, which costs one utterance and is never wrong.
 */
export class ClientWorkspaces {
  private readonly registry: WorkspaceRegistry;
  private readonly sessions = new Map<string, WorkspaceSession>();
  private owner: PermissionOwner | null = null;
  private activeName: string | null = null;

  constructor(registry: WorkspaceRegistry) {
    this.registry = registry;
  }

  /**
   * Name the owner of every session this client opens.
   *
   * Separate from construction only because that owner is the TurnManager,
   * which needs the client context to exist first. It must be attached before
   * any turn runs; `session()` is where that would otherwise go wrong quietly.
   */
  attach(owner: PermissionOwner): void {
    this.owner = owner;
  }

  /** The workspace this client is in, or null if it is not in one. */
  get active(): Workspace | null {
    if (this.activeName === null) return null;
    const workspace = this.registry.get(this.activeName);
    if (workspace) return workspace;
    // Deleted underneath the client — by this client in an earlier turn, or by
    // another one. Landing it somewhere else would be worse than landing it
    // nowhere: the next utterance would go to a project the user never named.
    log.warn("active workspace is gone", { workspace: this.activeName });
    this.activeName = null;
    return null;
  }

  /** The name of the workspace this client is in. Spoken by `list`. */
  get activeWorkspaceName(): string | null {
    return this.activeName;
  }

  /**
   * Move this client into another workspace. What `load` does last.
   *
   * Per-client, deliberately: a second client sharing the daemon must not be
   * moved by this one saying "load space game". The registry lookup is what
   * makes an unknown name fail here rather than on the next utterance.
   */
  setActive(name: string): void {
    this.registry.require(name);
    this.activeName = name;
  }

  /**
   * The client's conversation in its active workspace, created on demand.
   *
   * Throws `NoWorkspaceError` when the client is not in one. Resolved late, at
   * the point a turn actually needs OpenCode, so that `create`, `load` and
   * `list` still work for a client that has nowhere to talk yet.
   */
  session(): WorkspaceSession {
    const workspace = this.active;
    if (!workspace) throw new NoWorkspaceError();
    const existing = this.sessions.get(workspace.name);
    // Same name, different workspace: deleted and recreated. The old session id
    // belongs to an OpenCode that no longer exists, so resuming it would prompt
    // into nothing.
    if (existing && existing.workspace === workspace) return existing;
    if (existing) existing.release();

    if (!this.owner) {
      throw new Error("client workspaces used before an owner was attached");
    }
    const session = new WorkspaceSession(workspace, this.owner);
    this.sessions.set(workspace.name, session);
    return session;
  }

  /** The client disconnected: release every permission claim it held. */
  release(): void {
    for (const session of this.sessions.values()) session.release();
    this.sessions.clear();
  }
}

/**
 * A workspace Yammer created and persisted.
 *
 * The OpenCode inside it may well not be running — nothing here connects, and
 * `startWatching` is deliberately the caller's decision, because a watcher
 * pointed at a stopped container would spend the process's life reconnecting to
 * a closed port.
 */
export function workspaceFromRecord(record: WorkspaceRecord, config: Config): Workspace {
  // Published on loopback, per the doc: containers never need to reach each
  // other, so there is no shared network and no hostname to resolve.
  const baseUrl = `http://127.0.0.1:${record.port}`;
  return new Workspace({
    name: record.name,
    workDir: record.workDir,
    baseUrl,
    opencode: new OpenCodeClient({
      baseUrl,
      // The container sees the bind mount, not the host path. `record.workDir`
      // is where the work lives on the host and is what Yammer reads directly;
      // OpenCode only ever hears about the mount point.
      directory: CONTAINER_WORKDIR,
      providerId: config.opencode.providerId,
      modelId: config.opencode.modelId,
      agent: config.opencode.agent,
    }),
    permissions: new PermissionWatcher(baseUrl, CONTAINER_WORKDIR),
    containerId: record.containerId,
    port: record.port,
    createdAt: record.createdAt,
    status: record.status,
  });
}

/** The registry, from the persisted records. Empty on a fresh install. */
export function buildRegistry(
  config: Config,
  records: readonly WorkspaceRecord[],
): WorkspaceRegistry {
  return new WorkspaceRegistry(records.map((record) => workspaceFromRecord(record, config)));
}
