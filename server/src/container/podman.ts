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
  ContainerNotFoundError,
  ContainerRuntimeError,
  type ContainerDetail,
  type ContainerInfo,
  type ContainerRuntime,
  type ContainerSpec,
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

interface Response {
  status: number;
  body: string;
}

export class PodmanRuntime implements ContainerRuntime {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async list(labelKey: string): Promise<ContainerInfo[]> {
    const filters = JSON.stringify({ label: [labelKey] });
    const parsed = await this.json(
      "GET",
      `/libpod/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    if (!Array.isArray(parsed)) {
      throw new ContainerRuntimeError("podman did not return a container list");
    }
    return parsed.map((entry) => toContainerInfo(entry as PodmanContainer));
  }

  /**
   * Create without starting.
   *
   * `host_port: 0` is the port allocation strategy: the runtime picks a free
   * one and binds it, which is race-free in a way that scanning for a free port
   * and then asking for it is not. Podman assigns it at create time, so
   * `inspect` can read it back before the container has ever run.
   */
  async create(spec: ContainerSpec): Promise<string> {
    const body = {
      name: spec.name,
      image: spec.image,
      labels: spec.labels,
      mounts: spec.mounts.map((mount) => ({
        destination: mount.destination,
        source: mount.source,
        type: "bind",
        options: ["rbind", mount.readOnly ? "ro" : "rw"],
      })),
      portmappings: [
        {
          host_ip: "127.0.0.1",
          container_port: spec.publishContainerPort,
          host_port: 0,
          protocol: "tcp",
        },
      ],
      // Yammer removes containers itself, on an explicit `delete`. A container
      // that removed itself on exit would turn a crash into a vanished
      // workspace — the one drift case with nothing left to report.
      remove: false,
    };

    const created = await this.json("POST", "/libpod/containers/create", body);
    const id = (created as { Id?: unknown })?.Id;
    if (typeof id !== "string" || id === "") {
      throw new ContainerRuntimeError("podman created a container but reported no id");
    }
    return id;
  }

  async start(id: string): Promise<void> {
    // 304 is "already running", which is what `load` on a running workspace
    // does. Success, not an error worth distinguishing.
    await this.send("POST", `/libpod/containers/${encodeURIComponent(id)}/start`, undefined, [304]);
  }

  async stop(id: string, timeoutSeconds: number): Promise<void> {
    await this.send(
      "POST",
      `/libpod/containers/${encodeURIComponent(id)}/stop?timeout=${timeoutSeconds}`,
      undefined,
      [304],
    );
  }

  /** Gone-already is success: the caller wanted it gone. */
  async remove(id: string): Promise<void> {
    try {
      await this.send("DELETE", `/libpod/containers/${encodeURIComponent(id)}?force=true`);
    } catch (cause) {
      if (cause instanceof ContainerNotFoundError) return;
      throw cause;
    }
  }

  async inspect(id: string): Promise<ContainerDetail | null> {
    let parsed: unknown;
    try {
      parsed = await this.json("GET", `/libpod/containers/${encodeURIComponent(id)}/json`);
    } catch (cause) {
      if (cause instanceof ContainerNotFoundError) return null;
      throw cause;
    }
    return toContainerDetail(parsed);
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const raw = await this.send(method, path, body);
    try {
      return JSON.parse(raw);
    } catch {
      throw new ContainerRuntimeError(
        `podman returned something that is not JSON: ${raw.slice(0, 200)}`,
      );
    }
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    alsoOk: number[] = [],
  ): Promise<string> {
    const response = await this.transport(method, `/${API_VERSION}${path}`, body);
    if (response.status === 404) {
      throw new ContainerNotFoundError(podmanMessage(response.body) ?? `podman ${path} responded 404`);
    }
    const ok =
      (response.status >= 200 && response.status < 300) || alsoOk.includes(response.status);
    if (!ok) {
      throw new ContainerRuntimeError(
        `podman ${path} responded ${response.status}: ` +
          (podmanMessage(response.body) ?? response.body.slice(0, 200)),
      );
    }
    return response.body;
  }

  private transport(method: string, path: string, body?: unknown): Promise<Response> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          host: "d",
          headers: payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
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
      if (payload) req.write(payload);
      req.end();
    });
  }
}

/** Podman's errors are JSON with a `message`. Prefer it over the raw body. */
function podmanMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const message = (parsed as { message?: unknown })?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
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

/**
 * Inspect answers in a different shape from list: one `Name`, `State` is an
 * object rather than a word, and the port bindings live under `NetworkSettings`
 * as strings.
 */
function toContainerDetail(parsed: unknown): ContainerDetail {
  const entry = parsed as {
    Id?: unknown;
    Name?: unknown;
    State?: { Status?: unknown };
    Config?: { Labels?: unknown };
    NetworkSettings?: { Ports?: unknown };
  };

  const labels: Record<string, string> = {};
  const rawLabels = entry.Config?.Labels;
  if (rawLabels && typeof rawLabels === "object") {
    for (const [key, value] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof value === "string") labels[key] = value;
    }
  }

  return {
    id: typeof entry.Id === "string" ? entry.Id : "",
    names: typeof entry.Name === "string" ? [entry.Name] : [],
    state: typeof entry.State?.Status === "string" ? entry.State.Status : "unknown",
    labels,
    hostPort: firstHostPort(entry.NetworkSettings?.Ports),
  };
}

/**
 * The single published port, as a number.
 *
 * Yammer publishes exactly one, so the first binding of the first entry is the
 * answer without having to know the container port here. Podman reports it as a
 * string, and as `"0"` in the window before one has been assigned.
 */
function firstHostPort(ports: unknown): number | null {
  if (!ports || typeof ports !== "object") return null;
  for (const bindings of Object.values(ports as Record<string, unknown>)) {
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      const raw = (binding as { HostPort?: unknown })?.HostPort;
      const port = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
      if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
    }
  }
  return null;
}
