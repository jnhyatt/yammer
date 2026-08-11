/**
 * The HTTP client for one OpenCode server.
 *
 * One of these exists per workspace, because one `opencode serve` exists per
 * workspace. It owns everything that is a property of *that server* — its base
 * URL, the directory its filesystem access is scoped to, the resolved model, and
 * whether it knows our agent.
 *
 * What it deliberately does not own is a session id. Sessions belong to a
 * (client, workspace) pair rather than to the workspace, so every session-scoped
 * call here takes the id explicitly and `WorkspaceSession` in `workspace.ts` is
 * what holds one. Two people talking to the same project get two conversations;
 * they share this client, and OpenCode handles the concurrency (verified against
 * a live server: two sessions prompting the same directory overlapped for ~18s
 * and produced a consistent tree).
 *
 * Uses `opencode serve` + the official SDK rather than shelling out to the CLI.
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

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

/**
 * Where one OpenCode server lives and how to talk to it.
 *
 * Deliberately not `Config["opencode"]`: from phase 2 these are per-container
 * values with a dynamically allocated port, not global configuration.
 */
export interface OpenCodeClientOptions {
  baseUrl: string;
  /** The directory OpenCode's filesystem access is scoped to. */
  directory: string;
  /** Optional provider/model override for OpenCode itself. */
  providerId?: string;
  modelId?: string;
  /** OpenCode agent to prompt with — Yammer's own TTS-aware one by default. */
  agent: string;
}

export class OpenCodeClient {
  private readonly options: OpenCodeClientOptions;
  private readonly client: OpencodeClient;
  private model: ModelRef | null = null;

  constructor(options: OpenCodeClientOptions) {
    this.options = options;
    this.client = createOpencodeClient({
      baseUrl: options.baseUrl,
      directory: options.directory,
    });
  }

  get agent(): string {
    return this.options.agent;
  }

  /**
   * Resolve the provider/model to use. Explicit config wins; otherwise take
   * OpenCode's own default so the server doesn't have to hardcode one.
   *
   * Cached per client, which means per workspace: OpenCode's default may point
   * at a model the account cannot use, and that failure now surfaces the first
   * time each workspace is prompted rather than once per boot.
   */
  private async resolveModel(): Promise<ModelRef> {
    if (this.model) return this.model;

    if (this.options.providerId && this.options.modelId) {
      this.model = { providerID: this.options.providerId, modelID: this.options.modelId };
      return this.model;
    }

    const response = await this.call(() => this.client.config.providers());
    const defaults = response?.default ?? {};
    const providerID = this.options.providerId ?? Object.keys(defaults)[0];
    if (!providerID) {
      throw new OpenCodeError("OpenCode reported no configured providers", "error");
    }
    const modelID = this.options.modelId ?? defaults[providerID];
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
        agent: this.options.agent,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (names.includes(this.options.agent)) {
      log.info("opencode agent available", { agent: this.options.agent });
      return;
    }
    log.warn("configured OpenCode agent is unknown — replies will not be TTS-shaped", {
      agent: this.options.agent,
      available: names.join(",") || "(none)",
      hint: "restart opencode serve if the agent file is new",
    });
  }

  /** Start a conversation. The caller owns the returned id. */
  async createSession(): Promise<string> {
    const session = await this.call(() =>
      this.client.session.create({
        body: { title: `Yammer ${new Date().toISOString()}` },
      }),
    );
    const id = (session as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") {
      throw new OpenCodeError("session create returned no id", "error");
    }
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
  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<string> {
    const model = await this.resolveModel();

    const started = Date.now();
    const result = await this.call(() =>
      this.client.session.prompt({
        path: { id: sessionId },
        body: { model, agent: this.options.agent, parts: [{ type: "text", text }] },
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
  async abort(sessionId: string): Promise<void> {
    await this.call(() => this.client.session.abort({ path: { id: sessionId } }));
    log.info("opencode turn aborted", { session: sessionId });
  }

  async compact(sessionId: string): Promise<void> {
    const model = await this.resolveModel();
    await this.call(() =>
      this.client.session.summarize({ path: { id: sessionId }, body: model }),
    );
    log.info("opencode session compacted", { session: sessionId });
  }

  async usage(sessionId: string): Promise<UsageStats> {
    const messages = await this.call(() =>
      this.client.session.messages({ path: { id: sessionId } }),
    );

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
