/**
 * The routing layer.
 *
 * A cheap, fast LLM call decides whether a transcript is a prompt for OpenCode
 * (the common case) or one of the meta-commands OpenCode can't trigger itself.
 *
 * Two design notes worth keeping in mind when changing this:
 *
 *  - Latency here is not the constraint. Against an OpenCode turn measured in
 *    tens of seconds, a few hundred milliseconds of routing is noise. Do not
 *    trade accuracy for speed.
 *  - Misrouting is the real risk. "Start a new file for the session handler" is
 *    a coding prompt, not `new_session`. Everything below is biased toward
 *    `forward`, and any failure to decide resolves to `forward` too.
 */

import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { META_COMMANDS } from "./commands.ts";

export interface RouteDecision {
  action: "forward" | (string & {});
  /** Present when the router explains itself; logged, never spoken. */
  reason?: string;
}

export interface SessionState {
  /** Null before the first OpenCode turn of the sitting. */
  sessionId: string | null;
  /** Assistant replies so far — lets the router judge "compact" sensibly. */
  turnCount: number;
}

export class RouterError extends Error {}

const SYSTEM_PROMPT = buildSystemPrompt();

export class Router {
  private readonly config: Config["router"];

  constructor(config: Config["router"]) {
    this.config = config;
  }

  async route(
    transcript: string,
    state: SessionState,
    signal?: AbortSignal,
  ): Promise<RouteDecision> {
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        signal: signal ?? null,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(transcript, state) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "route",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["forward", ...META_COMMANDS.map((c) => c.name)],
                  },
                  reason: { type: "string" },
                },
                required: ["action", "reason"],
                additionalProperties: false,
              },
            },
          },
        }),
      });
    } catch (cause) {
      throw new RouterError(`routing request failed: ${String(cause)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "<unreadable>");
      throw new RouterError(`router returned ${response.status}: ${detail.slice(0, 300)}`);
    }

    const decision = parseDecision(await response.json().catch(() => null));
    log.debug("routed", {
      ms: Date.now() - started,
      action: decision.action,
      reason: decision.reason ?? "",
    });
    return decision;
  }
}

function buildSystemPrompt(): string {
  const commands = META_COMMANDS.map((command) => {
    const examples = command.examples.map((e) => `      - "${e}"`).join("\n");
    return `  ${command.name}\n    ${command.description}\n    Examples:\n${examples}`;
  }).join("\n\n");

  return [
    "You route spoken utterances in a voice interface for a coding agent called OpenCode.",
    "",
    "The user is talking hands-free to work on a codebase. Almost everything they",
    "say is meant for OpenCode: questions about the code, instructions to change",
    "it, follow-ups, thinking out loud. Those all take the action `forward`.",
    "",
    "A small number of utterances are instead meta-commands about the session",
    "itself, which OpenCode has no way to act on:",
    "",
    commands,
    "",
    "Rules:",
    "",
    "1. `forward` is the default and by far the most common answer. Choose it",
    "   whenever there is any doubt.",
    "2. Only pick a meta-command when the utterance is unambiguously about the",
    "   session or conversation, not about the code. Words like new, start,",
    "   clear, compact, and summarize appear constantly in ordinary coding",
    "   instructions; they are not on their own evidence of a meta-command.",
    "   'Start a new file', 'clear the cache', and 'summarize this function' are",
    "   all `forward`.",
    "3. A meta-command utterance is short, addressed to the tool rather than",
    "   about the code, and names no file, function, or symbol.",
    "4. The transcript comes from speech recognition and may be imperfectly",
    "   punctuated or slightly misheard. Do not treat transcription noise as",
    "   meaning; route on intent.",
    "",
    "Reply with the action and a brief reason.",
  ].join("\n");
}

function buildUserPrompt(transcript: string, state: SessionState): string {
  const context = state.sessionId
    ? `An OpenCode session is active with ${state.turnCount} ${
        state.turnCount === 1 ? "reply" : "replies"
      } so far.`
    : "No OpenCode session has started yet, so compacting or starting a new session would be pointless.";

  return `${context}\n\nUtterance:\n"""\n${transcript}\n"""`;
}

function parseDecision(payload: unknown): RouteDecision {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new RouterError("router response had no message content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RouterError(`router did not return JSON: ${content.slice(0, 200)}`);
  }

  const action = (parsed as { action?: unknown })?.action;
  const reason = (parsed as { reason?: unknown })?.reason;
  if (typeof action !== "string") {
    throw new RouterError("router response had no action");
  }

  // Defensive: a model that invents an action name must not silently become a
  // meta-command. Anything unrecognised falls back to the safe default.
  if (action !== "forward" && !META_COMMANDS.some((c) => c.name === action)) {
    log.warn("router returned unknown action, forwarding instead", { action });
    return { action: "forward", reason: "unknown action from router" };
  }

  return { action, reason: typeof reason === "string" ? reason : undefined };
}
