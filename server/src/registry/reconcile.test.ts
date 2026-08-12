/**
 * Reconciliation, which exists because Yammer's beliefs about containers go
 * stale while it isn't running.
 *
 * The silent failure being guarded here is a confidently wrong status: a
 * workspace reported `ready` whose container was removed weeks ago sends the
 * user's `load` into a connection timeout with no explanation, and reports
 * itself in `list` as though it were fine.
 *
 * The other half of the guard is the opposite mistake — reconciliation that
 * fixes things. Healing drift is an explicit non-goal, so "the record survives"
 * is asserted as deliberately as "the status changes".
 *
 *   node --test --experimental-strip-types src/registry/reconcile.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKSPACE_LABEL, type ContainerInfo } from "../container/runtime.ts";
import { reconcile } from "./reconcile.ts";
import type { WorkspaceRecord } from "./store.ts";

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    name: "space-game",
    containerId: "c0ffee0123456789abcdef",
    workDir: "/home/josh/yammer-workspaces/space-game",
    port: 44321,
    status: "ready",
    createdAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  };
}

function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: "c0ffee0123456789abcdef",
    names: ["yammer-space-game"],
    state: "running",
    labels: { [WORKSPACE_LABEL]: "space-game" },
    ...overrides,
  };
}

describe("reconcile", () => {
  it("reports nothing when the registry is empty and so is the world", () => {
    const result = reconcile([], []);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.drift, []);
    assert.equal(result.changed, false);
  });

  it("marks a workspace missing when its container has been removed", () => {
    const result = reconcile([record()], []);

    assert.equal(result.records[0]?.status, "missing");
    assert.equal(result.changed, true);
    assert.equal(result.drift[0]?.kind, "container-gone");
    assert.match(result.drift[0]?.detail ?? "", /c0ffee012345/);
  });

  it("keeps the record for a removed container, because the work directory is still there", () => {
    const result = reconcile([record()], []);

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.name, "space-game");
    assert.equal(result.records[0]?.workDir, "/home/josh/yammer-workspaces/space-game");
    assert.equal(result.records[0]?.createdAt, "2026-08-11T12:00:00.000Z");
  });

  it("demotes a workspace whose container exited while Yammer was down", () => {
    const result = reconcile([record()], [container({ state: "exited" })]);

    assert.equal(result.records[0]?.status, "stopped");
    assert.equal(result.drift[0]?.kind, "status-stale");
    assert.match(result.drift[0]?.detail ?? "", /was ready, container is exited/);
  });

  it("calls a running container `starting`, not `ready`", () => {
    // `ready` means OpenCode answered. Nothing here has spoken to OpenCode, and
    // claiming otherwise would make the first turn the thing that discovers it.
    const result = reconcile([record({ status: "stopped" })], [container()]);

    assert.equal(result.records[0]?.status, "starting");
    assert.equal(result.changed, true);
  });

  it("reports no drift when the file already matches the world", () => {
    const result = reconcile([record({ status: "starting" })], [container()]);

    assert.deepEqual(result.drift, []);
    assert.equal(result.changed, false);
  });

  it("reports a labelled container nobody registered, without adopting it", () => {
    const stranger = container({ id: "deadbeef00000000", labels: { [WORKSPACE_LABEL]: "orphan" } });
    const result = reconcile([], [stranger]);

    assert.equal(result.records.length, 0);
    assert.equal(result.drift.length, 1);
    assert.equal(result.drift[0]?.kind, "unregistered-container");
    assert.equal(result.drift[0]?.workspace, "orphan");
  });

  it("names an unlabelled stranger by its container name rather than blank", () => {
    const stranger = container({ id: "deadbeef00000000", labels: {}, names: ["some-container"] });
    const result = reconcile([], [stranger]);

    assert.equal(result.drift[0]?.workspace, "some-container");
  });

  it("handles several workspaces drifting in different directions at once", () => {
    const records = [
      record({ name: "alpha", containerId: "aaaa000000000000" }),
      record({ name: "beta", containerId: "bbbb000000000000", port: 44322 }),
      record({ name: "gamma", containerId: "cccc000000000000", port: 44323, status: "stopped" }),
    ];
    const containers = [
      container({ id: "bbbb000000000000", state: "exited", labels: { [WORKSPACE_LABEL]: "beta" } }),
      container({ id: "cccc000000000000", state: "running", labels: { [WORKSPACE_LABEL]: "gamma" } }),
      container({ id: "dddd000000000000", state: "running", labels: { [WORKSPACE_LABEL]: "delta" } }),
    ];

    const result = reconcile(records, containers);

    assert.deepEqual(
      result.records.map((entry) => [entry.name, entry.status]),
      [
        ["alpha", "missing"],
        ["beta", "stopped"],
        ["gamma", "starting"],
      ],
    );
    assert.deepEqual(
      result.drift.map((entry) => [entry.kind, entry.workspace]),
      [
        ["container-gone", "alpha"],
        ["status-stale", "beta"],
        ["status-stale", "gamma"],
        ["unregistered-container", "delta"],
      ],
    );
  });

  it("does not mutate the records it was given", () => {
    const original = record();
    reconcile([original], []);
    assert.equal(original.status, "ready");
  });
});
