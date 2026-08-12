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
  /**
   * The workspace name the model heard, for the commands that take one.
   *
   * Empty for everything else, including a workspace command whose utterance
   * named nothing — which is a spoken error rather than a default, because the
   * alternative is deleting whichever workspace happened to be nearest.
   */
  workspace: string;
  /** Present when the router explains itself; logged, never spoken. */
  reason?: string;
}

export interface SessionState {
  /** Null before the first OpenCode turn of the sitting. */
  sessionId: string | null;
  /** Assistant replies so far — lets the router judge "compact" sensibly. */
  turnCount: number;
}

export class RouterError extends Error {
  /**
   * True when the call reached the model and came back unusable, rather than
   * failing outright. Only these are worth asking again — see `route`.
   */
  readonly malformed: boolean;

  constructor(message: string, malformed = false) {
    super(message);
    this.malformed = malformed;
  }
}

const SYSTEM_PROMPT = buildSystemPrompt();

export class Router {
  private readonly config: Config["router"];

  constructor(config: Config["router"]) {
    this.config = config;
  }

  /**
   * Route once, and ask a second time if the first answer was unusable.
   *
   * Not a general retry policy: this exists for one observed failure. Models
   * that support `response_format: json_schema` strict mode do not honour it
   * reliably — the eval catches the dated `deepseek-v4-flash` returning its
   * three fields as prose in roughly 3% of calls, which is a whole turn lost
   * to "the router failed" for something the model actually decided correctly.
   * A single retry costs one extra call on 3% of turns and nothing on the rest.
   *
   * Deliberately *not* extended to transport failures or non-2xx responses:
   * those are a different problem with a different right answer, and retrying
   * them here would hide a down provider behind a doubled latency.
   */
  async route(
    transcript: string,
    state: SessionState,
    signal?: AbortSignal,
  ): Promise<RouteDecision> {
    try {
      return await this.ask(transcript, state, signal);
    } catch (cause) {
      if (!(cause instanceof RouterError) || !cause.malformed) throw cause;
      log.warn("router answered with something unusable, asking once more", {
        error: cause.message.slice(0, 200),
      });
      return this.ask(transcript, state, signal);
    }
  }

  private async ask(
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
                  // Required even when it does not apply, because strict mode
                  // requires every property to be — hence "empty string", not
                  // "omitted", as the way to say there is no name here.
                  workspace: {
                    type: "string",
                    description:
                      "The workspace name the user said, for workspace commands. " +
                      "Empty string for every other action.",
                  },
                  reason: { type: "string" },
                },
                required: ["action", "workspace", "reason"],
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
      workspace: decision.workspace,
      reason: decision.reason ?? "",
    });
    return decision;
  }
}

function buildSystemPrompt(): string {
  const commands = META_COMMANDS.map((command) => {
    const examples = command.examples.map((e) => `      - "${e}"`).join("\n");
    const slot = command.takesWorkspace ? "\n    Takes a workspace name.": "";
    return `  ${command.name}\n    ${command.description}${slot}\n    Examples:\n${examples}`;
  }).join("\n\n");

  const named = META_COMMANDS.filter((c) => c.takesWorkspace).map((c) => c.name);

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
    "5. A workspace is a whole project, not a thing inside one. Files,",
    "   directories, branches, tests, functions and configs are never",
    "   workspaces, however the sentence is phrased. 'Delete the old test",
    "   directory' and 'load the config' are `forward`.",
    "",
    "The workspace field:",
    "",
    `- Fill it in only for ${named.join(", ")}. Every other action leaves it as`,
    "  an empty string.",
    "- Put the name the user said, and nothing else. Strip the words around it:",
    "  articles, verbs, and the nouns people attach to a name in passing —",
    "  workspace, project, repo, one. 'the parser project' is `parser`; 'a",
    "  workspace called space game' is `space game`. Spacing, hyphenation and",
    "  capitalisation do not matter; they are normalised afterwards.",
    "- Never invent or complete a name that was not said. If one of those",
    "  actions is clearly meant but no name was spoken, leave the field empty —",
    "  the user is told what was missing, which is far better than acting on a",
    "  guessed name.",
    "",
    "Reply with the action, the workspace, and a brief reason.",
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
    throw new RouterError("router response had no message content", true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RouterError(`router did not return JSON: ${content.slice(0, 200)}`, true);
  }

  const action = (parsed as { action?: unknown })?.action;
  const reason = (parsed as { reason?: unknown })?.reason;
  const workspace = (parsed as { workspace?: unknown })?.workspace;
  if (typeof action !== "string") {
    throw new RouterError("router response had no action", true);
  }

  // Defensive: a model that invents an action name must not silently become a
  // meta-command. Anything unrecognised falls back to the safe default.
  const command = META_COMMANDS.find((c) => c.name === action);
  if (action !== "forward" && !command) {
    log.warn("router returned unknown action, forwarding instead", { action });
    return { action: "forward", workspace: "", reason: "unknown action from router" };
  }

  return {
    action,
    // Dropped for anything that does not take one, so a model that fills the
    // slot on a `forward` cannot have it read as an argument later.
    workspace: command?.takesWorkspace && typeof workspace === "string" ? workspace.trim() : "",
    reason: typeof reason === "string" ? reason : undefined,
  };
}
