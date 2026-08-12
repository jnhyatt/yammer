/**
 * The workspace lifecycle, against a fake runtime.
 *
 * The suite exists for one reason the requirements doc states directly: `load`
 * is a compound operation with several distinct failure points, and each has to
 * produce its own spoken error. Every one of those points gets a test here,
 * because the alternative is discovering that two of them say the same thing
 * while talking to a container that will not start.
 *
 * The happy paths are cheaper to check by hand and are checked here anyway,
 * since they are what the failure tests are a deviation from.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { Config } from "./config.ts";
import { FakeRuntime } from "./container/fake.ts";
import { ContainerRuntimeError, WORKSPACE_LABEL } from "./container/runtime.ts";
import {
  WorkspaceLifecycleError,
  WorkspaceManager,
  sanitizeWorkspaceName,
} from "./lifecycle.ts";
import { setLogLevel } from "./log.ts";
import { loadRegistry } from "./registry/store.ts";
import {
  buildRegistry,
  WorkspaceUnknownError,
  type Workspace,
  type WorkspaceRegistry,
} from "./workspace.ts";

const IMAGE = "localhost/yammer-opencode:latest";

interface Harness {
  config: Config;
  runtime: FakeRuntime;
  manager: WorkspaceManager;
  registry: WorkspaceRegistry;
  registryFile: string;
  root: string;
}

const roots: string[] = [];

before(() => setLogLevel("error"));

/**
 * Every registry a test built, so the watchers can be shut down afterwards.
 *
 * `load` starts a permission watcher, which is a reconnecting SSE loop against
 * a port nothing is listening on. Left running, it keeps the test process alive
 * forever — the suite passes and then hangs, which is a worse failure than a
 * red test because it looks like an infrastructure problem.
 */
const registries: WorkspaceRegistry[] = [];

async function harness(overrides: Partial<Config["workspaces"]> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "yammer-lifecycle-"));
  roots.push(root);

  const agentFile = join(root, "yammer.md");
  await writeFile(agentFile, "# yammer agent\n", "utf8");
  await mkdir(join(root, "project"), { recursive: true });

  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "t",
    stt: { baseUrl: "", apiKey: "", model: "" },
    router: { baseUrl: "", apiKey: "", model: "" },
    opencode: { baseUrl: "http://127.0.0.1:4096", projectDir: join(root, "project"), agent: "yammer" },
    state: { dir: join(root, "state") },
    container: { socketPath: "/nonexistent.sock" },
    workspaces: {
      image: IMAGE,
      root: join(root, "workspaces"),
      agentFile,
      authFile: join(root, "auth.json"),
      // Short, because two tests deliberately wait it out.
      readySeconds: 0.4,
      stopSeconds: 1,
      ...overrides,
    },
    supervisor: { voice: "bm_george", answerSeconds: 12, maxAttempts: 3 },
    tts: { modelId: "", dtype: "q8" as const, voice: "af_heart", device: "cpu" as const },
    logLevel: "error" as const,
    envFile: null,
  } satisfies Config;

  const runtime = new FakeRuntime();
  const registry = buildRegistry(config, []);
  registries.push(registry);
  const registryFile = join(root, "state", "workspaces.json");
  return {
    config,
    runtime,
    registry,
    registryFile,
    root,
    manager: new WorkspaceManager({ config, runtime, registry, registryFile }),
  };
}

/** Decide what the OpenCode inside a workspace's container will say. */
function answers(workspace: Workspace, ...replies: ("ready" | "unreachable" | "agent-missing")[]): void {
  let index = 0;
  workspace.opencode.probeAgent = async () => replies[Math.min(index++, replies.length - 1)]!;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  for (const registry of registries) {
    for (const workspace of registry.list()) workspace.stopWatching();
  }
  const { rm } = await import("node:fs/promises");
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("names", () => {
  test("turns what the router heard into something Podman accepts", () => {
    assert.equal(sanitizeWorkspaceName("Space Game"), "space-game");
    assert.equal(sanitizeWorkspaceName("space game"), "space-game");
    assert.equal(sanitizeWorkspaceName("  Yammer!  "), "yammer");
    assert.equal(sanitizeWorkspaceName("a...b"), "a-b");
  });

  test("has nothing to say about a name that is all punctuation", () => {
    assert.equal(sanitizeWorkspaceName("!?!"), "");
    assert.equal(sanitizeWorkspaceName(""), "");
  });
});

describe("create", () => {
  test("makes a directory, a container and a record", async () => {
    const h = await harness();
    const workspace = await h.manager.create("Space Game");

    assert.equal(workspace.name, "space-game");
    assert.equal(workspace.status, "stopped");
    assert.equal(workspace.workDir, join(h.config.workspaces.root, "space-game"));
    assert.ok(await exists(workspace.workDir));

    const records = await loadRegistry(h.registryFile);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.name, "space-game");
    assert.equal(records[0]?.port, workspace.port);
    assert.equal(records[0]?.status, "stopped");
  });

  test("labels the container so reconciliation can find it again", async () => {
    const h = await harness();
    await h.manager.create("space-game");
    assert.equal(h.runtime.created[0]?.labels[WORKSPACE_LABEL], "space-game");
  });

  test("mounts the work directory, per-workspace state, credentials and the agent", async () => {
    const h = await harness();
    await h.manager.create("space-game");

    const mounts = h.runtime.created[0]?.mounts ?? [];
    const byDestination = new Map(mounts.map((mount) => [mount.destination, mount]));

    assert.equal(byDestination.get("/workspace")?.source, join(h.config.workspaces.root, "space-game"));
    assert.equal(byDestination.get("/workspace")?.readOnly, false);

    // Per workspace, not shared: N containers writing one OpenCode database is
    // the corruption risk the requirements doc names.
    assert.equal(
      byDestination.get("/root/.local/share/opencode")?.source,
      join(h.config.state.dir, "opencode", "space-game"),
    );

    // The two read-only ones. Credentials are the only thing shared between
    // workspaces, and the agent comes from Yammer rather than the project.
    assert.equal(byDestination.get("/root/.local/share/opencode/auth.json")?.readOnly, true);
    assert.equal(byDestination.get("/root/.config/opencode/agent/yammer.md")?.source, h.config.workspaces.agentFile);
    assert.equal(byDestination.get("/root/.config/opencode/agent/yammer.md")?.readOnly, true);
  });

  test("gives each workspace its own state directory on disk", async () => {
    const h = await harness();
    await h.manager.create("one");
    await h.manager.create("two");
    assert.ok(await exists(join(h.config.state.dir, "opencode", "one")));
    assert.ok(await exists(join(h.config.state.dir, "opencode", "two")));
  });

  test("refuses a name that already exists", async () => {
    const h = await harness();
    await h.manager.create("space-game");
    await assert.rejects(
      () => h.manager.create("Space Game"),
      (error: WorkspaceLifecycleError) => error.kind === "name-taken",
    );
  });

  test("refuses a name that only sounds the same", async () => {
    // `spacegame` and `space-game` are different container names and the same
    // spoken one. Allowing both makes one of them permanently unreachable by
    // voice, which is the only way anyone reaches a workspace at all.
    const h = await harness();
    await h.manager.create("space-game");
    await assert.rejects(
      () => h.manager.create("SpaceGame"),
      (error: WorkspaceLifecycleError) => error.kind === "name-taken",
    );
  });

  test("refuses a name with nothing usable in it", async () => {
    const h = await harness();
    await assert.rejects(
      () => h.manager.create("???"),
      (error: WorkspaceLifecycleError) => error.kind === "bad-name",
    );
  });

  test("says the image is not built rather than trying to build it", async () => {
    const h = await harness({ image: "localhost/not-built:latest" });
    await assert.rejects(
      () => h.manager.create("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "image-missing",
    );
  });

  test("checks the agent file before creating anything", async () => {
    const h = await harness({ agentFile: "/nonexistent/yammer.md" });
    await assert.rejects(
      () => h.manager.create("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "agent-file-missing",
    );
    // The point of checking first: nothing was made that would have to be
    // cleaned up, and no workspace exists whose container can never work.
    assert.equal(h.runtime.created.length, 0);
    assert.equal(await exists(join(h.config.workspaces.root, "space-game")), false);
  });

  test("does not leave a container behind when it cannot be described", async () => {
    const h = await harness();
    h.runtime.failures.inspect = new ContainerRuntimeError("socket closed");
    await assert.rejects(() => h.manager.create("space-game"));
    // `remove` is not sabotaged, so the half-created container is gone.
    delete h.runtime.failures.inspect;
    assert.equal(h.runtime.containers.size, 0);
  });
});

describe("load", () => {
  test("starts a stopped container and waits for OpenCode", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    answers(created, "unreachable", "unreachable", "ready");

    const loaded = await h.manager.load("space-game");
    assert.equal(loaded.status, "ready");
    assert.equal(h.runtime.containers.get(created.containerId!)?.state, "running");

    const records = await loadRegistry(h.registryFile);
    assert.equal(records[0]?.status, "ready");
  });

  test("does not create: an unknown name is an error, not a new workspace", async () => {
    const h = await harness();
    await assert.rejects(() => h.manager.load("space-game"), WorkspaceUnknownError);
    assert.equal(h.runtime.containers.size, 0);
  });

  test("reports a container that was removed out from under Yammer", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    h.runtime.containers.clear();

    await assert.rejects(
      () => h.manager.load("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "container-gone",
    );
    assert.equal(created.status, "missing");
    assert.equal((await loadRegistry(h.registryFile))[0]?.status, "missing");
  });

  test("reports a container that will not start", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    h.runtime.failures.start = new ContainerRuntimeError("no space left on device");

    await assert.rejects(
      () => h.manager.load("space-game"),
      (error: WorkspaceLifecycleError) =>
        error.kind === "start-failed" && error.message.includes("no space left on device"),
    );
    assert.equal(created.status, "failed");
  });

  test("reports an OpenCode that never answers, and gives up", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    answers(created, "unreachable");

    await assert.rejects(
      () => h.manager.load("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "not-ready",
    );
    // `failed`, not `starting`: otherwise the next load would start polling a
    // container that has already established it will not answer.
    assert.equal(created.status, "failed");
    assert.equal((await loadRegistry(h.registryFile))[0]?.status, "failed");
  });

  test("gives up immediately on a missing agent instead of waiting out the timeout", async () => {
    const h = await harness({ readySeconds: 30 });
    const created = await h.manager.create("space-game");
    answers(created, "agent-missing");

    const started = Date.now();
    await assert.rejects(
      () => h.manager.load("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "agent-missing",
    );
    // Waiting cannot fix it — OpenCode reads agent files once at boot — so the
    // 30-second budget must not be spent discovering that.
    assert.ok(Date.now() - started < 1_000, "should not have waited for the readiness timeout");
    assert.equal(created.status, "failed");
  });

  test("refuses to talk to a port the registry does not name", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    const container = h.runtime.containers.get(created.containerId!)!;
    container.hostPort = created.port! + 1;

    await assert.rejects(
      () => h.manager.load("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "port-drift",
    );
    assert.equal(created.status, "failed");
  });

  test("is a no-op for the workspace Yammer did not start", async () => {
    const h = await harness();
    const loaded = await h.manager.load("project");
    assert.equal(loaded.containerId, null);
    assert.equal(h.runtime.containers.size, 0);
  });

  test("loads an already-running container without starting it again", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    answers(created, "ready");
    await h.manager.load("space-game");

    h.runtime.failures.start = new ContainerRuntimeError("start should not have been called");
    const again = await h.manager.load("space-game");
    assert.equal(again.status, "ready");
  });
});

describe("stop", () => {
  test("stops the container and records it", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    answers(created, "ready");
    await h.manager.load("space-game");

    await h.manager.stop("space-game");
    assert.equal(created.status, "stopped");
    assert.equal(h.runtime.containers.get(created.containerId!)?.state, "exited");
    assert.equal((await loadRegistry(h.registryFile))[0]?.status, "stopped");
  });

  test("will not stop the workspace Yammer did not start", async () => {
    const h = await harness();
    await assert.rejects(
      () => h.manager.stop("project"),
      (error: WorkspaceLifecycleError) => error.kind === "not-deletable",
    );
  });
});

describe("delete", () => {
  test("removes the container, the directory and the record", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    const workDir = created.workDir;

    await h.manager.delete("space-game");
    assert.equal(h.runtime.containers.size, 0);
    assert.equal(await exists(workDir), false);
    assert.equal(await exists(join(h.config.state.dir, "opencode", "space-game")), false);
    assert.deepEqual(await loadRegistry(h.registryFile), []);
  });

  test("will not delete the workspace Yammer did not create", async () => {
    const h = await harness();
    await assert.rejects(
      () => h.manager.delete("project"),
      (error: WorkspaceLifecycleError) => error.kind === "not-deletable",
    );
    assert.ok(await exists(h.config.opencode.projectDir));
  });

  test("refuses a work directory outside the workspace root", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    // What a hand-edited registry file looks like from in here.
    Object.defineProperty(created, "workDir", { value: h.root, writable: false });

    await assert.rejects(
      () => h.manager.delete("space-game"),
      (error: WorkspaceLifecycleError) => error.kind === "not-deletable",
    );
    assert.ok(await exists(h.root), "the directory it refused to delete is still there");
    assert.ok(await exists(h.config.workspaces.agentFile));
  });
});

describe("refreshStatuses", () => {
  test("promotes a container that has been up since before Yammer started", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    // What reconciliation leaves behind: the container is up, and nothing has
    // spoken to the OpenCode inside it.
    created.status = "starting";
    answers(created, "ready");

    await h.manager.refreshStatuses();
    assert.equal(created.status, "ready");
    assert.equal((await loadRegistry(h.registryFile))[0]?.status, "ready");
  });

  test("leaves a workspace alone when its OpenCode does not answer", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    created.status = "starting";
    answers(created, "unreachable");

    await h.manager.refreshStatuses();
    assert.equal(created.status, "starting");
  });

  test("marks a workspace whose agent never arrived as failed", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    created.status = "starting";
    answers(created, "agent-missing");

    await h.manager.refreshStatuses();
    assert.equal(created.status, "failed");
  });

  test("does not probe workspaces that are not starting", async () => {
    const h = await harness();
    const created = await h.manager.create("space-game");
    created.opencode.probeAgent = async () => {
      throw new Error("should not have been probed");
    };
    await h.manager.refreshStatuses();
    assert.equal(created.status, "stopped");
  });

  test("writes nothing when there is nothing to refresh", async () => {
    const h = await harness();
    await h.manager.refreshStatuses();
    await assert.rejects(() => readFile(h.registryFile, "utf8"));
  });
});
