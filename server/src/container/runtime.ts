/**
 * The container runtime, as the rest of Yammer sees it.
 *
 * Phase 1 needs exactly one thing from a runtime — the ability to ask which
 * containers exist and what state they are in — so that is all this interface
 * promises. Phase 2 widens it to `create`/`start`/`stop`/`remove`/`inspect`
 * when workspace lifecycle becomes Yammer's job. Keeping it narrow now means
 * the fake in the tests is a fake of something real rather than a stub of five
 * methods nobody calls yet.
 *
 * The reason there is an interface at all is that reconciliation is a diff
 * between two lists, and a diff is only testable if the second list can be
 * handed to it.
 */

/** The label every container Yammer creates carries, valued with its name. */
export const WORKSPACE_LABEL = "yammer.workspace";

/** One container, reduced to the fields reconciliation actually reads. */
export interface ContainerInfo {
  id: string;
  /** Runtime-assigned names. Podman reports at least one. */
  names: string[];
  /** The runtime's own state word — `running`, `exited`, `created`, … */
  state: string;
  labels: Record<string, string>;
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
}

/** A runtime that could not be reached, or answered with something unexpected. */
export class ContainerRuntimeError extends Error {}
