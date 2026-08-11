/**
 * Podman, over its REST socket.
 *
 * Yammer runs on the host as the user, so `/run/user/<uid>/podman/podman.sock`
 * is its own socket — no privilege boundary is crossed by using it, and nothing
 * has to be installed inside an image. This is also the codebase's standing
 * preference applied again: talk to the real HTTP endpoint rather than trust a
 * wrapper's account of it (see `opencode/permissions.ts` on the SDK's lies).
 *
 * **`fetch` cannot do Unix sockets.** Node's global `fetch` has no socket-path
 * option and undici's is behind a custom dispatcher, so this uses `node:http`
 * with `socketPath` directly. The host in the URL is ignored by the transport
 * but still required by the parser, hence the meaningless `d`.
 *
 * The API version is pinned in the path. Podman's compat and libpod routes both
 * carry one, and an unversioned request gets whatever the daemon feels like;
 * pinning means a Podman upgrade that changes the shape fails loudly here
 * rather than silently returning fields we stop reading.
 */

import { request as httpRequest } from "node:http";

import {
  ContainerRuntimeError,
  type ContainerInfo,
  type ContainerRuntime,
} from "./runtime.ts";

/** libpod API version this client is written against. Podman 5.x and 6.x both serve it. */
const API_VERSION = "v5.0.0";

/** Podman's `/libpod/containers/json` entry, narrowed to what we read. */
interface PodmanContainer {
  Id?: unknown;
  Names?: unknown;
  State?: unknown;
  /** Null rather than `{}` when the container carries no labels. */
  Labels?: unknown;
}

export class PodmanRuntime implements ContainerRuntime {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async list(labelKey: string): Promise<ContainerInfo[]> {
    const filters = JSON.stringify({ label: [labelKey] });
    const path =
      `/${API_VERSION}/libpod/containers/json` +
      `?all=true&filters=${encodeURIComponent(filters)}`;

    const body = await this.get(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ContainerRuntimeError(
        `podman returned something that is not JSON: ${body.slice(0, 200)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ContainerRuntimeError("podman did not return a container list");
    }
    return parsed.map((entry) => toContainerInfo(entry as PodmanContainer));
  }

  private get(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { socketPath: this.socketPath, path, method: "GET", host: "d" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new ContainerRuntimeError(
                  `podman ${path} responded ${status}: ${body.slice(0, 200)}`,
                ),
              );
              return;
            }
            resolve(body);
          });
        },
      );
      req.on("error", (cause) => {
        // Overwhelmingly ENOENT or ECONNREFUSED, i.e. `podman.socket` isn't
        // enabled. Say so, because the fix is one systemctl command.
        reject(
          new ContainerRuntimeError(
            `cannot reach podman at ${this.socketPath}: ${cause.message}`,
          ),
        );
      });
      req.end();
    });
  }
}

function toContainerInfo(entry: PodmanContainer): ContainerInfo {
  const labels: Record<string, string> = {};
  if (entry.Labels && typeof entry.Labels === "object") {
    for (const [key, value] of Object.entries(entry.Labels as Record<string, unknown>)) {
      if (typeof value === "string") labels[key] = value;
    }
  }
  return {
    id: typeof entry.Id === "string" ? entry.Id : "",
    names: Array.isArray(entry.Names)
      ? entry.Names.filter((name): name is string => typeof name === "string")
      : [],
    state: typeof entry.State === "string" ? entry.State : "unknown",
    labels,
  };
}
