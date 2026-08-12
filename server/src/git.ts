/**
 * What is actually at stake in a workspace directory, observed by Yammer.
 *
 * The supervisor asks the user to approve destructive things, and "this deletes
 * the space game workspace" is not enough to consent to on its own — the answer
 * depends on whether that directory holds a week of uncommitted work or nothing
 * at all. This module is where that difference comes from.
 *
 * Two rules shape it, and both come from the requirements doc:
 *
 * - **The observation is Yammer's own, made on the host.** Working directories
 *   are host directories bind-mounted into containers precisely so that this is
 *   possible. Nothing here asks the container, or the agent, what it has done —
 *   a description handed over by the thing being supervised is not evidence.
 * - **No LLM is anywhere near it.** The approval loop is keyword-matched end to
 *   end; a summary phrased by a model would put one back in the middle of it.
 *
 * Everything here fails soft. A missing `git`, a directory that vanished, a
 * repository mid-rebase — none of them are reasons to fail an approval prompt,
 * so they produce `unknown` and the prompt simply says less.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { log } from "./log.ts";

const run = promisify(execFile);

/** Long enough for a large repository, short enough not to stall the prompt. */
const GIT_TIMEOUT_MS = 2_000;

/**
 * What a directory holds that a person would mind losing.
 *
 * `unpushed` counts commits on no remote branch. In a Yammer workspace that is
 * usually *every* commit — nothing here has a remote — which is exactly why
 * deleting one is worth a sentence.
 */
export type WorkingTree =
  | { kind: "dirty"; changed: number; untracked: number; unpushed: number }
  | { kind: "clean"; unpushed: number }
  /** Has files, but no git repository, so nothing in it is recoverable. */
  | { kind: "unversioned" }
  | { kind: "empty" }
  /** Not readable, or no usable git. Say nothing rather than guess. */
  | { kind: "unknown" };

/** How much of the directory the pending action puts at risk. */
export type StakesScope =
  /** Uncommitted work can go; commits survive. `rm -rf`, `git reset --hard`. */
  | "working-tree"
  /** The directory itself goes, history and all. Workspace `delete`. */
  | "everything";

/** Look at a directory. Never throws; never talks to the container. */
export async function observeWorkingTree(dir: string): Promise<WorkingTree> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    log.debug("could not read a workspace directory", { dir, error: String(cause) });
    return { kind: "unknown" };
  }
  if (entries.length === 0) return { kind: "empty" };

  const status = await git(dir, ["status", "--porcelain"]);
  if (!status.ok) {
    // An exit code means git ran and said no: not a repository. A spawn failure
    // means there is no git to ask, which is not the same claim at all.
    return status.failed === "exit" ? { kind: "unversioned" } : { kind: "unknown" };
  }

  const { changed, untracked } = countStatus(status.stdout);
  const unpushed = await countUnpushed(dir);
  if (changed === 0 && untracked === 0) return { kind: "clean", unpushed };
  return { kind: "dirty", changed, untracked, unpushed };
}

/** Split `git status --porcelain` into the two counts worth speaking. */
export function countStatus(porcelain: string): { changed: number; untracked: number } {
  let changed = 0;
  let untracked = 0;
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("??")) untracked += 1;
    else changed += 1;
  }
  return { changed, untracked };
}

/**
 * One spoken clause about what would be lost, or null when nothing would be.
 *
 * Silence is meaningful here: the supervisor's question is already long, and a
 * clause that says "nothing is at stake" on every clean directory would train
 * the user to stop listening to the one that says something else.
 */
export function stakesSentence(tree: WorkingTree, scope: StakesScope): string | null {
  const parts: string[] = [];

  if (tree.kind === "unversioned") {
    return scope === "everything"
      ? "It isn't a git repository, so nothing in it is recoverable."
      : "This isn't a git repository, so nothing in it is recoverable.";
  }
  if (tree.kind === "dirty") {
    if (tree.changed > 0) parts.push(`uncommitted changes in ${count(tree.changed, "file")}`);
    if (tree.untracked > 0) parts.push(`${count(tree.untracked, "untracked file")}`);
  }
  // Commits only go when the directory itself does. A reset or an `rm` inside
  // the tree leaves the history alone, so saying it there is noise.
  if (scope === "everything" && tree.kind !== "empty" && tree.kind !== "unknown") {
    const unpushed = tree.unpushed;
    if (unpushed > 0) {
      // Spoken aloud, so the verb has to agree: "1 commit that aren't on any
      // remote" is the sort of thing a person notices and a test does not.
      const verb = unpushed === 1 ? "isn't" : "aren't";
      parts.push(`${count(unpushed, "commit")} that ${verb} on any remote`);
    }
  }

  if (parts.length === 0) return null;
  return `There are ${list(parts)}.`;
}

/** Commits on no remote branch. Zero for an unborn or remote-less-and-empty repo. */
async function countUnpushed(dir: string): Promise<number> {
  // --branches --not --remotes is "everything I have that nothing upstream has".
  // With no remote at all that is the whole history, which is the point.
  const result = await git(dir, ["log", "--branches", "--not", "--remotes", "--format=%H"]);
  if (!result.ok) return 0;
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

type GitResult = { ok: true; stdout: string } | { ok: false; failed: "exit" | "spawn" };

async function git(dir: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await run("git", ["-C", dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      // The agent may be running git in this directory at the same moment;
      // taking the index lock to answer a question would be rude and can fail.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return { ok: true, stdout };
  } catch (cause) {
    log.debug("git failed", { dir, args: args.join(" "), error: String(cause) });
    const killed = (cause as { killed?: boolean }).killed === true;
    const code = (cause as { code?: unknown }).code;
    return { ok: false, failed: !killed && typeof code === "number" ? "exit" : "spawn" };
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "a", "a and b", "a, b, and c" — spoken, so the commas matter for pacing. */
function list(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}
