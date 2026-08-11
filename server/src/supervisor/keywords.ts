/**
 * Matching a spoken answer to a permission prompt.
 *
 * Deliberately not an LLM call. The router exists because "is this a coding
 * instruction or a session command" is genuinely ambiguous; "did they say
 * approve or deny" is not, and putting a model in this path would add a second
 * failure mode plus latency at the one moment the user is actively waiting.
 *
 * The design is exact matching over a normalized transcript, and it is
 * **asymmetric on purpose**:
 *
 * - Approving is strict. Only the literal words count. Whisper's mishearings of
 *   "approve" — "a prove", "improve", "prove", "groove" — must NOT approve
 *   anything; they reprompt. A false approve force-pushes a branch.
 * - Denying is lenient, and anything negative counts. A false deny costs one
 *   retry and nothing else, so when in doubt, refuse.
 *
 * Matching is against the **whole** normalized transcript, never a substring:
 * "don't approve" contains "approve", and substring matching would approve it.
 */

/** What the user's answer resolved to. */
export type AnswerMatch =
  | { kind: "approve" }
  | { kind: "always" }
  | { kind: "deny" }
  /** Speech we heard but could not classify — reprompt. */
  | { kind: "unrecognized"; normalized: string }
  /** Silence, or one of Whisper's silence hallucinations — reprompt. */
  | { kind: "silence" };

/**
 * Whisper emits these confidently for near-silence and background noise. They
 * are not answers, and treating them as unrecognized speech would waste an
 * attempt on a user who never said anything.
 */
const HALLUCINATIONS = new Set([
  "thank you",
  "thanks",
  "thanks for watching",
  "thanks for watching!",
  "you",
  "bye",
  "goodbye",
  "okay",
  "ok",
  "oh",
  "mm",
  "hmm",
  "uh",
  "um",
]);

/** Dropped before matching so "uh, approve" still lands. */
const FILLERS = new Set(["uh", "um", "er", "ah", "eh", "like", "just", "please"]);

/**
 * Strict. Every entry here is a word that grants the action, so this set is the
 * blast radius of a mistranscription — keep it small and keep near-misses out.
 */
const APPROVE = new Set(["approve", "approved", "approve it", "approve that"]);

/** Also strict: "always" grants a whole pattern, not one command. */
const ALWAYS = new Set([
  "always",
  "always allow",
  "allow always",
  "approve always",
  "always approve",
]);

/** Lenient. Adding to this set is cheap; the failure mode is a wasted retry. */
const DENY = new Set([
  "deny",
  "denied",
  "denial",
  "the nine",
  "dini",
  "deni",
  "no",
  "nope",
  "no thanks",
  "negative",
  "reject",
  "rejected",
  "refuse",
  "cancel",
  "stop",
  "dont",
  "do not",
  "nevermind",
  "never mind",
]);

/**
 * Any of these anywhere in the answer forces a denial, before the approve sets
 * are consulted. This is what stops "don't approve" and "no, not that one" from
 * matching an affirmative.
 */
const NEGATORS = ["dont", "do not", "not", "never", "stop", "cancel", "no"];

/**
 * Lowercase, strip punctuation, collapse whitespace, drop filler words.
 *
 * Whisper returns capitalized, punctuated sentences even for one word — "Approve."
 * is the common case, not "approve" — so normalization is not optional polish.
 */
export function normalizeAnswer(text: string): string {
  const cleaned = text
    .toLowerCase()
    // Apostrophes go entirely rather than becoming spaces, so "don't" reads as
    // one token "dont" and matches the negator list.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const kept = cleaned.split(" ").filter((word) => word !== "" && !FILLERS.has(word));
  return kept.join(" ");
}

/** Classify one transcribed answer. Pure — this is the unit-testable core. */
export function matchAnswer(transcript: string): AnswerMatch {
  const raw = transcript.trim().toLowerCase().replace(/\s+/g, " ");
  if (raw === "" || HALLUCINATIONS.has(raw.replace(/[.!?]+$/, ""))) {
    return { kind: "silence" };
  }

  const normalized = normalizeAnswer(transcript);
  if (normalized === "" || HALLUCINATIONS.has(normalized)) {
    return { kind: "silence" };
  }

  // Negation first, so an affirmative buried in a refusal cannot win.
  const words = normalized.split(" ");
  if (NEGATORS.some((negator) => matchesNegator(words, normalized, negator))) {
    return { kind: "deny" };
  }

  if (ALWAYS.has(normalized)) return { kind: "always" };
  if (APPROVE.has(normalized)) return { kind: "approve" };
  if (DENY.has(normalized)) return { kind: "deny" };

  return { kind: "unrecognized", normalized };
}

/**
 * Word-boundary match. `not` must not fire on "notably", and the multi-word
 * negators ("do not") have to be checked against the joined string.
 */
function matchesNegator(words: string[], normalized: string, negator: string): boolean {
  if (negator.includes(" ")) return normalized.includes(negator);
  return words.includes(negator);
}
