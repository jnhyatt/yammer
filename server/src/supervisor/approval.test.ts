/**
 * The two sources of an approval, and the sentences they produce.
 *
 * `keywords.test.ts` covers what the user's answer means. This covers the other
 * half of the same conversation: what they were asked, and what happens to the
 * thing they were asked about.
 *
 * The failures worth guarding are ones nothing else would catch:
 *
 * - **Offering an answer that goes nowhere.** "Say approve, always, or deny" on
 *   a workspace delete invites a word the supervisor cannot honour, and a user
 *   who says it believes they have set something up that does not exist.
 * - **Reporting a decision that wasn't made.** Answering `always` where nothing
 *   can be remembered must not resolve as `always`.
 * - **A settle path that skips half its job.** OpenCode being unreachable when
 *   we reply must not stop the abort — that pair is what protects a user whose
 *   headphones are out.
 *
 *   node --test --experimental-strip-types src/supervisor/approval.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { setLogLevel } from "../log.ts";
import type { PermissionRequest } from "../opencode/permissions.ts";
import { agentApproval, yammerApproval, type PermissionContext } from "./approval.ts";
import { askQuestion, failureSentence, outcomeSentence, repromptQuestion } from "./speech.ts";

before(() => setLogLevel("error"));

function permission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["git reset --hard HEAD~3"],
    metadata: { command: "git reset --hard HEAD~3" },
    always: ["git reset *"],
    ...overrides,
  };
}

/** Records what a settle actually did to OpenCode. */
function context(): PermissionContext & { replies: string[]; aborts: number; fail?: boolean } {
  const state = {
    replies: [] as string[],
    aborts: 0,
    fail: false,
    reply: async (_id: string, reply: string) => {
      if (state.fail) throw new Error("opencode is unreachable");
      state.replies.push(reply);
    },
    abortTurn: async () => {
      state.aborts += 1;
    },
  };
  return state as unknown as PermissionContext & {
    replies: string[];
    aborts: number;
    fail?: boolean;
  };
}

// --- the agent's side ------------------------------------------------------

describe("agentApproval", () => {
  it("speaks the command, symbols and all", () => {
    const request = agentApproval(permission(), context(), null);
    assert.equal(
      request.description,
      "The agent wants to run git reset flag hard HEAD tilde 3.",
    );
  });

  it("offers always only when it is broader than the command asked about", () => {
    assert.equal(agentApproval(permission(), context(), null).always, "git reset *");
    // OpenCode sometimes generalizes to exactly the command. Saying "this also
    // allows the thing I just described" is noise dressed up as a warning.
    const same = permission({ patterns: ["rm -rf ."], always: ["rm -rf ."] });
    assert.equal(agentApproval(same, context(), null).always, null);
    assert.equal(agentApproval(permission({ always: [] }), context(), null).always, null);
  });

  it("puts the workspace's own directory at stake, for the working tree only", () => {
    const request = agentApproval(permission(), context(), "/workspaces/space-game");
    assert.deepEqual(request.stakes, {
      directory: "/workspaces/space-game",
      scope: "working-tree",
    });
  });

  it("replies to OpenCode with what was decided", async () => {
    const ctx = context();
    await agentApproval(permission(), ctx, null).settle("always");
    assert.deepEqual(ctx.replies, ["always"]);
    assert.equal(ctx.aborts, 0);
  });

  it("turns a timeout into a rejection plus a stop", async () => {
    // The difference between "not that one" and "I'm not here" — one lets the
    // agent carry on, the other must not.
    const ctx = context();
    await agentApproval(permission(), ctx, null).settle("timeout");
    assert.deepEqual(ctx.replies, ["reject"]);
    assert.equal(ctx.aborts, 1);
  });

  it("still stops the agent when the reply itself fails", async () => {
    const ctx = context();
    ctx.fail = true;
    await agentApproval(permission(), ctx, null).settle("timeout");
    assert.deepEqual(ctx.replies, []);
    assert.equal(ctx.aborts, 1, "an unreachable OpenCode must not leave the agent running");
  });
});

// --- Yammer's own side -----------------------------------------------------

describe("yammerApproval", () => {
  it("offers no always, because there is nothing to remember", () => {
    const request = yammerApproval({ id: "yammer-1", description: "This deletes it." });
    assert.equal(request.always, null);
    assert.equal(request.source, "yammer");
  });

  it("settles by doing nothing — the answer is the return value", async () => {
    // Nothing is blocked waiting on this. The caller is Yammer, holding the
    // boolean, which is why `settle` has nothing to unblock.
    await yammerApproval({ id: "yammer-1", description: "x" }).settle("reject");
  });
});

// --- what gets said --------------------------------------------------------

describe("askQuestion", () => {
  it("orders it: what, what always widens to, what's at stake, how to answer", () => {
    const request = agentApproval(permission(), context(), "/workspaces/x");
    const question = askQuestion(request, "There are uncommitted changes in 2 files.");
    const order = [
      question.indexOf("The agent wants to"),
      question.indexOf("Saying always"),
      question.indexOf("uncommitted changes"),
      question.indexOf("Say approve"),
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order, question);
  });

  it("never offers always when the request has none", () => {
    const request = yammerApproval({ id: "yammer-1", description: "This deletes space game." });
    const question = askQuestion(request, null);
    assert.equal(question, "This deletes space game. Say approve or deny.");
  });

  it("leaves the sentence out entirely when nothing is at stake", () => {
    const question = askQuestion(agentApproval(permission(), context(), null), null);
    // A clause on every prompt saying "nothing would be lost" would teach the
    // user to stop hearing the one that says otherwise.
    assert.doesNotMatch(question, /nothing/i);
  });
});

describe("repromptQuestion", () => {
  it("keeps the menu honest on a second attempt", () => {
    assert.match(repromptQuestion("silence", true), /approve, always, or deny/);
    assert.match(repromptQuestion("silence", false), /approve or deny/);
    assert.doesNotMatch(repromptQuestion("unrecognized", false), /always/);
  });

  it("says which way it failed", () => {
    assert.match(repromptQuestion("silence", true), /didn't hear/);
    assert.match(repromptQuestion("unrecognized", true), /didn't understand/);
  });
});

describe("outcomeSentence", () => {
  it("tells the agent's user that the turn is over", () => {
    // OpenCode does not resume after a refusal, so this sentence is the whole
    // of what they hear back.
    assert.match(outcomeSentence("agent", "reject"), /agent stopped there/);
    assert.match(outcomeSentence("agent", "always"), /from now on/);
  });

  it("does not claim an agent stopped when Yammer simply didn't act", () => {
    assert.equal(outcomeSentence("yammer", "reject"), "Okay, leaving it alone.");
    assert.equal(outcomeSentence("yammer", "once"), "Okay, doing it.");
    // Nothing was remembered, so it must not sound like it was.
    assert.equal(outcomeSentence("yammer", "always"), outcomeSentence("yammer", "once"));
  });

  it("says the same thing about silence in both directions: no", () => {
    assert.match(outcomeSentence("agent", "timeout"), /No answer/);
    assert.match(outcomeSentence("yammer", "timeout"), /No answer/);
  });
});

describe("failureSentence", () => {
  it("says what did not happen, per source", () => {
    assert.match(failureSentence("agent"), /denied it/);
    assert.match(failureSentence("yammer"), /didn't do it/);
  });
});
