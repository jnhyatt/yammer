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
 * (`new_session` loses history, `delete_workspace` destroys a project's whole
 * working directory) rather than merely wrong (`report_usage` misfiring just
 * gets read back an answer to a question that wasn't asked). The eval report
 * calls these out separately from the raw accuracy number.
 *
 * The workspace commands add a second thing to get wrong: the **argument**. A
 * case with an `workspace` is checked on the extracted name as well as the
 * action, compared after the same normalisation the server applies — so
 * "Space Game" and "space game" both count as `space-game`, which is exactly
 * the claim that normalisation is what makes spoken names usable at all.
 */

export type ExpectedAction =
  | "forward"
  | "report_usage"
  | "compact_session"
  | "new_session"
  | "create_workspace"
  | "load_workspace"
  | "list_workspaces"
  | "delete_workspace";

export interface EvalCase {
  transcript: string;
  expected: ExpectedAction;
  /**
   * The workspace name the router should extract, before normalisation.
   * Undefined means "not checked"; `""` means it must extract none — which is
   * the right answer for an utterance that names no workspace, and the guard
   * against a model helpfully inventing one.
   */
  workspace?: string;
  /** Groups cases in the report; not fed to the router. */
  category:
    | "meta-positive"
    | "adversarial"
    | "forward-generic"
    | "forward-ambiguous"
    | "workspace"
    | "workspace-adversarial";
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

  // --- workspace commands: positives, with the name to extract -------------
  {
    transcript: "create a workspace called space game",
    expected: "create_workspace",
    workspace: "space game",
    category: "workspace",
  },
  {
    transcript: "make me a new workspace named parser",
    expected: "create_workspace",
    workspace: "parser",
    category: "workspace",
  },
  {
    transcript: "set up a new workspace for the android client",
    expected: "create_workspace",
    workspace: "android client",
    category: "workspace",
  },
  {
    transcript: "load space game",
    expected: "load_workspace",
    workspace: "space game",
    category: "workspace",
  },
  {
    transcript: "switch to the yammer workspace",
    expected: "load_workspace",
    workspace: "yammer",
    category: "workspace",
  },
  {
    transcript: "let's work on the parser project now",
    expected: "load_workspace",
    workspace: "parser",
    category: "workspace",
  },
  {
    // Capitalisation and hyphenation are the STT layer's guess, not the user's
    // intent — normalisation is what makes this the same workspace as "load
    // space game" above.
    transcript: "open up Space-Game please",
    expected: "load_workspace",
    workspace: "space game",
    category: "workspace",
  },
  { transcript: "what workspaces do I have", expected: "list_workspaces", workspace: "", category: "workspace" },
  { transcript: "list my workspaces", expected: "list_workspaces", workspace: "", category: "workspace" },
  { transcript: "which workspace am I in", expected: "list_workspaces", workspace: "", category: "workspace" },
  {
    transcript: "delete the space game workspace",
    expected: "delete_workspace",
    workspace: "space game",
    category: "workspace",
  },
  {
    transcript: "get rid of the old test workspace entirely",
    expected: "delete_workspace",
    workspace: "old test",
    category: "workspace",
  },
  {
    // Names nothing that could be a workspace name. Extracting one anyway is
    // the failure this case exists for: the server would then delete whatever
    // the model invented, and "this" is not a name it can be told apart from.
    transcript: "delete this workspace",
    expected: "delete_workspace",
    workspace: "",
    category: "workspace",
  },

  // --- workspace commands: adversarial ------------------------------------
  // A workspace is a whole project. Everything here is about something inside
  // one, phrased with the same verbs. The delete cases are critical for the
  // obvious reason: a misroute destroys a working directory and its
  // uncommitted work, and the supervisor prompt is the only thing between the
  // transcript and that.
  {
    transcript: "delete the old test directory",
    expected: "forward",
    category: "workspace-adversarial",
    critical: true,
  },
  {
    transcript: "remove the unused imports from this file",
    expected: "forward",
    category: "workspace-adversarial",
    critical: true,
  },
  {
    transcript: "get rid of this whole function, it's dead code",
    expected: "forward",
    category: "workspace-adversarial",
    critical: true,
  },
  {
    transcript: "delete everything in the build directory",
    expected: "forward",
    category: "workspace-adversarial",
    critical: true,
  },
  {
    transcript: "make a new directory called space game",
    expected: "forward",
    category: "workspace-adversarial",
    critical: true,
  },
  {
    transcript: "create a new module for the parser",
    expected: "forward",
    category: "workspace-adversarial",
  },
  { transcript: "load the config file", expected: "forward", category: "workspace-adversarial" },
  {
    transcript: "switch to the other branch",
    expected: "forward",
    category: "workspace-adversarial",
  },
  {
    transcript: "list the files in the source directory",
    expected: "forward",
    category: "workspace-adversarial",
  },
  {
    transcript: "clone the space game repo into this directory",
    expected: "forward",
    category: "workspace-adversarial",
  },
];
