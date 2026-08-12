/**
 * What the supervisor supervises, independent of who asked.
 *
 * The supervisor is invoked from two directions and the requirements doc is
 * explicit that both are first-class: an OpenCode permission event from inside
 * a container, and Yammer itself, for the destructive things it does on the
 * user's behalf *outside* any container. Those two have almost nothing in
 * common on the wire — a permission has an id, a tool name, match patterns and
 * a generalizable `always`; a workspace delete has a name and a directory — so
 * what they share has to be stated as its own type rather than one of them
 * being bent into the shape of the other.
 *
 * An `ApprovalRequest` is that shape: something to say, optionally something
 * "always" would widen to, optionally a directory whose contents are at stake,
 * and a way to settle it. Everything source-specific lives in the two adapters
 * below, so the supervisor's ask-listen-settle loop never branches on where a
 * request came from.
 */

import { log } from "../log.ts";
import type { PermissionReply, PermissionRequest } from "../opencode/permissions.ts";
import type { PermissionResponse } from "../protocol.ts";
import type { StakesScope } from "../git.ts";
import { describeRequest } from "./speech.ts";

/**
 * Who is asking. Decides the wording, and nothing else — both sources get the
 * same loop, the same voice, and the same answer vocabulary.
 */
export type ApprovalSource = "agent" | "yammer";

/** What the outcome puts at risk, so the prompt can say what is in there. */
export interface Stakes {
  /** Host-side directory. Yammer reads it directly; see `git.ts`. */
  directory: string;
  scope: StakesScope;
}

export interface ApprovalRequest {
  /** Correlates `permission.ask`, `answer.*` and `permission.resolved`. */
  readonly id: string;
  readonly source: ApprovalSource;
  /**
   * The first thing said, as one or more complete sentences. The answer menu is
   * not part of it — the supervisor appends that, because which answers are on
   * offer is its business rather than the caller's.
   */
  readonly description: string;
  /**
   * What an "always" answer would widen to, spoken aloud, or null when "always"
   * is not offered at all. Yammer's own actions have nothing to widen to: there
   * is no pattern to remember and no second occurrence to remember it for.
   */
  readonly always: string | null;
  /** What is in the line of fire, for a grounded clause. Null when nothing is. */
  readonly stakes: Stakes | null;
  /**
   * Act on the decision. Called exactly once, on every path including failures.
   *
   * `timeout` means nobody is there, which is a rejection *plus* whatever
   * stopping looks like for this source.
   */
  settle(outcome: PermissionResponse): Promise<void>;
}

/**
 * How to answer an OpenCode permission, supplied per request rather than per
 * supervisor.
 *
 * Both halves are properties of the session that raised the question, not of
 * the client being asked it: with a permission stream per workspace, "which
 * server do I answer" has to travel with the request.
 */
export interface PermissionContext {
  /** Answer the request, unblocking the tool call either way. */
  reply(id: string, reply: PermissionReply): Promise<void>;
  /** Stop the agent that raised it. Only the no-answer path uses this. */
  abortTurn(): Promise<void>;
}

/**
 * A blocked tool call, as something the supervisor can ask about.
 *
 * `directory` is the workspace's host-side path. Every gated command reaches
 * the supervisor because it can destroy work through the bind mount — that is
 * the whole of what the agent's ask-list now contains — so the prompt is always
 * worth grounding in what is actually sitting in there uncommitted.
 */
export function agentApproval(
  request: PermissionRequest,
  context: PermissionContext,
  directory: string | null,
): ApprovalRequest {
  const always = request.always[0];
  const specific = request.patterns[0];
  return {
    id: request.id,
    source: "agent",
    description: `The agent wants to ${describeRequest(request)}.`,
    // Only when it is genuinely broader than what was asked about. Saying "this
    // allows exactly the thing you were just asked about" is noise.
    always: typeof always === "string" && always !== "" && always !== specific ? always : null,
    stakes: directory === null ? null : { directory, scope: "working-tree" },
    settle: async (outcome) => {
      const reply: PermissionReply = outcome === "timeout" ? "reject" : outcome;
      try {
        await context.reply(request.id, reply);
      } catch (cause) {
        // Logged and swallowed: OpenCode being unreachable must not stop the
        // abort below, which is the half that protects an unattended user.
        log.error("could not answer permission", { id: request.id, error: String(cause) });
      }
      if (outcome === "timeout") {
        try {
          await context.abortTurn();
        } catch (cause) {
          log.warn("could not abort the turn after a timeout", { error: String(cause) });
        }
      }
    },
  };
}

/**
 * Something Yammer is about to do itself.
 *
 * There is nothing to unblock — the caller is Yammer, waiting on the boolean —
 * so `settle` does nothing and the decision travels back as the return value of
 * `approve`. "Always" is not offered, for want of anything to remember.
 */
export function yammerApproval(options: {
  id: string;
  description: string;
  stakes?: Stakes | null;
}): ApprovalRequest {
  return {
    id: options.id,
    source: "yammer",
    description: options.description,
    always: null,
    stakes: options.stakes ?? null,
    settle: async () => {},
  };
}
