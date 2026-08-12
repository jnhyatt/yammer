/**
 * The container runtime, as the rest of Yammer sees it.
 *
 * Narrow on purpose. This is not a Podman binding — it is the six things the
 * workspace lifecycle does, named the way the lifecycle thinks about them, so
 * that `lifecycle.ts` is testable against a fake and every failure it has to
 * speak aloud can be provoked in a test rather than by hand.
 *
 * That framing is why `inspect` returns null instead of throwing for a
 * container that is gone: "gone" is an ordinary answer here, because drift is
 * reported rather than healed and the lifecycle has to say it out loud.
 */

/** The label every container Yammer creates carries, valued with its name. */
export const WORKSPACE_LABEL = "yammer.workspace";

/**
 * Where the workspace's host directory appears inside its container.
 *
 * The same for every workspace, which is what makes it a constant: the host
 * paths differ, the container path never does. It lives here rather than in
 * `lifecycle.ts` because `workspace.ts` needs it too — every request to a
 * containerised OpenCode carries a directory, and that directory is the
 * container's, not the host's.
 */
export const CONTAINER_WORKDIR = "/workspace";

/** One container, reduced to the fields reconciliation actually reads. */
export interface ContainerInfo {
  id: string;
  /** Runtime-assigned names. Podman reports at least one. */
  names: string[];
  /** The runtime's own state word — `running`, `exited`, `created`, … */
  state: string;
  labels: Record<string, string>;
}

/** One bind mount. Yammer uses no named volumes: every mount is a host path it owns. */
export interface ContainerMount {
  source: string;
  destination: string;
  readOnly: boolean;
}

/**
 * What Yammer asks for when it creates a workspace container.
 *
 * There is no host port in here, and that is the point: the OS picks it. See
 * `ContainerDetail.hostPort` for reading it back.
 */
export interface ContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  mounts: ContainerMount[];
  /** Published on 127.0.0.1 only — nothing else ever needs to reach it. */
  publishContainerPort: number;
}

export interface ContainerDetail extends ContainerInfo {
  /**
   * The host port the runtime bound to the published container port, or null
   * if it is not published yet. Null before the container has run: asking for
   * an OS-assigned port means there is a window where the answer is "not yet".
   */
  hostPort: number | null;
}

export interface ContainerRuntime {
  /**
   * Every container carrying `labelKey`, running or not.
   *
   * Includes stopped containers deliberately: a workspace whose container
   * exited is drift to report, and one that has been removed entirely is a
   * different kind of drift. Only listing the running ones would collapse the
   * two into "gone".
   */
  list(labelKey: string): Promise<ContainerInfo[]>;

  /** Create without starting, and answer with the new container's id. */
  create(spec: ContainerSpec): Promise<string>;

  /** Start a created or stopped container. Starting a running one is a no-op. */
  start(id: string): Promise<void>;

  stop(id: string, timeoutSeconds: number): Promise<void>;

  /** Remove, stopping first if it is running. Gone-already is not an error. */
  remove(id: string): Promise<void>;

  /** Null when there is no such container. */
  inspect(id: string): Promise<ContainerDetail | null>;
}

/** A runtime that could not be reached, or answered with something unexpected. */
export class ContainerRuntimeError extends Error {}

/**
 * The runtime answered, and said the thing does not exist.
 *
 * Worth its own type because the two callers read it in opposite directions: a
 * missing container is normal drift, and a missing *image* is a setup error the
 * user has to fix before any workspace can be created.
 */
export class ContainerNotFoundError extends ContainerRuntimeError {}
