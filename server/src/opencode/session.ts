/**
 * OpenCode integration.
 *
 * One continuous session per work sitting, not one per utterance. The session
 * is reset only by the `new_session` meta-command.
 *
 * Uses `opencode serve` + the official SDK rather than shelling out to the CLI.
 * Filesystem scope comes from the `directory` on the client config, so every
 * call is confined to the configured project directory.
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

import type { Config } from "../config.ts";
import { log } from "../log.ts";

export class OpenCodeError extends Error {
  readonly kind: "unreachable" | "error";

  constructor(message: string, kind: "unreachable" | "error") {
    super(message);
    this.kind = kind;
  }
}

interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface UsageStats {
  messages: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

/** Structural contract the meta-commands depend on. */
export interface SessionController {
  prompt(text: string, signal?: AbortSignal): Promise<string>;
  startNewSession(): Promise<void>;
  compact(): Promise<void>;
  usage(): Promise<UsageStats>;
}

export class OpenCodeSession implements SessionController {
  private readonly config: Config["opencode"];
  private readonly client: OpencodeClient;
  private sessionId: string | null = null;
  private model: ModelRef | null = null;

  constructor(config: Config["opencode"]) {
    this.config = config;
    this.client = createOpencodeClient({
      baseUrl: config.baseUrl,
      directory: config.projectDir,
    });
  }

  /** Null until the first turn of the sitting creates a session. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Resolve the provider/model to use. Explicit config wins; otherwise take
   * OpenCode's own default so the server doesn't have to hardcode one.
   */
  private async resolveModel(): Promise<ModelRef> {
    if (this.model) return this.model;

    if (this.config.providerId && this.config.modelId) {
      this.model = { providerID: this.config.providerId, modelID: this.config.modelId };
      return this.model;
    }

    const response = await this.call(() => this.client.config.providers());
    const defaults = response?.default ?? {};
    const providerID = this.config.providerId ?? Object.keys(defaults)[0];
    if (!providerID) {
      throw new OpenCodeError("OpenCode reported no configured providers", "error");
    }
    const modelID = this.config.modelId ?? defaults[providerID];
    if (!modelID) {
      throw new OpenCodeError(
        `OpenCode reported no default model for provider ${providerID}`,
        "error",
      );
    }

    this.model = { providerID, modelID };
    log.info("resolved OpenCode model", { providerID, modelID });
    return this.model;
  }

  /**
   * Warn at startup if OpenCode doesn't know the configured agent.
   *
   * Worth a dedicated check because the failure is otherwise invisible until the
   * first forwarded turn, and its likeliest cause is subtle: OpenCode reads
   * agent files once at boot and never hot-reloads them, so a newly added
   * `.opencode/agent/*.md` means nothing to an `opencode serve` that was already
   * running. Never fatal — OpenCode being unreachable at startup is a per-turn
   * error path, not a configuration error.
   */
  async verifyAgent(): Promise<void> {
    let names: string[];
    try {
      const agents = await this.call(() => this.client.app.agents());
      names = (Array.isArray(agents) ? agents : [])
        .map((agent) => (agent as { name?: unknown }).name)
        .filter((name): name is string => typeof name === "string");
    } catch (error) {
      log.warn("could not verify OpenCode agent", {
        agent: this.config.agent,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (names.includes(this.config.agent)) {
      log.info("opencode agent available", { agent: this.config.agent });
      return;
    }
    log.warn("configured OpenCode agent is unknown — replies will not be TTS-shaped", {
      agent: this.config.agent,
      available: names.join(",") || "(none)",
      hint: "restart opencode serve if the agent file is new",
    });
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const session = await this.call(() =>
      this.client.session.create({
        body: { title: `Yammer ${new Date().toISOString()}` },
      }),
    );
    const id = (session as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") {
      throw new OpenCodeError("session create returned no id", "error");
    }
    this.sessionId = id;
    log.info("opencode session started", { session: id });
    return id;
  }

  /**
   * Send a transcript to OpenCode verbatim and return its spoken-form reply.
   *
   * Verbatim is a deliberate v1 constraint — no reformatting, no injected
   * context. TTS-appropriate output is OpenCode's own agent config's job, which
   * is what `agent` selects: the checked-in `yammer` agent whose prompt bans
   * headings, lists, code, and paths. OpenCode's default agent formats for a
   * screen, and Kokoro reads that formatting out loud.
   */
  async prompt(text: string, signal?: AbortSignal): Promise<string> {
    const id = await this.ensureSession();
    const model = await this.resolveModel();

    const started = Date.now();
    const result = await this.call(() =>
      this.client.session.prompt({
        path: { id },
        body: { model, agent: this.config.agent, parts: [{ type: "text", text }] },
        signal,
      }),
    );

    const reply = extractText(result);
    log.debug("opencode replied", { ms: Date.now() - started, chars: reply.length });
    if (reply === "") {
      throw new OpenCodeError("OpenCode returned an empty response", "error");
    }
    return reply;
  }

  /**
   * Stop the in-flight turn without touching the session.
   *
   * The distinction matters for the supervisor's timeout path: aborting ends
   * what the agent is doing, but the session and its whole history survive, so
   * "what were you in the middle of?" on a later utterance picks up exactly
   * where it stopped. Confirmed against a live OpenCode — a rejected tool call
   * lands in the history as a terminal error state, leaving nothing dangling
   * for the next prompt to choke on.
   */
  async abort(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    await this.call(() => this.client.session.abort({ path: { id } }));
    log.info("opencode turn aborted", { session: id });
  }

  async startNewSession(): Promise<void> {
    const session = await this.call(() =>
      this.client.session.create({
        body: { title: `Yammer ${new Date().toISOString()}` },
      }),
    );
    const id = (session as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") {
      throw new OpenCodeError("session create returned no id", "error");
    }
    const previous = this.sessionId;
    this.sessionId = id;
    log.info("opencode session replaced", { previous, session: id });
  }

  async compact(): Promise<void> {
    const id = await this.ensureSession();
    const model = await this.resolveModel();
    await this.call(() =>
      this.client.session.summarize({ path: { id }, body: model }),
    );
    log.info("opencode session compacted", { session: id });
  }

  async usage(): Promise<UsageStats> {
    const id = await this.ensureSession();
    const messages = await this.call(() => this.client.session.messages({ path: { id } }));

    const stats: UsageStats = { messages: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
    for (const entry of Array.isArray(messages) ? messages : []) {
      const info = (entry as { info?: Record<string, unknown> }).info;
      if (!info || info["role"] !== "assistant") continue;
      stats.messages += 1;
      if (typeof info["cost"] === "number") stats.cost += info["cost"];
      const tokens = info["tokens"] as { input?: unknown; output?: unknown } | undefined;
      if (typeof tokens?.input === "number") stats.inputTokens += tokens.input;
      if (typeof tokens?.output === "number") stats.outputTokens += tokens.output;
    }
    return stats;
  }

  /**
   * Run an SDK call, normalising its two failure shapes into OpenCodeError:
   * a thrown transport error (server down) and a returned `error` field.
   */
  private async call<T>(fn: () => Promise<{ data?: T; error?: unknown }>): Promise<T> {
    let result: { data?: T; error?: unknown };
    try {
      result = await fn();
    } catch (cause) {
      throw new OpenCodeError(`could not reach OpenCode: ${String(cause)}`, "unreachable");
    }
    if (result.error !== undefined && result.error !== null) {
      throw new OpenCodeError(`OpenCode returned an error: ${describe(result.error)}`, "error");
    }
    if (result.data === undefined) {
      throw new OpenCodeError("OpenCode returned no data", "error");
    }
    return result.data;
  }
}

/** Pull the assistant's text out of a prompt response's parts array. */
function extractText(result: unknown): string {
  const parts = (result as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  const data = error as { data?: { message?: unknown }; message?: unknown };
  if (typeof data?.data?.message === "string") return data.data.message;
  if (typeof data?.message === "string") return data.message;
  return JSON.stringify(error).slice(0, 300);
}
