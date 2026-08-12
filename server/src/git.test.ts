/**
 * What Yammer says is in a directory, against directories that really are.
 *
 * This is one of the few places where faking the dependency would defeat the
 * point. The claim being tested is "the sentence the user hears matches the
 * state of the disk" — a fake `git` would only prove that this module agrees
 * with my memory of porcelain output, which is exactly the thing that would be
 * wrong. So these run real git in real temporary repositories.
 *
 * The failure this guards is quiet and serious: an approval prompt that says
 * nothing is at stake while a week of uncommitted work sits in the directory,
 * or the reverse, which trains the user to approve without listening.
 *
 *   node --test --experimental-strip-types src/git.test.ts
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

import { countStatus, observeWorkingTree, stakesSentence } from "./git.ts";
import { setLogLevel } from "./log.ts";

const run = promisify(execFile);

const roots: string[] = [];

before(() => setLogLevel("error"));
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A throwaway directory, cleaned up at the end of the file. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yammer-git-"));
  roots.push(root);
  return root;
}

/** A repository with no host git config leaking into it. */
async function repo(): Promise<string> {
  const dir = await scratch();
  await git(dir, ["init", "-b", "main"]);
  return dir;
}

async function git(dir: string, args: string[]): Promise<void> {
  await run("git", ["-C", dir, ...args], {
    env: {
      ...process.env,
      // The host's ~/.gitconfig can sign commits, require a different default
      // branch, or set hooks. None of that belongs in these fixtures.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Yammer Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Yammer Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

async function file(dir: string, name: string, body = "x"): Promise<void> {
  await writeFile(join(dir, name), body);
}

// --- looking ---------------------------------------------------------------

describe("observeWorkingTree", () => {
  it("calls an empty directory empty", async () => {
    assert.deepEqual(await observeWorkingTree(await scratch()), { kind: "empty" });
  });

  it("says unknown for a directory that isn't there", async () => {
    // The workspace was deleted underneath us, or the mount is gone. Saying
    // nothing is right; saying "nothing in it is recoverable" would be a guess.
    assert.deepEqual(await observeWorkingTree("/nonexistent/yammer-test"), { kind: "unknown" });
  });

  it("calls a directory with files and no repository unversioned", async () => {
    const dir = await scratch();
    await file(dir, "notes.txt");
    assert.deepEqual(await observeWorkingTree(dir), { kind: "unversioned" });
  });

  it("counts modified and untracked files apart", async () => {
    const dir = await repo();
    await file(dir, "committed.txt");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "first"]);
    await file(dir, "committed.txt", "changed");
    await file(dir, "new.txt");
    await file(dir, "another.txt");

    const tree = await observeWorkingTree(dir);
    assert.equal(tree.kind, "dirty");
    assert.deepEqual(
      { changed: tree.changed, untracked: tree.untracked },
      { changed: 1, untracked: 2 },
    );
  });

  it("counts a staged file as changed, not untracked", async () => {
    const dir = await repo();
    await file(dir, "staged.txt");
    await git(dir, ["add", "."]);
    const tree = await observeWorkingTree(dir);
    assert.equal(tree.kind, "dirty");
    assert.equal(tree.untracked, 0);
    assert.equal(tree.changed, 1);
  });

  it("counts every commit as unpushed when there is no remote", async () => {
    // The normal state of a Yammer workspace, and the reason deleting one is
    // worth a sentence: nothing in it exists anywhere else.
    const dir = await repo();
    await file(dir, "a.txt");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "one"]);
    await file(dir, "b.txt");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "two"]);

    assert.deepEqual(await observeWorkingTree(dir), { kind: "clean", unpushed: 2 });
  });

  it("survives a repository with no commits at all", async () => {
    const dir = await repo();
    await file(dir, "first.txt");
    // `git log` fails outright on an unborn HEAD; that must read as zero
    // commits rather than as a broken observation.
    const tree = await observeWorkingTree(dir);
    assert.equal(tree.kind, "dirty");
    assert.equal(tree.unpushed, 0);
  });
});

describe("countStatus", () => {
  it("ignores blank lines and counts renames as one change", () => {
    assert.deepEqual(countStatus(" M a.txt\nR  old.txt -> new.txt\n?? b.txt\n\n"), {
      changed: 2,
      untracked: 1,
    });
  });

  it("counts nothing in empty output", () => {
    assert.deepEqual(countStatus(""), { changed: 0, untracked: 0 });
  });
});

// --- saying ----------------------------------------------------------------

describe("stakesSentence", () => {
  it("says nothing when nothing is at stake", () => {
    assert.equal(stakesSentence({ kind: "empty" }, "everything"), null);
    assert.equal(stakesSentence({ kind: "unknown" }, "everything"), null);
    assert.equal(stakesSentence({ kind: "clean", unpushed: 0 }, "everything"), null);
  });

  it("mentions unpushed commits only when the directory itself is going", () => {
    const clean = { kind: "clean", unpushed: 4 } as const;
    assert.match(stakesSentence(clean, "everything")!, /4 commits that aren't on any remote/);
    // A reset or an rm inside the tree leaves the history alone.
    assert.equal(stakesSentence(clean, "working-tree"), null);
  });

  it("reads a dirty tree as one sentence", () => {
    const sentence = stakesSentence(
      { kind: "dirty", changed: 3, untracked: 2, unpushed: 7 },
      "everything",
    )!;
    assert.equal(
      sentence,
      "There are uncommitted changes in 3 files, 2 untracked files, and 7 commits that aren't on any remote.",
    );
  });

  it("keeps the singular singular", () => {
    const sentence = stakesSentence(
      { kind: "dirty", changed: 1, untracked: 0, unpushed: 1 },
      "everything",
    )!;
    // Spoken, so the verb agrees with the count too.
    assert.equal(
      sentence,
      "There are uncommitted changes in 1 file and 1 commit that isn't on any remote.",
    );
  });

  it("warns that an unversioned directory has no history to fall back on", () => {
    assert.match(stakesSentence({ kind: "unversioned" }, "everything")!, /isn't a git repository/);
    assert.match(stakesSentence({ kind: "unversioned" }, "working-tree")!, /nothing in it is recoverable/);
  });

  it("says only what a working-tree action can destroy", () => {
    const sentence = stakesSentence(
      { kind: "dirty", changed: 2, untracked: 0, unpushed: 9 },
      "working-tree",
    )!;
    assert.equal(sentence, "There are uncommitted changes in 2 files.");
  });
});
