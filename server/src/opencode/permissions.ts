/**
 * OpenCode permission requests: watching for them, and answering them.
 *
 * When a tool call matches an `ask` rule in the agent's permission config,
 * OpenCode blocks the call and publishes a `permission.asked` event on its
 * global SSE stream. The blocked `session.prompt()` POST stays open the whole
 * time, on a different connection — so answering is not a deadlock, but it does
 * mean this watcher has to be running independently of any turn.
 *
 * Two things about this API cost time to discover and are worth stating:
 *
 * - The installed `@opencode-ai/sdk` types are wrong here. They describe
 *   `permission.updated` and `POST /session/{id}/permissions/{permissionID}`
 *   with a `title` field. The running server (1.18.x) emits `permission.asked`
 *   with no `title`, and takes replies at `POST /permission/{id}/reply`. This
 *   module talks to the real endpoints over `fetch` rather than the SDK so the
 *   mismatch can't silently reappear as a type-level lie.
 * - `always` in the payload is a *generalized* pattern (`git push *` for
 *   `git push origin main --force`), not the specific command. Answering
 *   "always" grants the pattern, which is much broader than what was asked
 *   about. The supervisor says this out loud for exactly that reason.
 */

import { log } from "../log.ts";

/** A blocked tool call awaiting an answer. Mirrors OpenCode's `PermissionRequest`. */
export interface PermissionRequest {
  /** `per_…`. Opaque; the reply endpoint is keyed on it. */
  id: string;
  sessionID: string;
  /** The permission name — `bash`, `edit`, `external_directory`, … */
  permission: string;
  /** What actually matched, e.g. the exact command. */
  patterns: string[];
  /** Tool-specific detail. For bash this holds `command`. */
  metadata: Record<string, unknown>;
  /** The broader pattern an "always" answer would grant. */
  always: string[];
}

/** OpenCode's reply vocabulary. There is no "deny always". */
export type PermissionReply = "once" | "always" | "reject";

export class PermissionError extends Error {}

type Handler = (request: PermissionRequest) => void;

export class PermissionWatcher {
  private readonly baseUrl: string;
  private readonly directory: string;
  private handler: Handler | null = null;
  private controller: AbortController | null = null;
  private running = false;

  constructor(baseUrl: string, directory: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.directory = directory;
  }

  onAsked(handler: Handler): void {
    this.handler = handler;
  }

  /** Begin consuming the event stream, reconnecting until `stop()`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}?directory=${encodeURIComponent(this.directory)}`;
  }

  /**
   * Reconnecting SSE consumer.
   *
   * A dropped stream is not fatal and not rare — OpenCode restarts, the socket
   * idles out. What it does mean is that a permission asked while we were
   * disconnected was never seen, which is what `listPending()` reconciles.
   */
  private async loop(): Promise<void> {
    let backoffMs = 500;

    while (this.running) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const response = await fetch(this.url("/event"), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new PermissionError(`event stream returned ${response.status}`);
        }

        log.info("watching OpenCode permission events");
        backoffMs = 500;
        await this.consume(response.body);
      } catch (cause) {
        if (!this.running) return;
        log.warn("permission event stream dropped", { error: String(cause) });
      }

      if (!this.running) return;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 10_000);

      // Anything asked while we were away is still blocking OpenCode.
      await this.reconcile();
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    while (this.running) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;

      // SSE frames are separated by a blank line; a frame may span reads.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        this.dispatch(frame);
      }
    }
  }

  private dispatch(frame: string): void {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event: { type?: unknown; properties?: unknown };
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type !== "permission.asked") continue;

      const request = toRequest(event.properties);
      if (!request) {
        log.warn("permission.asked with an unreadable payload");
        continue;
      }
      log.info("permission asked", {
        id: request.id,
        permission: request.permission,
        pattern: request.patterns[0] ?? "",
      });
      this.handler?.(request);
    }
  }

  /** Re-deliver anything pending, e.g. after a reconnect. Idempotent downstream. */
  private async reconcile(): Promise<void> {
    try {
      for (const request of await this.listPending()) {
        log.info("re-delivering pending permission", { id: request.id });
        this.handler?.(request);
      }
    } catch (cause) {
      log.debug("could not reconcile pending permissions", { error: String(cause) });
    }
  }

  /** Everything currently blocked and unanswered. */
  async listPending(): Promise<PermissionRequest[]> {
    const response = await fetch(this.url("/permission"));
    if (!response.ok) {
      throw new PermissionError(`listing permissions returned ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return [];
    return payload
      .map(toRequest)
      .filter((request): request is PermissionRequest => request !== null);
  }

  /** Answer a request. Unblocks the tool call one way or the other. */
  async reply(id: string, reply: PermissionReply): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.url(`/permission/${encodeURIComponent(id)}/reply`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply }),
      });
    } catch (cause) {
      throw new PermissionError(`could not reach OpenCode to reply: ${String(cause)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "<unreadable>");
      throw new PermissionError(
        `replying ${reply} to ${id} returned ${response.status}: ${detail.slice(0, 200)}`,
      );
    }
    log.info("permission answered", { id, reply });
  }
}

function toRequest(raw: unknown): PermissionRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value["id"] !== "string" || typeof value["sessionID"] !== "string") {
    return null;
  }
  return {
    id: value["id"],
    sessionID: value["sessionID"],
    permission: typeof value["permission"] === "string" ? value["permission"] : "unknown",
    patterns: Array.isArray(value["patterns"]) ? value["patterns"].map(String) : [],
    metadata:
      typeof value["metadata"] === "object" && value["metadata"] !== null
        ? (value["metadata"] as Record<string, unknown>)
        : {},
    always: Array.isArray(value["always"]) ? value["always"].map(String) : [],
  };
}
