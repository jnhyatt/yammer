/**
 * An in-memory container runtime, for tests.
 *
 * Not a stub that records calls: a small state machine that behaves like the
 * real one, because the lifecycle's interesting cases are all about *state* —
 * loading something already running, stopping something already stopped,
 * inspecting something that was removed underneath. A recorder would let all of
 * those pass.
 *
 * The failure knobs exist because every one of `load`'s failure points has to
 * produce a distinct spoken error, and a test is the only sane way to reach
 * "the container refused to start" on demand.
 */

import {
  ContainerNotFoundError,
  ContainerRuntimeError,
  type ContainerDetail,
  type ContainerInfo,
  type ContainerRuntime,
  type ContainerSpec,
} from "./runtime.ts";

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  state: string;
  hostPort: number;
}

export class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, FakeContainer>();
  /** Images `create` will accept. Anything else is a missing image. */
  images = new Set<string>(["localhost/yammer-opencode:latest"]);
  /** Set to make the named verb throw on its next call. */
  failures: Partial<Record<"create" | "start" | "stop" | "remove" | "inspect" | "list", Error>> = {};
  /** Specs `create` was handed, in order — what the mount assertions read. */
  readonly created: ContainerSpec[] = [];

  private nextId = 1;
  private nextPort = 40000;

  async list(labelKey: string): Promise<ContainerInfo[]> {
    this.maybeFail("list");
    return [...this.containers.values()]
      .filter((container) => labelKey in container.labels)
      .map((container) => toInfo(container));
  }

  async create(spec: ContainerSpec): Promise<string> {
    this.maybeFail("create");
    if (!this.images.has(spec.image)) {
      throw new ContainerNotFoundError(`no such image: ${spec.image}`);
    }
    if ([...this.containers.values()].some((container) => container.name === spec.name)) {
      throw new ContainerRuntimeError(`container name ${spec.name} is already in use`);
    }
    this.created.push(spec);
    const id = `fake${this.nextId++}`;
    this.containers.set(id, {
      id,
      name: spec.name,
      image: spec.image,
      labels: { ...spec.labels },
      state: "created",
      hostPort: this.nextPort++,
    });
    return id;
  }

  async start(id: string): Promise<void> {
    this.maybeFail("start");
    this.require(id).state = "running";
  }

  async stop(id: string): Promise<void> {
    this.maybeFail("stop");
    this.require(id).state = "exited";
  }

  async remove(id: string): Promise<void> {
    this.maybeFail("remove");
    this.containers.delete(id);
  }

  async inspect(id: string): Promise<ContainerDetail | null> {
    this.maybeFail("inspect");
    const container = this.containers.get(id);
    if (!container) return null;
    return {
      ...toInfo(container),
      // Matches Podman: the port is bound at create time, so it reads back
      // before the container has ever run.
      hostPort: container.hostPort,
    };
  }

  private require(id: string): FakeContainer {
    const container = this.containers.get(id);
    if (!container) throw new ContainerNotFoundError(`no such container: ${id}`);
    return container;
  }

  private maybeFail(verb: keyof FakeRuntime["failures"]): void {
    const error = this.failures[verb];
    if (error) throw error;
  }
}

function toInfo(container: FakeContainer): ContainerInfo {
  return {
    id: container.id,
    names: [container.name],
    state: container.state,
    labels: { ...container.labels },
  };
}
