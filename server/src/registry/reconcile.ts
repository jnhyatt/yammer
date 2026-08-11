/**
 * Checking the registry against the world.
 *
 * Yammer is not running while it is not running, and containers keep existing —
 * or stop existing — the whole time. A `podman rm` or a reboot happens without
 * Yammer's knowledge, so the registry read off disk is a claim about the world,
 * not a description of it.
 *
 * **Drift is reported, never healed.** That is an explicit non-goal in the
 * requirements doc: no restarting crashed containers, no recreating removed
 * ones, no adopting strangers. What reconciliation changes is the *status* Yammer
 * believes, which is the thing that would otherwise be confidently wrong. What
 * it never changes is which workspaces exist.
 *
 * This is a pure function over two lists so that every drift case is a test
 * rather than an afternoon of `podman rm` and restarts.
 */

import { WORKSPACE_LABEL, type ContainerInfo } from "../container/runtime.ts";
import type { WorkspaceRecord } from "./store.ts";
import type { WorkspaceStatus } from "../workspace.ts";

/** Something the registry and the runtime disagree about. */
export interface Drift {
  kind:
    /** Registered, but no container with that id exists any more. */
    | "container-gone"
    /** The container exists; Yammer's idea of its state was stale. */
    | "status-stale"
    /** A container labelled as a workspace that the registry has never heard of. */
    | "unregistered-container";
  /** Workspace name — for an orphan, the label's value. */
  workspace: string;
  detail: string;
}

export interface Reconciliation {
  /** The same workspaces, with statuses that match reality. */
  records: WorkspaceRecord[];
  drift: Drift[];
  /** True when any status changed, i.e. when the file is worth rewriting. */
  changed: boolean;
}

/**
 * Map a runtime's state word onto a workspace status.
 *
 * `running` only means the container is up — OpenCode inside it may still be
 * starting, and phase 2's readiness poll is what promotes `starting` to `ready`.
 * Calling a running container `starting` here is therefore the honest answer at
 * startup: Yammer has not spoken to the OpenCode inside it yet.
 */
function statusFor(state: string): WorkspaceStatus {
  return state === "running" ? "starting" : "stopped";
}

export function reconcile(
  records: readonly WorkspaceRecord[],
  containers: readonly ContainerInfo[],
): Reconciliation {
  const byId = new Map(containers.map((container) => [container.id, container]));
  const drift: Drift[] = [];
  let changed = false;

  const reconciled = records.map((record) => {
    const container = byId.get(record.containerId);

    if (!container) {
      if (record.status !== "missing") changed = true;
      drift.push({
        kind: "container-gone",
        workspace: record.name,
        detail: `container ${short(record.containerId)} no longer exists`,
      });
      // The record stays. The host directory is still there and still holds the
      // user's work; forgetting the workspace would orphan it silently.
      return { ...record, status: "missing" as WorkspaceStatus };
    }

    const status = statusFor(container.state);
    if (status !== record.status) {
      changed = true;
      drift.push({
        kind: "status-stale",
        workspace: record.name,
        detail: `was ${record.status}, container is ${container.state}`,
      });
    }
    return { ...record, status };
  });

  const known = new Set(records.map((record) => record.containerId));
  for (const container of containers) {
    if (known.has(container.id)) continue;
    drift.push({
      kind: "unregistered-container",
      workspace: container.labels[WORKSPACE_LABEL] ?? container.names[0] ?? short(container.id),
      detail: `container ${short(container.id)} is labelled as a workspace but is not registered`,
    });
  }

  return { records: reconciled, drift, changed };
}

function short(id: string): string {
  return id.slice(0, 12);
}
