/**
 * The meta-command catalogue.
 *
 * Meta-commands are things OpenCode itself has no way to trigger. This array is
 * the only place a new one needs to be added: the router's prompt and its
 * output schema are both derived from it, and the handler lives beside the
 * description so there is no second registry to keep in sync.
 *
 * The v1 set is a starting point, not an exhaustive list.
 */

import type { SessionController } from "../opencode/session.ts";

export interface MetaCommand {
  /** Stable identifier. Becomes a value in the router's `action` enum. */
  readonly name: string;
  /** Shown to the router. Describe when it applies, not just what it does. */
  readonly description: string;
  /** Utterances that should route here. Used in the router prompt. */
  readonly examples: readonly string[];
  /** Returns the spoken result. Keep it short — this gets read aloud. */
  run(session: SessionController): Promise<string>;
}

export const META_COMMANDS: readonly MetaCommand[] = [
  {
    name: "report_usage",
    description:
      "Report token usage and cost for the current OpenCode session. Applies " +
      "when the user is asking about spend, tokens, or how much the session " +
      "has cost so far — not when they are asking about costs in the code.",
    examples: [
      "how much has this session cost",
      "what's my token usage",
      "how many tokens have we used",
    ],
    async run(session) {
      const stats = await session.usage();
      if (stats.messages === 0) {
        return "This session hasn't used any tokens yet.";
      }
      const cost = stats.cost >= 0.01 ? `$${stats.cost.toFixed(2)}` : "under a cent";
      return (
        `This session has ${stats.messages} ${stats.messages === 1 ? "reply" : "replies"}, ` +
        `about ${round(stats.inputTokens)} input tokens and ` +
        `${round(stats.outputTokens)} output tokens, costing ${cost}.`
      );
    },
  },
  {
    name: "compact_session",
    description:
      "Compact or summarize the current OpenCode session to free up context. " +
      "Applies when the user is talking about the conversation itself getting " +
      "long — not when they ask to compact or summarize code or a file.",
    examples: [
      "compact the session",
      "summarize the conversation so far",
      "the context is getting long, compact it",
    ],
    async run(session) {
      await session.compact();
      return "Session compacted.";
    },
  },
  {
    name: "new_session",
    description:
      "Abandon the current OpenCode session and start a fresh one, losing all " +
      "conversation history. Applies only when the user clearly means the " +
      "OpenCode conversation. It does NOT apply to creating new files, new " +
      "functions, new branches, or anything else in the codebase.",
    examples: [
      "start a new session",
      "clear the conversation and start over",
      "forget everything, fresh session",
    ],
    async run(session) {
      await session.startNewSession();
      return "Started a new session.";
    },
  },
];

export function findCommand(name: string): MetaCommand | undefined {
  return META_COMMANDS.find((command) => command.name === name);
}

function round(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
