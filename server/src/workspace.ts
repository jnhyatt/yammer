/**
 * Workspaces, and the sessions people hold in them.
 *
 * A **workspace** is one project Yammer can work on: a directory, an OpenCode
 * server scoped to it, and the permission stream that server publishes. From
 * phase 2 each one is a container Yammer starts on demand; today there is
 * exactly one, standing in front of the `opencode serve` that the Quadlet unit
 * already runs. Nothing below assumes which of those is true.
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

import { basename } from "node:path";

import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { OpenCodeClient, type UsageStats } from "./opencode/client.ts";
import { PermissionWatcher, type PermissionRequest } from "./opencode/permissions.ts";
import type { WorkspaceRecord } from "./registry/store.ts";
import type { PermissionContext } from "./supervisor/supervisor.ts";

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

export class WorkspaceUnknownError extends Error {}

export class Workspace {
  readonly name: string;
  /** Host-side directory, which Yammer owns and bind-mounts from phase 2. */
  readonly workDir: string;
  readonly baseUrl: string;
  readonly opencode: OpenCodeClient;
  readonly permissions: PermissionWatcher;

  /**
   * The container this workspace runs in, or null when it is not Yammer's to
   * manage. Null is what v1's single workspace looks like: an `opencode serve`
   * started by a Quadlet unit, which Yammer talks to but must never stop,
   * remove, or count as drift.
   */
  readonly containerId: string | null;

  status: WorkspaceStatus;

  /** sessionId -> whoever is driving that conversation right now. */
  private readonly owners = new Map<string, (request: PermissionRequest) => void>();

  constructor(options: {
    name: string;
    workDir: string;
    baseUrl: string;
    opencode: OpenCodeClient;
    permissions: PermissionWatcher;
    containerId?: string | null;
    status?: WorkspaceStatus;
  }) {
    this.name = options.name;
    this.workDir = options.workDir;
    this.baseUrl = options.baseUrl;
    this.opencode = options.opencode;
    this.permissions = options.permissions;
    this.containerId = options.containerId ?? null;
    this.status = options.status ?? "ready";
  }

  /** Begin consuming this workspace's permission stream. */
  startWatching(): void {
    this.permissions.onAsked((request) => this.dispatch(request));
    this.permissions.start();
  }

  stopWatching(): void {
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
 * Every workspace Yammer knows about.
 *
 * Built at startup from two sources that will become one: the persisted
 * registry (`registry/store.ts`), and the single config-derived workspace v1
 * runs against. The second disappears when phase 2 makes every workspace a
 * container Yammer created.
 */
export class WorkspaceRegistry {
  private readonly byName = new Map<string, Workspace>();
  /** The workspace a client is in before it says otherwise. */
  readonly defaultName: string;

  constructor(workspaces: readonly Workspace[], defaultName: string) {
    for (const workspace of workspaces) this.byName.set(workspace.name, workspace);
    if (!this.byName.has(defaultName)) {
      throw new Error(`default workspace ${defaultName} is not in the registry`);
    }
    this.defaultName = defaultName;
  }

  get(name: string): Workspace | undefined {
    return this.byName.get(name);
  }

  /** Resolve a name, or fail in the way phase 3 speaks aloud. */
  require(name: string): Workspace {
    const workspace = this.byName.get(name);
    if (!workspace) {
      throw new WorkspaceUnknownError(`no workspace called ${name}`);
    }
    return workspace;
  }

  list(): Workspace[] {
    return [...this.byName.values()];
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
 * resumes rather than restarts. Nothing here changes the active workspace yet —
 * phase 3's `load` is what gives the user a way to say so.
 */
export class ClientWorkspaces {
  private readonly registry: WorkspaceRegistry;
  private readonly sessions = new Map<string, WorkspaceSession>();
  private owner: PermissionOwner | null = null;
  private activeName: string;

  constructor(registry: WorkspaceRegistry) {
    this.registry = registry;
    this.activeName = registry.defaultName;
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

  get active(): Workspace {
    return this.registry.require(this.activeName);
  }

  /** The client's conversation in its active workspace, created on demand. */
  session(): WorkspaceSession {
    const workspace = this.active;
    const existing = this.sessions.get(workspace.name);
    if (existing) return existing;

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
 * The workspace v1 implies: one, from `YAMMER_OPENCODE_URL` and
 * `YAMMER_PROJECT_DIR`, with no container of its own.
 *
 * Named after the project directory rather than something like "default",
 * because that name becomes something the user says out loud in phase 3, and
 * "the yammer workspace" is already how they would refer to it.
 */
export function workspaceFromConfig(config: Config): Workspace {
  return new Workspace({
    name: basename(config.opencode.projectDir),
    workDir: config.opencode.projectDir,
    baseUrl: config.opencode.baseUrl,
    opencode: new OpenCodeClient({
      baseUrl: config.opencode.baseUrl,
      directory: config.opencode.projectDir,
      providerId: config.opencode.providerId,
      modelId: config.opencode.modelId,
      agent: config.opencode.agent,
    }),
    permissions: new PermissionWatcher(config.opencode.baseUrl, config.opencode.projectDir),
    status: "ready",
  });
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
      // The container sees the bind mount, not the host path. Phase 2 fixes the
      // mount point; until it does, no record-backed workspace is reachable
      // anyway, so this is the honest placeholder rather than a wrong guess.
      directory: record.workDir,
      providerId: config.opencode.providerId,
      modelId: config.opencode.modelId,
      agent: config.opencode.agent,
    }),
    permissions: new PermissionWatcher(baseUrl, record.workDir),
    containerId: record.containerId,
    status: record.status,
  });
}

/**
 * Assemble the registry from the persisted records plus the config workspace.
 *
 * A name in both is a hard error rather than a precedence rule. It means the
 * user has a workspace named after their `YAMMER_PROJECT_DIR`, and silently
 * shadowing one with the other would make `load` do something other than what
 * the name says — with the wrong one being the one that still holds their work.
 */
export function buildRegistry(config: Config, records: readonly WorkspaceRecord[]): WorkspaceRegistry {
  const fallback = workspaceFromConfig(config);
  const workspaces = records.map((record) => workspaceFromRecord(record, config));

  if (workspaces.some((workspace) => workspace.name === fallback.name)) {
    throw new Error(
      `workspace "${fallback.name}" is both in the registry and derived from ` +
        `YAMMER_PROJECT_DIR (${config.opencode.projectDir}); rename one`,
    );
  }

  return new WorkspaceRegistry([fallback, ...workspaces], fallback.name);
}
