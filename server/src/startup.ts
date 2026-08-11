/**
 * Bringing the workspace registry up: read it, check it against reality, write
 * back what changed, and say out loud — in the log — where the two disagreed.
 *
 * Split out of `index.ts` because it is the one part of startup with branches
 * worth reading in one place. The order matters and is not arbitrary:
 *
 * 1. A registry that cannot be parsed is fatal. Guessing at a hand-edited file
 *    would either lose a workspace or point one at the wrong directory.
 * 2. A container runtime that cannot be reached is *not* fatal. v1's workspace
 *    is an `opencode serve` started outside Yammer entirely, so a machine with
 *    no `podman.socket` enabled still runs Yammer perfectly well. It only means
 *    the persisted statuses go unverified, which is worth a warning and nothing
 *    more until phase 2 needs the runtime to do anything.
 * 3. Drift is logged and the corrected statuses are saved. Nothing is healed —
 *    that is an explicit non-goal.
 */

import { PodmanRuntime } from "./container/podman.ts";
import { WORKSPACE_LABEL, type ContainerRuntime } from "./container/runtime.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { reconcile } from "./registry/reconcile.ts";
import { loadRegistry, registryPath, saveRegistry, type WorkspaceRecord } from "./registry/store.ts";
import { buildRegistry, type WorkspaceRegistry } from "./workspace.ts";

export async function loadWorkspaces(
  config: Config,
  runtime: ContainerRuntime = new PodmanRuntime(config.container.socketPath),
): Promise<WorkspaceRegistry> {
  const path = registryPath(config.state.dir);
  const records = await loadRegistry(path);
  log.info("workspace registry loaded", { path, workspaces: records.length });

  const reconciled = await reconcileAgainstRuntime(records, runtime, path);
  return buildRegistry(config, reconciled);
}

async function reconcileAgainstRuntime(
  records: WorkspaceRecord[],
  runtime: ContainerRuntime,
  path: string,
): Promise<WorkspaceRecord[]> {
  let containers;
  try {
    containers = await runtime.list(WORKSPACE_LABEL);
  } catch (cause) {
    // Only worth raising a voice about when there is something to check. With
    // an empty registry there is nothing Yammer could have been wrong about.
    const level = records.length === 0 ? "debug" : "warn";
    log[level]("could not reach the container runtime; workspace statuses are unverified", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return records;
  }

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
