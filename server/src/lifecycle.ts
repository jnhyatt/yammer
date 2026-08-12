/**
 * The workspace lifecycle: create, load, stop, delete.
 *
 * These are the four verbs the user says out loud, and phase 3 is what gives
 * them a voice. Everything here is the machinery underneath, kept deliberately
 * free of anything that speaks: this module throws `WorkspaceLifecycleError`
 * with a `kind`, and the caller decides what that sounds like.
 *
 * The `kind` is the point. The requirements doc asks for a distinct spoken
 * error at each of `load`'s failure points — the container is gone, it would
 * not start, OpenCode never answered, the agent is not there — and a single
 * "could not load space-game" would collapse four different fixes into one
 * unhelpful sentence.
 *
 * Two rules run through all of it:
 *
 * - **Drift is reported, never healed.** A container that vanished makes the
 *   workspace `missing`; it is not silently recreated, because the recreated
 *   one would be empty and the user would find that out much later.
 * - **The live `Workspace` objects are the source of truth**, and the registry
 *   file is derived from them at every mutation. Keeping two hand-maintained
 *   copies is how a status ends up right in memory and stale on disk.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Config } from "./config.ts";
import {
  CONTAINER_WORKDIR,
  ContainerNotFoundError,
  WORKSPACE_LABEL,
  type ContainerRuntime,
  type ContainerSpec,
} from "./container/runtime.ts";
import { log } from "./log.ts";
import { OpenCodeClient } from "./opencode/client.ts";
import { PermissionWatcher } from "./opencode/permissions.ts";
import { saveRegistry } from "./registry/store.ts";
import { Workspace, WorkspaceUnknownError, type WorkspaceRegistry } from "./workspace.ts";

/** The port OpenCode listens on inside every container. See the Containerfile. */
const CONTAINER_PORT = 4096;

/** OpenCode's state and config directories, as seen from inside the container. */
const CONTAINER_STATE_DIR = "/root/.local/share/opencode";
const CONTAINER_CONFIG_DIR = "/root/.config/opencode";

/** How often the readiness poll asks again. Fast: a cold start is ~2s. */
const POLL_INTERVAL_MS = 250;

/**
 * Why a lifecycle operation failed, in the terms the user needs to hear.
 *
 * Each maps to a different thing to do about it, which is the test for whether
 * a kind deserves to exist: `image-missing` means build the image,
 * `agent-missing` means the mount is wrong, `not-ready` means look at the
 * container's logs.
 */
export const LIFECYCLE_FAILURES = [
  "bad-name",
  "name-taken",
  "image-missing",
  "agent-file-missing",
  "container-gone",
  "start-failed",
  "port-drift",
  "not-ready",
  "agent-missing",
  "not-deletable",
] as const;

export type LifecycleFailure = (typeof LIFECYCLE_FAILURES)[number];

export class WorkspaceLifecycleError extends Error {
  readonly kind: LifecycleFailure;
  readonly workspace: string;

  constructor(kind: LifecycleFailure, workspace: string, message: string) {
    super(message);
    this.kind = kind;
    this.workspace = workspace;
  }
}

/**
 * Turn what the routing model heard into a container-safe name.
 *
 * Lowercase alphanumerics and single dashes, which is the intersection of what
 * Podman accepts and what a DNS label allows. Speech is the input here, so
 * "Space Game" and "space game" have to land on the same workspace or the user
 * gets two.
 */
export function sanitizeWorkspaceName(spoken: string): string {
  return spoken
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * The key two spoken names have to share to mean one workspace.
 *
 * Separators are dropped entirely, which is stronger than `sanitizeWorkspaceName`
 * and is the difference between a name that can be created and a name that can
 * be said again afterwards. Whisper decides on its own whether a two-word name
 * is two words: the same utterance came back as "LiveCheck" once and "live
 * check" the next time, which sanitize alone turns into `livecheck` and
 * `live-check` — two workspaces, one of which holds the user's work and neither
 * of which they can reliably address.
 *
 * So this is what resolution matches on, and what `create` refuses a collision
 * against: two workspaces that sound identical could never be told apart by
 * voice, which is the only way anyone talks to Yammer.
 */
export function workspaceMatchKey(spoken: string): string {
  return spoken.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface WorkspaceManagerOptions {
  config: Config;
  runtime: ContainerRuntime;
  registry: WorkspaceRegistry;
  /** Where the registry file lives. Rewritten on every mutation. */
  registryFile: string;
}

export class WorkspaceManager {
  private readonly config: Config;
  private readonly runtime: ContainerRuntime;
  private readonly registry: WorkspaceRegistry;
  private readonly registryFile: string;

  constructor(options: WorkspaceManagerOptions) {
    this.config = options.config;
    this.runtime = options.runtime;
    this.registry = options.registry;
    this.registryFile = options.registryFile;
  }

  /**
   * Make a workspace: a host directory, a container, and a record of both.
   *
   * Leaves it stopped. `create` and `load` are separate because the lifecycle
   * the doc describes has a "created, stopped" state, and because a create that
   * also waited for readiness would have two failure sets in one operation.
   *
   * The checks happen before anything is made, so a failure leaves nothing
   * behind — except when the container is made and then cannot be described, in
   * which case it is removed rather than leaked.
   */
  async create(spokenName: string): Promise<Workspace> {
    const name = sanitizeWorkspaceName(spokenName);
    if (name === "") {
      throw new WorkspaceLifecycleError(
        "bad-name",
        spokenName,
        `"${spokenName}" has no usable characters for a workspace name`,
      );
    }
    // By match key, not by name: `live-check` and `livecheck` are one workspace
    // as far as anyone speaking to Yammer is concerned.
    const key = workspaceMatchKey(name);
    const clash = this.registry.list().find((workspace) => workspaceMatchKey(workspace.name) === key);
    if (clash) {
      throw new WorkspaceLifecycleError(
        "name-taken",
        clash.name,
        `a workspace called ${clash.name} already exists`,
      );
    }
    await this.requireAgentFile(name);

    const workDir = join(this.config.workspaces.root, name);
    const stateDir = this.opencodeStateDir(name);
    await mkdir(workDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const containerId = await this.createContainer(name, workDir, stateDir);

    let port: number | null;
    try {
      const detail = await this.runtime.inspect(containerId);
      port = detail?.hostPort ?? null;
    } catch (cause) {
      await this.discard(containerId);
      throw cause;
    }
    if (port === null) {
      // Podman binds the published port at create time, so this means the spec
      // did not take. Leaving the container would leave one Yammer can never
      // reach and would have to report as drift forever.
      await this.discard(containerId);
      throw new WorkspaceLifecycleError(
        "start-failed",
        name,
        `the container for ${name} was created without a published port`,
      );
    }

    const workspace = this.buildWorkspace({
      name,
      workDir,
      containerId,
      port,
      status: "stopped",
    });
    this.registry.add(workspace);
    await this.persist();
    log.info("workspace created", { workspace: name, container: containerId.slice(0, 12), port, workDir });
    return workspace;
  }

  /**
   * Start-if-stopped, wait for OpenCode, and hand back a workspace that answers.
   *
   * Does **not** create. A name Yammer does not know is a `WorkspaceUnknownError`
   * because workspace names arrive as a routing model's reading of a Whisper
   * transcript, and create-on-miss turns every mishearing into a junk container.
   */
  async load(name: string): Promise<Workspace> {
    const workspace = this.registry.require(name);

    // The config-derived workspace is an `opencode serve` Yammer did not start.
    // There is nothing to start and nothing that would be safe to stop.
    if (workspace.containerId === null) return workspace;

    const detail = await this.runtime.inspect(workspace.containerId);
    if (!detail) {
      workspace.status = "missing";
      await this.persist();
      throw new WorkspaceLifecycleError(
        "container-gone",
        name,
        `the container for ${name} no longer exists`,
      );
    }

    if (detail.state !== "running") {
      workspace.status = "starting";
      try {
        await this.runtime.start(workspace.containerId);
      } catch (cause) {
        workspace.status = "failed";
        await this.persist();
        throw new WorkspaceLifecycleError(
          "start-failed",
          name,
          `the container for ${name} would not start: ${describe(cause)}`,
        );
      }
    }

    await this.checkPort(workspace);
    await this.waitUntilReady(workspace);
    workspace.startWatching();
    return workspace;
  }

  /** Stop the container, leaving the workspace and its directory alone. */
  async stop(name: string): Promise<void> {
    const workspace = this.registry.require(name);
    if (workspace.containerId === null) {
      throw new WorkspaceLifecycleError(
        "not-deletable",
        name,
        `${name} is not a container Yammer started, so it cannot stop it`,
      );
    }

    workspace.stopWatching();
    try {
      await this.runtime.stop(workspace.containerId, this.config.workspaces.stopSeconds);
    } catch (cause) {
      if (!(cause instanceof ContainerNotFoundError)) throw cause;
      workspace.status = "missing";
      await this.persist();
      throw new WorkspaceLifecycleError(
        "container-gone",
        name,
        `the container for ${name} no longer exists`,
      );
    }
    workspace.status = "stopped";
    await this.persist();
    log.info("workspace stopped", { workspace: name });
  }

  /**
   * Remove the container, the working directory, and the record.
   *
   * The destructive one. The supervisor gate in front of it is phase 3's job;
   * the guard that belongs *here* is the path check, because `workDir` comes
   * off a JSON file a person can edit and this function ends in `rm -rf`.
   */
  async delete(name: string): Promise<void> {
    const workspace = this.registry.require(name);
    if (workspace.containerId === null) {
      throw new WorkspaceLifecycleError(
        "not-deletable",
        name,
        `${name} is not a workspace Yammer created, so it will not delete it`,
      );
    }

    this.requireInside(this.config.workspaces.root, workspace.workDir, name);

    workspace.stopWatching();
    await this.runtime.remove(workspace.containerId);
    await rm(workspace.workDir, { recursive: true, force: true });
    await rm(this.opencodeStateDir(name), { recursive: true, force: true });
    this.registry.remove(name);
    await this.persist();
    log.info("workspace deleted", { workspace: name, workDir: workspace.workDir });
  }

  /**
   * One probe per already-running workspace, to promote it out of `starting`.
   *
   * Startup's pass. Reconciliation can only say a container is up, never that
   * the OpenCode inside it is answering, so without this a workspace that has
   * been running for a week still reports `starting`. Bounded to a single probe
   * each and run in parallel: this must never be why the server is slow to
   * listen, so nothing here waits and nothing here throws.
   */
  async refreshStatuses(): Promise<void> {
    const candidates = this.registry
      .list()
      .filter((workspace) => workspace.containerId !== null && workspace.status === "starting");
    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (workspace) => {
        try {
          const outcome = await workspace.opencode.probeAgent();
          if (outcome === "unreachable") return;
          workspace.status = outcome === "ready" ? "ready" : "failed";
          log.info("workspace status refreshed", {
            workspace: workspace.name,
            status: workspace.status,
          });
          if (workspace.status === "ready") workspace.startWatching();
        } catch (cause) {
          log.debug("could not refresh workspace status", {
            workspace: workspace.name,
            error: describe(cause),
          });
        }
      }),
    );
    await this.persist();
  }

  /**
   * Poll until OpenCode answers, or until it says something waiting cannot fix.
   *
   * `agent-missing` breaks out immediately rather than burning the whole
   * timeout: OpenCode reads agent files once at boot, so an agent that is not
   * there now will not appear, and the fix is a mount rather than patience.
   */
  private async waitUntilReady(workspace: Workspace): Promise<void> {
    const deadline = Date.now() + this.config.workspaces.readySeconds * 1000;
    workspace.status = "starting";
    log.info("waiting for OpenCode", { workspace: workspace.name, url: workspace.baseUrl });

    for (;;) {
      const outcome = await workspace.opencode.probeAgent();
      if (outcome === "ready") {
        workspace.status = "ready";
        await this.persist();
        log.info("workspace ready", { workspace: workspace.name });
        return;
      }
      if (outcome === "agent-missing") {
        workspace.status = "failed";
        await this.persist();
        throw new WorkspaceLifecycleError(
          "agent-missing",
          workspace.name,
          `OpenCode in ${workspace.name} does not know the ${workspace.opencode.agent} agent`,
        );
      }
      if (Date.now() >= deadline) {
        workspace.status = "failed";
        await this.persist();
        throw new WorkspaceLifecycleError(
          "not-ready",
          workspace.name,
          `OpenCode in ${workspace.name} did not answer within ` +
            `${this.config.workspaces.readySeconds} seconds`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Refuse to talk to a port the record does not name.
   *
   * Podman binds the published port at create time and keeps it across
   * restarts, so a disagreement means someone recreated the container by hand.
   * The `OpenCodeClient` has the old port baked into its base URL, so carrying
   * on would mean prompting whatever else now answers there.
   */
  private async checkPort(workspace: Workspace): Promise<void> {
    const detail = await this.runtime.inspect(workspace.containerId as string);
    const actual = detail?.hostPort ?? null;
    if (actual === null || actual === workspace.port) return;
    workspace.status = "failed";
    await this.persist();
    throw new WorkspaceLifecycleError(
      "port-drift",
      workspace.name,
      `${workspace.name} is recorded on port ${workspace.port} but its container ` +
        `is published on ${actual}; recreate the workspace`,
    );
  }

  private async createContainer(name: string, workDir: string, stateDir: string): Promise<string> {
    const spec: ContainerSpec = {
      name: `yammer-ws-${name}`,
      image: this.config.workspaces.image,
      labels: { [WORKSPACE_LABEL]: name },
      mounts: [
        { source: workDir, destination: CONTAINER_WORKDIR, readOnly: false },
        // Per workspace, deliberately: N containers writing one OpenCode sqlite
        // database is a corruption risk the requirements doc calls out by name.
        { source: stateDir, destination: CONTAINER_STATE_DIR, readOnly: false },
        // ...with the credentials laid back over the top of it read-only. The
        // one thing every workspace shares, because it is the one thing that
        // cannot be per-workspace.
        {
          source: this.config.workspaces.authFile,
          destination: `${CONTAINER_STATE_DIR}/auth.json`,
          readOnly: true,
        },
        // The agent comes from Yammer, not from the project. A fresh workspace
        // has an empty working directory, so an agent living there would mean
        // new workspaces silently running with no TTS shaping and no permission
        // gate at all.
        {
          source: this.config.workspaces.agentFile,
          destination: `${CONTAINER_CONFIG_DIR}/agent/${this.config.opencode.agent}.md`,
          readOnly: true,
        },
      ],
      publishContainerPort: CONTAINER_PORT,
    };

    try {
      return await this.runtime.create(spec);
    } catch (cause) {
      if (cause instanceof ContainerNotFoundError) {
        throw new WorkspaceLifecycleError(
          "image-missing",
          name,
          `the image ${this.config.workspaces.image} is not built: ${cause.message}`,
        );
      }
      throw cause;
    }
  }

  private buildWorkspace(options: {
    name: string;
    workDir: string;
    containerId: string;
    port: number;
    status: Workspace["status"];
  }): Workspace {
    const baseUrl = `http://127.0.0.1:${options.port}`;
    return new Workspace({
      name: options.name,
      workDir: options.workDir,
      baseUrl,
      opencode: new OpenCodeClient({
        baseUrl,
        directory: CONTAINER_WORKDIR,
        providerId: this.config.opencode.providerId,
        modelId: this.config.opencode.modelId,
        agent: this.config.opencode.agent,
      }),
      permissions: new PermissionWatcher(baseUrl, CONTAINER_WORKDIR),
      containerId: options.containerId,
      port: options.port,
      status: options.status,
    });
  }

  /** Yammer's own OpenCode state for one workspace. Internal, so under the state dir. */
  private opencodeStateDir(name: string): string {
    return join(this.config.state.dir, "opencode", name);
  }

  /**
   * Fail before creating anything if the agent file is not there.
   *
   * Checked here rather than left to the bind mount because Podman would
   * happily create an empty file at the mount point, and the workspace would
   * then start, look healthy, and fail readiness with `agent-missing` — the
   * right error for the wrong reason, one container too late.
   */
  private async requireAgentFile(name: string): Promise<void> {
    const path = this.config.workspaces.agentFile;
    try {
      const info = await stat(path);
      if (info.isFile()) return;
    } catch {
      // Falls through to the same error: unreadable and absent are one problem.
    }
    throw new WorkspaceLifecycleError(
      "agent-file-missing",
      name,
      `the agent definition ${path} is missing; set YAMMER_AGENT_FILE`,
    );
  }

  /** Best-effort cleanup of a container that will never be usable. */
  private async discard(containerId: string): Promise<void> {
    try {
      await this.runtime.remove(containerId);
    } catch (cause) {
      log.warn("could not remove a half-created container", {
        container: containerId.slice(0, 12),
        error: describe(cause),
      });
    }
  }

  /**
   * Refuse to recursively delete anything outside the workspace root.
   *
   * `workDir` is read from a JSON file that a person can and does edit, and the
   * caller of this deletes it recursively. One hand-edit away from `$HOME` is
   * too close to leave to care.
   */
  private requireInside(root: string, candidate: string, name: string): void {
    const within = relative(resolve(root), resolve(candidate));
    if (within === "" || within.startsWith("..") || resolve(candidate) === resolve(root)) {
      throw new WorkspaceLifecycleError(
        "not-deletable",
        name,
        `${name}'s directory ${candidate} is not inside ${root}; refusing to delete it`,
      );
    }
  }

  private async persist(): Promise<void> {
    await saveRegistry(this.registryFile, this.registry.records());
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
