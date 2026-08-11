/**
 * Router eval cases.
 *
 * The router's failure mode is not "picks the wrong meta-command" — with three
 * commands and a `forward` default, that's rare. It's misrouting an ordinary
 * coding instruction into a meta-command: "start a new file" firing
 * `new_session` and silently discarding the conversation, eyes-free, with no
 * undo. That is the thing worth measuring, so `adversarial` cases — forward
 * utterances that reuse a meta-command's trigger words in a coding context —
 * outnumber the straightforward positives.
 *
 * `critical: true` marks cases where a misroute is destructive
 * (`new_session` loses history) rather than merely wrong (`report_usage`
 * misfiring just gets read back an answer to a question that wasn't asked).
 * The eval report calls these out separately from the raw accuracy number.
 */

export type ExpectedAction = "forward" | "report_usage" | "compact_session" | "new_session";

export interface EvalCase {
  transcript: string;
  expected: ExpectedAction;
  /** Groups cases in the report; not fed to the router. */
  category: "meta-positive" | "adversarial" | "forward-generic" | "forward-ambiguous";
  /** A misroute here is destructive, not just wrong. */
  critical?: boolean;
}

export const EVAL_CASES: readonly EvalCase[] = [
  // --- report_usage: positives -------------------------------------------
  { transcript: "how much has this session cost so far", expected: "report_usage", category: "meta-positive" },
  { transcript: "what's my token usage", expected: "report_usage", category: "meta-positive" },
  { transcript: "how many tokens have we used", expected: "report_usage", category: "meta-positive" },
  { transcript: "give me a usage report", expected: "report_usage", category: "meta-positive" },
  { transcript: "what am I spending on this conversation", expected: "report_usage", category: "meta-positive" },

  // --- report_usage: adversarial (mentions cost/tokens, means code) ------
  {
    transcript: "what's the time complexity cost of this function",
    expected: "forward",
    category: "adversarial",
  },
  {
    transcript: "can we reduce the token count in this prompt template",
    expected: "forward",
    category: "adversarial",
  },
  { transcript: "how expensive is this database query", expected: "forward", category: "adversarial" },
  { transcript: "add a cost field to the usage report struct", expected: "forward", category: "adversarial" },
  { transcript: "write a function that reports memory usage", expected: "forward", category: "adversarial" },

  // --- compact_session: positives -----------------------------------------
  { transcript: "compact the session", expected: "compact_session", category: "meta-positive" },
  { transcript: "summarize the conversation so far", expected: "compact_session", category: "meta-positive" },
  {
    transcript: "the context is getting long, compact it",
    expected: "compact_session",
    category: "meta-positive",
  },
  { transcript: "can you condense our chat history", expected: "compact_session", category: "meta-positive" },
  {
    transcript: "shrink the context window, it's getting big",
    expected: "compact_session",
    category: "meta-positive",
  },

  // --- compact_session: adversarial ---------------------------------------
  { transcript: "compact this array by removing duplicates", expected: "forward", category: "adversarial" },
  { transcript: "summarize this function in a docstring", expected: "forward", category: "adversarial" },
  { transcript: "write a summary comment for this file", expected: "forward", category: "adversarial" },
  { transcript: "can you minify this JSON config", expected: "forward", category: "adversarial" },
  { transcript: "condense these three functions into one", expected: "forward", category: "adversarial" },

  // --- new_session: positives (critical — a misroute the other way is the
  // one that costs history, but getting these WRONG as forward just means
  // the user has to repeat themselves, so not marked critical) -------------
  { transcript: "start a new session", expected: "new_session", category: "meta-positive" },
  { transcript: "clear the conversation and start over", expected: "new_session", category: "meta-positive" },
  { transcript: "forget everything, fresh session", expected: "new_session", category: "meta-positive" },
  {
    transcript: "let's start fresh, forget what we talked about",
    expected: "new_session",
    category: "meta-positive",
  },
  { transcript: "reset our conversation", expected: "new_session", category: "meta-positive" },

  // --- new_session: adversarial (critical — misrouting these discards the
  // session with no undo) ---------------------------------------------------
  {
    transcript: "start a new file for the session handler",
    expected: "forward",
    category: "adversarial",
    critical: true,
  },
  { transcript: "clear the cache before running tests", expected: "forward", category: "adversarial", critical: true },
  {
    transcript: "create a new branch called session-refactor",
    expected: "forward",
    category: "adversarial",
    critical: true,
  },
  {
    transcript: "let's start a new function to handle sessions",
    expected: "forward",
    category: "adversarial",
    critical: true,
  },
  { transcript: "reset the counter variable to zero", expected: "forward", category: "adversarial", critical: true },
  {
    transcript: "forget the old implementation, rewrite it using async",
    expected: "forward",
    category: "adversarial",
    critical: true,
  },
  { transcript: "clear out the unused imports", expected: "forward", category: "adversarial", critical: true },
  {
    transcript: "start fresh with a new component for the login page",
    expected: "forward",
    category: "adversarial",
    critical: true,
  },

  // --- ordinary coding instructions, no trigger words ----------------------
  { transcript: "can you add error handling to the fetch call", expected: "forward", category: "forward-generic" },
  { transcript: "why is this test failing", expected: "forward", category: "forward-generic" },
  { transcript: "let's refactor the auth middleware", expected: "forward", category: "forward-generic" },
  { transcript: "what does this regex do", expected: "forward", category: "forward-generic" },
  { transcript: "add a docstring to this function", expected: "forward", category: "forward-generic" },
  { transcript: "run the test suite", expected: "forward", category: "forward-generic" },
  { transcript: "explain the bug on line forty two", expected: "forward", category: "forward-generic" },
  {
    transcript: "I think there's a race condition here, can you check",
    expected: "forward",
    category: "forward-generic",
  },
  { transcript: "make this function async", expected: "forward", category: "forward-generic" },
  { transcript: "what's the difference between let and const here", expected: "forward", category: "forward-generic" },

  // --- thinking out loud / short or vague, but still forward ---------------
  { transcript: "hmm, okay, let's see", expected: "forward", category: "forward-ambiguous" },
  {
    transcript: "wait, actually never mind, let's go back to the fetch function",
    expected: "forward",
    category: "forward-ambiguous",
  },
  { transcript: "okay continue", expected: "forward", category: "forward-ambiguous" },
  { transcript: "no not that, the other one", expected: "forward", category: "forward-ambiguous" },
  { transcript: "yeah that looks right, next let's handle errors", expected: "forward", category: "forward-ambiguous" },
  { transcript: "make it new", expected: "forward", category: "forward-ambiguous" },
  { transcript: "clear it", expected: "forward", category: "forward-ambiguous" },
];
