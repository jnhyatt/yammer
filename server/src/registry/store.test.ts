/**
 * The registry file, and what it does when it has been edited by a human.
 *
 * This belongs in the suite for the reason the other three do: the failure is
 * silent. A parser that shrugs at a malformed entry drops a workspace out of
 * `list`, and the user's evidence is a name Yammer says it has never heard of —
 * while the directory holding their work sits there untouched. A parser that
 * coerces a bad `workDir` is worse: phase 2 bind-mounts that path.
 *
 *   node --test --experimental-strip-types src/registry/store.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  REGISTRY_VERSION,
  RegistryError,
  loadRegistry,
  parseRegistry,
  registryPath,
  saveRegistry,
  type WorkspaceRecord,
} from "./store.ts";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yammer-registry-"));
  temps.push(dir);
  return dir;
}

after(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    name: "space-game",
    containerId: "c0ffee0123456789",
    workDir: "/home/josh/yammer-workspaces/space-game",
    port: 44321,
    status: "stopped",
    createdAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  };
}

/** Wrap records the way the file does, so the malformed cases stay one line. */
function file(workspaces: unknown, version: unknown = REGISTRY_VERSION): unknown {
  return { version, workspaces };
}

describe("registry round trip", () => {
  it("survives being written and read back", async () => {
    const path = registryPath(await tempDir());
    const written = [record(), record({ name: "yammer-docs", containerId: "beef", port: 44322 })];

    await saveRegistry(path, written);
    assert.deepEqual(await loadRegistry(path), written);
  });

  it("creates the state directory rather than failing on a fresh install", async () => {
    const path = registryPath(join(await tempDir(), "nested", "state"));
    await saveRegistry(path, [record()]);
    assert.equal((await loadRegistry(path)).length, 1);
  });

  it("treats a missing file as an empty registry, not an error", async () => {
    assert.deepEqual(await loadRegistry(registryPath(await tempDir())), []);
  });

  it("leaves no temp file behind, so a later read cannot find a stale one", async () => {
    const dir = await tempDir();
    await saveRegistry(registryPath(dir), [record()]);
    assert.deepEqual((await readdir(dir)).sort(), ["workspaces.json"]);
  });

  it("replaces rather than merges, so a delete actually deletes", async () => {
    const path = registryPath(await tempDir());
    await saveRegistry(path, [record(), record({ name: "gone", containerId: "d00d", port: 44322 })]);
    await saveRegistry(path, [record()]);

    const loaded = await loadRegistry(path);
    assert.deepEqual(loaded.map((entry) => entry.name), ["space-game"]);
  });

  it("writes something a human can read and edit", async () => {
    const path = registryPath(await tempDir());
    await saveRegistry(path, [record()]);

    const raw = await readFile(path, "utf8");
    assert.match(raw, /\n  "workspaces"/);
    assert.ok(raw.endsWith("\n"));
  });
});

describe("a registry file edited into nonsense", () => {
  // Every case here is a thing a person could plausibly do to the file by hand,
  // and every message has to name what is wrong — a startup error that says
  // only "invalid registry" sends them reading source.
  const cases: Array<{ what: string; input: unknown; mentions: RegExp }> = [
    { what: "an array at the top level", input: [record()], mentions: /object at the top level/ },
    { what: "a missing version", input: { workspaces: [] }, mentions: /version is undefined/ },
    { what: "a future version", input: file([], 99), mentions: /different version of Yammer/ },
    { what: "no workspaces key", input: { version: REGISTRY_VERSION }, mentions: /not an array/ },
    { what: "a null entry", input: file([null]), mentions: /workspaces\[0\] is not an object/ },
    {
      what: "a name that was deleted",
      input: file([{ ...record(), name: undefined }]),
      mentions: /`name` must be a non-empty string/,
    },
    {
      what: "a port typed as a string",
      input: file([record({ port: "44321" as unknown as number })]),
      mentions: /space-game.*`port` must be a port number/s,
    },
    {
      what: "a port out of range",
      input: file([record({ port: 70000 })]),
      mentions: /`port` must be a port number/,
    },
    {
      what: "an emptied workDir",
      input: file([record({ workDir: "" })]),
      mentions: /`workDir` must be a non-empty string/,
    },
    {
      what: "a status that is not a status",
      input: file([record({ status: "runnning" as never })]),
      mentions: /`status` must be one of/,
    },
    {
      what: "a garbled timestamp",
      input: file([record({ createdAt: "last tuesday" })]),
      mentions: /`createdAt` must be an ISO 8601 timestamp/,
    },
    {
      what: "a duplicated workspace",
      input: file([record(), record()]),
      mentions: /"space-game" appears more than once/,
    },
    {
      what: "two workspaces on one port",
      input: file([record(), record({ name: "other", containerId: "beef" })]),
      mentions: /both claim port 44321/,
    },
  ];

  for (const { what, input, mentions } of cases) {
    it(`rejects ${what}, saying which field`, () => {
      assert.throws(
        () => parseRegistry(input, "/state/workspaces.json"),
        (error: unknown) => {
          assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
          assert.match(error.message, mentions);
          // The path is in every message: this is read at startup, by someone
          // who does not yet know which file to open.
          assert.match(error.message, /\/state\/workspaces\.json/);
          return true;
        },
      );
    });
  }

  it("rejects a file that is not JSON at all", async () => {
    const path = registryPath(await tempDir());
    await saveRegistry(path, []);
    await writeFile(path, "{ oops", "utf8");

    await assert.rejects(loadRegistry(path), (error: unknown) => {
      assert.ok(error instanceof RegistryError);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });
});
