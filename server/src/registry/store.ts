/**
 * The workspace registry's durable form.
 *
 * Yammer restarts. Containers do not go away when it does, and a workspace's
 * host directory certainly doesn't, so without a file on disk a restart loses
 * track of everything the user has created. This module is that file: read it
 * at startup, write it whenever the set of workspaces changes.
 *
 * Three decisions worth stating, all of them from the requirements doc:
 *
 * - **The path comes from `env-paths`, not from a literal.** `~/.local/share`
 *   is only correct on Linux; the doc explicitly asks for the platform's data
 *   directory and explicitly asks that it not be hand-rolled per OS.
 * - **JSON, one flat file.** The expected size is a handful of entries and the
 *   only query is "all of them". A database would be scaffolding around nothing.
 * - **Write to a temp file and rename.** Rename is atomic within a filesystem,
 *   so a crash mid-write leaves the previous registry rather than half of the
 *   new one. There is no concurrent writer to design around — Yammer is one
 *   process, and the file is per-user.
 *
 * Parsing is strict and loud. A hand-edited file that has become nonsense must
 * fail at startup naming the field, because the alternative is a workspace that
 * quietly vanishes from `list` or a status that is confidently wrong.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import envPaths from "env-paths";

import type { WorkspaceStatus } from "../workspace.ts";
import { WORKSPACE_STATUSES } from "../workspace.ts";

/** Bumped only when the on-disk shape changes incompatibly. */
export const REGISTRY_VERSION = 1;

/** One workspace, as it survives a restart. */
export interface WorkspaceRecord {
  /** Also the container's `yammer.workspace` label value, and what the user says. */
  name: string;
  /** The container this workspace's OpenCode runs in. */
  containerId: string;
  /** Host directory, Yammer-owned, bind-mounted into the container. */
  workDir: string;
  /** Published loopback port the container's OpenCode answers on. */
  port: number;
  /** Last known. Corrected against the runtime at every startup. */
  status: WorkspaceStatus;
  /** ISO 8601. Informational — nothing branches on it. */
  createdAt: string;
}

export interface RegistryFile {
  version: number;
  workspaces: WorkspaceRecord[];
}

/** A registry file that cannot be trusted. Always names the path. */
export class RegistryError extends Error {}

/**
 * Where the registry lives.
 *
 * `suffix: ""` matters: `env-paths` appends `-nodejs` by default, which would
 * put this in `~/.local/share/yammer-nodejs` and make the path something no
 * user would guess or find.
 */
export function defaultStateDir(): string {
  return envPaths("yammer", { suffix: "" }).data;
}

export function registryPath(stateDir: string): string {
  return join(stateDir, "workspaces.json");
}

/**
 * Read the registry, or an empty one on first run.
 *
 * A missing file is normal — it is what every install looks like before the
 * first `create`. Anything else wrong with it is not.
 */
export async function loadRegistry(path: string): Promise<WorkspaceRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RegistryError(`cannot read the workspace registry at ${path}: ${String(cause)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new RegistryError(
      `the workspace registry at ${path} is not valid JSON: ${(cause as Error).message}`,
    );
  }
  return parseRegistry(parsed, path);
}

/** Replace the registry on disk. Atomic enough: write beside it, then rename. */
export async function saveRegistry(path: string, workspaces: WorkspaceRecord[]): Promise<void> {
  const file: RegistryFile = { version: REGISTRY_VERSION, workspaces };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  // Trailing newline so the file is pleasant to `cat` and to hand-edit, which
  // people will do, which is why the parser above is as strict as it is.
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/** Validate a parsed registry. Exported so the tests can drive it without a file. */
export function parseRegistry(parsed: unknown, path: string): WorkspaceRecord[] {
  const fail = (detail: string): never => {
    throw new RegistryError(`the workspace registry at ${path} is malformed: ${detail}`);
  };

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("expected a JSON object at the top level");
  }
  const file = parsed as Record<string, unknown>;

  if (file["version"] !== REGISTRY_VERSION) {
    return fail(
      `version is ${JSON.stringify(file["version"])}, expected ${REGISTRY_VERSION}` +
        " — this file was written by a different version of Yammer",
    );
  }
  if (!Array.isArray(file["workspaces"])) {
    return fail("`workspaces` is missing or is not an array");
  }

  const records: WorkspaceRecord[] = [];
  const seenNames = new Set<string>();
  const seenPorts = new Map<number, string>();

  for (const [index, entry] of (file["workspaces"] as unknown[]).entries()) {
    // Identify the entry by name where there is one, because "workspaces[3]"
    // is not what the person staring at the file is looking for.
    const where = (field: string): string => {
      const name = (entry as Record<string, unknown> | null)?.["name"];
      const label = typeof name === "string" && name !== "" ? `workspace "${name}"` : `workspaces[${index}]`;
      return `${label}: ${field}`;
    };

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(`workspaces[${index}] is not an object`);
    }
    const record = entry as Record<string, unknown>;

    const name = record["name"];
    if (typeof name !== "string" || name === "") return fail(where("`name` must be a non-empty string"));
    if (seenNames.has(name)) return fail(`workspace "${name}" appears more than once`);
    seenNames.add(name);

    const containerId = record["containerId"];
    if (typeof containerId !== "string" || containerId === "") {
      return fail(where("`containerId` must be a non-empty string"));
    }

    const workDir = record["workDir"];
    if (typeof workDir !== "string" || workDir === "") {
      return fail(where("`workDir` must be a non-empty string"));
    }

    const port = record["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return fail(where(`\`port\` must be a port number, got ${JSON.stringify(port)}`));
    }
    // Two workspaces cannot both be published on one loopback port, so a file
    // saying they are describes a world that cannot exist.
    const collision = seenPorts.get(port);
    if (collision !== undefined) {
      return fail(`workspaces "${collision}" and "${name}" both claim port ${port}`);
    }
    seenPorts.set(port, name);

    const status = record["status"];
    if (typeof status !== "string" || !(WORKSPACE_STATUSES as readonly string[]).includes(status)) {
      return fail(
        where(
          `\`status\` must be one of ${WORKSPACE_STATUSES.join(", ")}, got ${JSON.stringify(status)}`,
        ),
      );
    }

    const createdAt = record["createdAt"];
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
      return fail(where(`\`createdAt\` must be an ISO 8601 timestamp, got ${JSON.stringify(createdAt)}`));
    }

    records.push({
      name,
      containerId,
      workDir,
      port,
      status: status as WorkspaceStatus,
      createdAt,
    });
  }

  return records;
}
