/**
 * Bringing the workspace registry up: read it, check it against reality, write
 * back what changed, and say out loud — in the log — where the two disagreed.
 *
 * Split out of `index.ts` because it is the one part of startup with branches
 * worth reading in one place. The order matters and is not arbitrary:
 *
 * 1. A registry that cannot be parsed is fatal. Guessing at a hand-edited file
 *    would either lose a workspace or point one at the wrong directory.
 * 2. A container runtime that cannot be reached is **also fatal**, as of phase
 *    2. It was a warning while v1's only workspace was an `opencode serve`
 *    started outside Yammer; now that creating and loading workspaces is
 *    Yammer's whole job, a server that starts without a runtime is one that
 *    accepts an utterance and fails every workspace command it is given. Better
 *    to fail at the point where the fix is one `systemctl --user` away.
 * 3. Drift is logged and the corrected statuses are saved. Nothing is healed —
 *    that is an explicit non-goal.
 */

import { PodmanRuntime } from "./container/podman.ts";
import { WORKSPACE_LABEL, type ContainerRuntime } from "./container/runtime.ts";
import type { Config } from "./config.ts";
import { WorkspaceManager } from "./lifecycle.ts";
import { log } from "./log.ts";
import { reconcile } from "./registry/reconcile.ts";
import { loadRegistry, registryPath, saveRegistry, type WorkspaceRecord } from "./registry/store.ts";
import { buildRegistry, type WorkspaceRegistry } from "./workspace.ts";

export interface Workspaces {
  registry: WorkspaceRegistry;
  manager: WorkspaceManager;
}

export async function loadWorkspaces(
  config: Config,
  runtime: ContainerRuntime = new PodmanRuntime(config.container.socketPath),
): Promise<Workspaces> {
  const path = registryPath(config.state.dir);
  const records = await loadRegistry(path);
  log.info("workspace registry loaded", { path, workspaces: records.length });

  const reconciled = await reconcileAgainstRuntime(records, runtime, path);
  const registry = buildRegistry(config, reconciled);
  return {
    registry,
    manager: new WorkspaceManager({ config, runtime, registry, registryFile: path }),
  };
}

async function reconcileAgainstRuntime(
  records: WorkspaceRecord[],
  runtime: ContainerRuntime,
  path: string,
): Promise<WorkspaceRecord[]> {
  const containers = await runtime.list(WORKSPACE_LABEL);

  const result = reconcile(records, containers);
  for (const entry of result.drift) {
    log.warn("workspace registry drift", {
      kind: entry.kind,
      workspace: entry.workspace,
      detail: entry.detail,
    });
  }
  if (result.changed) await saveRegistry(path, result.records);
  return result.records;
}
