/**
 * The spoken half of the workspace commands.
 *
 * Everything here guards a failure that is silent in the ordinary sense — it
 * throws nothing, logs nothing, and passes typechecking — while being loud in
 * the only place that matters, which is a person standing in a kitchen with
 * headphones on being told the wrong thing.
 *
 * Three of those in particular:
 *
 * - **Two failure kinds collapsing into one sentence.** The kinds exist because
 *   each means a different thing to go and do; if `not-ready` and `agent-missing`
 *   read out the same way, the user looks at the wrong thing and the distinction
 *   the whole lifecycle layer maintains is worth nothing.
 * - **`load` creating on a miss.** The name arrives as a routing model's reading
 *   of a Whisper transcript. Create-on-miss turns every mishearing into a junk
 *   container, and the user finds out weeks later from disk usage.
 * - **`delete` running without a spoken yes.** The most destructive operation in
 *   the system, triggered by the least reliable input in it.
 *
 *   node --test --experimental-strip-types src/router/commands.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { LIFECYCLE_FAILURES, WorkspaceLifecycleError } from "../lifecycle.ts";
import { setLogLevel } from "../log.ts";
import { WorkspaceUnknownError, type WorkspaceStatus } from "../workspace.ts";
import {
  findCommand,
  spokenWorkspaceError,
  type CommandContext,
  type MetaCommand,
} from "./commands.ts";

before(() => setLogLevel("error"));

interface Recorded {
  /** Everything spoken before the command's own result. */
  said: string[];
  createdWith: string[];
  loaded: string[];
  deleted: string[];
  asked: string[];
  active: string;
}

interface Setup {
  argument: string;
  /** The registry the command sees. Defaults to one ready workspace. */
  workspaces?: Array<{ name: string; status: WorkspaceStatus }>;
  active?: string;
  /** What the spoken gate answers. Defaults to deny — silence is a no. */
  approve?: boolean;
  /** Thrown by whichever lifecycle verb the command reaches for. */
  fail?: Error;
}

function harness(setup: Setup): { context: CommandContext; recorded: Recorded } {
  const workspaces = setup.workspaces ?? [{ name: "space-game", status: "ready" as const }];
  const recorded: Recorded = {
    said: [],
    createdWith: [],
    loaded: [],
    deleted: [],
    asked: [],
    active: setup.active ?? "yammer",
  };
  const raise = () => {
    if (setup.fail) throw setup.fail;
  };

  const context: CommandContext = {
    session: {} as CommandContext["session"],
    registry: { list: () => workspaces },
    manager: {
      create: async (spoken) => {
        recorded.createdWith.push(spoken);
        raise();
        return { name: spoken.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
      },
      load: async (name) => {
        recorded.loaded.push(name);
        raise();
        return { name };
      },
      delete: async (name) => {
        recorded.deleted.push(name);
        raise();
      },
    },
    client: {
      get activeWorkspaceName() {
        return recorded.active;
      },
      setActive: (name) => {
        recorded.active = name;
      },
    },
    argument: setup.argument,
    say: async (text) => {
      recorded.said.push(text);
    },
    confirm: async (question) => {
      recorded.asked.push(question);
      return setup.approve === true;
    },
  };

  return { context, recorded };
}

function command(name: string): MetaCommand {
  const found = findCommand(name);
  assert.ok(found, `no command called ${name}`);
  return found;
}

/** The sentence a command failed with, or a failure if it didn't fail. */
async function spokenFailure(name: string, setup: Setup): Promise<string> {
  try {
    const spoken = await command(name).run(harness(setup).context);
    assert.fail(`${name} succeeded, saying "${spoken}"`);
  } catch (cause) {
    const sentence = spokenWorkspaceError(cause);
    assert.ok(sentence, `${name} threw something with no spoken form: ${String(cause)}`);
    return sentence;
  }
}

// --- spoken errors ---------------------------------------------------------

describe("spoken workspace errors", () => {
  it("gives every failure kind its own sentence", () => {
    const sentences = new Map<string, string>();
    for (const kind of LIFECYCLE_FAILURES) {
      const sentence = spokenWorkspaceError(
        new WorkspaceLifecycleError(kind, "space-game", "detail"),
      );
      assert.ok(sentence, `${kind} has no spoken form`);
      const clash = sentences.get(sentence);
      assert.equal(
        clash,
        undefined,
        `${kind} and ${clash} read out identically: "${sentence}"`,
      );
      sentences.set(sentence, kind);
    }
    assert.equal(sentences.size, LIFECYCLE_FAILURES.length);
  });

  it("says which workspace, in a form Kokoro can read", () => {
    const sentence = spokenWorkspaceError(new WorkspaceUnknownError("space-game"));
    assert.ok(sentence?.includes("space game"), sentence ?? "(nothing)");
    // The hyphen is Podman's, not the user's, and reads as a stumble.
    assert.ok(!sentence?.includes("space-game"));
  });

  it("distinguishes a name it could not use from no name at all", () => {
    const empty = spokenWorkspaceError(new WorkspaceLifecycleError("bad-name", "", "x"));
    const unusable = spokenWorkspaceError(new WorkspaceLifecycleError("bad-name", "???", "x"));
    assert.notEqual(empty, unusable);
    assert.match(empty!, /didn't catch/);
  });

  it("passes on anything that is not a workspace failure", () => {
    assert.equal(spokenWorkspaceError(new Error("groq is down")), null);
    assert.equal(spokenWorkspaceError("not even an error"), null);
  });
});

// --- create ----------------------------------------------------------------

describe("create_workspace", () => {
  it("creates and says how to start it", async () => {
    const { context, recorded } = harness({ argument: "Space Game", workspaces: [] });
    const spoken = await command("create_workspace").run(context);
    assert.deepEqual(recorded.createdWith, ["Space Game"]);
    assert.match(spoken, /Created space game/);
    // Created is not loaded, and the user has no screen to find that out from.
    assert.match(spoken, /load space game/);
  });

  it("refuses an utterance with no name in it", async () => {
    const sentence = await spokenFailure("create_workspace", { argument: "", workspaces: [] });
    assert.match(sentence, /didn't catch/);
  });

  it("does not create when the router heard only punctuation", async () => {
    const { context, recorded } = harness({ argument: " ... ", workspaces: [] });
    await assert.rejects(() => command("create_workspace").run(context));
    assert.deepEqual(recorded.createdWith, []);
  });

  it("says the name is taken rather than making a second one", async () => {
    const sentence = await spokenFailure("create_workspace", {
      argument: "space game",
      fail: new WorkspaceLifecycleError("name-taken", "space-game", "exists"),
    });
    assert.match(sentence, /already a workspace called space game/);
  });
});

// --- load ------------------------------------------------------------------

describe("load_workspace", () => {
  it("normalises what it heard onto the workspace that exists", async () => {
    const { context, recorded } = harness({ argument: "Space Game" });
    await command("load_workspace").run(context);
    assert.deepEqual(recorded.loaded, ["space-game"]);
  });

  it("finds a workspace whose name the transcript ran together", async () => {
    // Observed live: one utterance of "live check" came back from Whisper as
    // "LiveCheck" and the next as "live check". Both have to be one workspace,
    // or a name is only addressable by however it was heard the first time.
    for (const heard of ["SpaceGame", "space-game", "Space  game"]) {
      const { context, recorded } = harness({ argument: heard });
      await command("load_workspace").run(context);
      assert.deepEqual(recorded.loaded, ["space-game"], `"${heard}" did not resolve`);
    }
  });

  it("speaks before it waits, when there is a wait", async () => {
    const { context, recorded } = harness({
      argument: "space game",
      workspaces: [{ name: "space-game", status: "stopped" }],
    });
    const spoken = await command("load_workspace").run(context);
    // ~7s of container start, which the doc asks not to leave silent.
    assert.deepEqual(recorded.said, ["Starting up space game, one sec."]);
    assert.match(spoken, /You're in space game/);
  });

  it("says nothing extra for a workspace that is already up", async () => {
    const { context, recorded } = harness({ argument: "space game" });
    await command("load_workspace").run(context);
    assert.deepEqual(recorded.said, []);
  });

  it("moves the client only after the load succeeds", async () => {
    const { context, recorded } = harness({ argument: "space game" });
    await command("load_workspace").run(context);
    assert.equal(recorded.active, "space-game");
  });

  it("leaves the client where it was when the load fails", async () => {
    const { context, recorded } = harness({
      argument: "space game",
      fail: new WorkspaceLifecycleError("not-ready", "space-game", "no answer"),
    });
    await assert.rejects(() => command("load_workspace").run(context));
    assert.equal(recorded.active, "yammer", "a failed load must not strand the client");
  });

  it("does not create a workspace it has never heard of", async () => {
    const { context, recorded } = harness({ argument: "spice game" });
    await assert.rejects(
      () => command("load_workspace").run(context),
      (cause: unknown) => cause instanceof WorkspaceUnknownError,
    );
    assert.deepEqual(recorded.createdWith, [], "a mishearing must not become a container");
    assert.deepEqual(recorded.loaded, []);
    assert.equal(recorded.active, "yammer");
  });

  it("names the workspace it could not find", async () => {
    const sentence = await spokenFailure("load_workspace", { argument: "spice game" });
    assert.match(sentence, /don't know a workspace called spice game/);
  });
});

// --- list ------------------------------------------------------------------

describe("list_workspaces", () => {
  it("reads out each workspace, its state, and which one you are in", async () => {
    const { context } = harness({
      argument: "",
      active: "yammer",
      workspaces: [
        { name: "yammer", status: "ready" },
        { name: "space-game", status: "stopped" },
        { name: "old-test", status: "missing" },
      ],
    });
    const spoken = await command("list_workspaces").run(context);
    assert.match(spoken, /3 workspaces/);
    assert.match(spoken, /yammer, ready, where you are now/);
    assert.match(spoken, /space game, stopped/);
    assert.match(spoken, /old test, missing its container/);
  });

  it("counts one workspace in words rather than digits", async () => {
    const { context } = harness({
      argument: "",
      workspaces: [{ name: "yammer", status: "ready" }],
    });
    assert.match(await command("list_workspaces").run(context), /one workspace\./);
  });
});

// --- delete ----------------------------------------------------------------

describe("delete_workspace", () => {
  it("does nothing at all without a spoken approval", async () => {
    const { context, recorded } = harness({ argument: "space game", approve: false });
    const spoken = await command("delete_workspace").run(context);
    assert.deepEqual(recorded.deleted, [], "a denied delete must not delete");
    assert.equal(recorded.asked.length, 1);
    // The supervisor has already spoken the refusal; saying it twice is worse
    // than saying it once.
    assert.equal(spoken, "");
  });

  it("says what is about to be destroyed, and that it cannot be undone", async () => {
    const { context, recorded } = harness({ argument: "space game", approve: false });
    await command("delete_workspace").run(context);
    const question = recorded.asked[0]!;
    assert.match(question, /space game/);
    assert.match(question, /cannot be undone/);
    assert.match(question, /approve or deny/);
  });

  it("deletes once approved", async () => {
    const { context, recorded } = harness({ argument: "space game", approve: true });
    const spoken = await command("delete_workspace").run(context);
    assert.deepEqual(recorded.deleted, ["space-game"]);
    assert.match(spoken, /Deleted space game/);
  });

  it("refuses a name it does not know before asking anything", async () => {
    const { context, recorded } = harness({ argument: "spice game", approve: true });
    await assert.rejects(() => command("delete_workspace").run(context));
    assert.deepEqual(recorded.asked, [], "there is nothing to approve for a name that is not real");
    assert.deepEqual(recorded.deleted, []);
  });
});
