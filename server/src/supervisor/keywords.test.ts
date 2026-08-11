/**
 * The first checked-in test in this repo, and it guards the right thing.
 *
 * Everything else here fails loudly — a bad model id 404s, a protocol mismatch
 * closes the socket. This is the one component whose failure is silent and
 * expensive: a mistranscription classified as "approve" force-pushes a branch,
 * and nothing about that looks like an error at the time.
 *
 * The fixtures are real Whisper output shapes, not invented strings. Whisper
 * capitalizes and punctuates even single words ("Approve."), and it hallucinates
 * a small, consistent set of phrases on near-silence.
 *
 *   node --test --experimental-strip-types src/supervisor/keywords.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchAnswer, normalizeAnswer } from "./keywords.ts";

describe("normalizeAnswer", () => {
  it("strips the punctuation and capitalization Whisper adds", () => {
    assert.equal(normalizeAnswer("Approve."), "approve");
    assert.equal(normalizeAnswer("  DENY!  "), "deny");
    assert.equal(normalizeAnswer("Always, allow."), "always allow");
  });

  it("drops filler without eating the answer", () => {
    assert.equal(normalizeAnswer("uh, approve"), "approve");
    assert.equal(normalizeAnswer("um deny please"), "deny");
  });

  it("folds apostrophes so negators match as one token", () => {
    assert.equal(normalizeAnswer("Don't."), "dont");
  });
});

describe("matchAnswer: approving", () => {
  for (const input of ["approve", "Approve.", "  approve  ", "APPROVE", "approved"]) {
    it(`approves ${JSON.stringify(input)}`, () => {
      assert.equal(matchAnswer(input).kind, "approve");
    });
  }

  for (const input of ["always", "Always.", "always allow", "allow always"]) {
    it(`grants the pattern for ${JSON.stringify(input)}`, () => {
      assert.equal(matchAnswer(input).kind, "always");
    });
  }
});

describe("matchAnswer: refusing", () => {
  for (const input of ["deny", "Deny.", "denied", "no", "nope", "cancel", "stop", "reject"]) {
    it(`denies ${JSON.stringify(input)}`, () => {
      assert.equal(matchAnswer(input).kind, "deny");
    });
  }

  // Whisper's usual manglings of "deny". Leniency here is free: a wrong deny
  // costs one retry.
  for (const input of ["the nine", "dini", "Denial."]) {
    it(`treats the mishearing ${JSON.stringify(input)} as a denial`, () => {
      assert.equal(matchAnswer(input).kind, "deny");
    });
  }
});

describe("matchAnswer: the dangerous cases", () => {
  // The entire reason matching is against the whole string rather than a
  // substring. Every one of these contains an affirmative.
  for (const input of [
    "don't approve",
    "do not approve",
    "no, don't approve that",
    "not approve",
    "never approve",
    "no always",
  ]) {
    it(`refuses ${JSON.stringify(input)} rather than approving it`, () => {
      assert.equal(matchAnswer(input).kind, "deny");
    });
  }

  // Whisper's mishearings of "approve". These must NOT approve — they reprompt.
  for (const input of ["a prove", "improve", "prove", "groove", "approve the"]) {
    it(`does not approve on the mishearing ${JSON.stringify(input)}`, () => {
      assert.notEqual(matchAnswer(input).kind, "approve");
      assert.notEqual(matchAnswer(input).kind, "always");
    });
  }
});

describe("matchAnswer: silence", () => {
  // Whisper emits these confidently for near-silence. They are not answers, and
  // must not burn an attempt as though the user said something unparseable.
  for (const input of ["", "   ", "Thank you.", "Thanks for watching!", "you", "Bye."]) {
    it(`reads ${JSON.stringify(input)} as silence`, () => {
      assert.equal(matchAnswer(input).kind, "silence");
    });
  }
});

describe("matchAnswer: unrecognized", () => {
  it("reprompts on speech it cannot classify", () => {
    const match = matchAnswer("what is it doing");
    assert.equal(match.kind, "unrecognized");
  });

  it("reports what it heard, for the log", () => {
    const match = matchAnswer("Push it to main.");
    assert.equal(match.kind, "unrecognized");
    if (match.kind === "unrecognized") {
      assert.equal(match.normalized, "push it to main");
    }
  });
});
