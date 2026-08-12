/**
 * The meta-command catalogue.
 *
 * Meta-commands are things OpenCode itself has no way to trigger. This array is
 * the only place a new one needs to be added: the router's prompt and its
 * output schema are both derived from it, and the handler lives beside the
 * description so there is no second registry to keep in sync.
 *
 * Two things are true of everything below and worth stating once:
 *
 * - **The sentences here are the interface.** There is no screen, so a command
 *   that succeeds silently has not told the user anything. Each `run` returns
 *   what gets read aloud, and each failure has its own sentence — a single
 *   "couldn't load space-game" would collapse four different fixes into one
 *   unhelpful noise.
 * - **Results are canned, not phrased by a model.** The requirements doc asks
 *   for that deliberately: these are the fast, predictable half of the system,
 *   and a second LLM call to say "workspace loaded" would make them neither.
 */

import {
  WorkspaceLifecycleError,
  sanitizeWorkspaceName,
  workspaceMatchKey,
} from "../lifecycle.ts";
import type { Stakes } from "../supervisor/approval.ts";
import { WorkspaceUnknownError, type SessionController, type WorkspaceStatus } from "../workspace.ts";

/**
 * The lifecycle verbs, as the commands need them.
 *
 * Structural rather than the concrete `WorkspaceManager` so that the spoken
 * layer can be tested without a container runtime underneath it — the same
 * reason `SessionController` exists.
 */
export interface WorkspaceLifecycle {
  create(spokenName: string): Promise<{ name: string }>;
  load(name: string): Promise<{ name: string }>;
  delete(name: string): Promise<void>;
}

/** What `list` reads out and what name resolution matches against. */
export interface WorkspaceDirectory {
  /**
   * `workDir` is the host-side path. It is here because `delete` has to be able
   * to say what is *in* the directory it is about to destroy, and that has to
   * come from Yammer looking rather than from anyone's description.
   */
  list(): ReadonlyArray<{ name: string; status: WorkspaceStatus; workDir: string }>;
}

/** The one client's active workspace. `load` is the only thing that moves it. */
export interface ActiveWorkspace {
  readonly activeWorkspaceName: string;
  setActive(name: string): void;
}

/**
 * Everything a meta-command is allowed to touch.
 *
 * Assembled per turn by the `TurnManager`, which is what makes `say` and
 * `confirm` reach the client that spoke rather than some global output.
 */
export interface CommandContext {
  /** This client's conversation in its active workspace. */
  session: SessionController;
  /** Every workspace Yammer knows about. */
  registry: WorkspaceDirectory;
  /** create / load / delete. */
  manager: WorkspaceLifecycle;
  /** Which workspace this client is in. */
  client: ActiveWorkspace;
  /**
   * The workspace name the router extracted, exactly as it heard it. Empty
   * when the utterance named none — which for the workspace commands is a
   * spoken error rather than a default.
   */
  argument: string;
  /**
   * Say something before the command has finished.
   *
   * The reason this exists: `load` takes about seven seconds against a stopped
   * container, and the requirements doc asks for spoken feedback during that
   * rather than leaving the user listening to nothing.
   */
  say(text: string): Promise<void>;
  /**
   * Spoken approve/deny gate, in the supervisor's second voice. False means
   * don't do it — including when nobody answered.
   *
   * `description` is what is about to happen, in complete sentences; the
   * supervisor adds the answer menu and, from `stakes`, a grounded clause about
   * what is in the directory at risk. Pass the stakes rather than describing
   * the contents here: the whole point is that the sentence comes from Yammer
   * looking at the host directory at the moment of asking.
   */
  confirm(description: string, stakes?: Stakes | null): Promise<boolean>;
}

export interface MetaCommand {
  /** Stable identifier. Becomes a value in the router's `action` enum. */
  readonly name: string;
  /** Shown to the router. Describe when it applies, not just what it does. */
  readonly description: string;
  /** Utterances that should route here. Used in the router prompt. */
  readonly examples: readonly string[];
  /**
   * Whether the router must also extract a workspace name for this command.
   * The router's `workspace` slot is filled only for these.
   */
  readonly takesWorkspace?: boolean;
  /** Returns the spoken result. Keep it short — this gets read aloud. */
  run(context: CommandContext): Promise<string>;
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
    async run({ session }) {
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
    async run({ session }) {
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
    async run({ session }) {
      await session.startNewSession();
      return "Started a new session.";
    },
  },

  // --- workspaces ----------------------------------------------------------

  {
    name: "create_workspace",
    description:
      "Make a new, empty workspace — a fresh project container with its own " +
      "working directory — and give it the name the user said. Applies only " +
      "to workspaces or projects as a whole, never to files, directories, " +
      "branches, or anything inside the code.",
    examples: [
      "create a workspace called space game",
      "make a new workspace for the parser project",
      "set up a workspace named yammer",
    ],
    takesWorkspace: true,
    async run(context) {
      // The manager sanitizes too; this is here so an utterance with no name in
      // it at all fails saying that, rather than "no usable characters".
      requireHeardName(context);
      const workspace = await context.manager.create(context.argument);
      const spoken = spokenName(workspace.name);
      return `Created ${spoken}. It's empty and stopped — say load ${spoken} to start it.`;
    },
  },
  {
    name: "load_workspace",
    description:
      "Switch to an existing workspace by name, starting it if it is stopped. " +
      "Applies when the user wants to work on a different project. It does " +
      "NOT apply to loading a file, a module, a config, or data.",
    examples: [
      "load space game",
      "switch to the yammer workspace",
      "let's work on the parser project now",
      "open up space game",
    ],
    takesWorkspace: true,
    async run(context) {
      const workspace = resolveWorkspace(context);
      const spoken = spokenName(workspace.name);

      // Only when there is actually a wait to cover. A workspace that is
      // already up answers in a few hundred milliseconds, and announcing a
      // start that isn't happening is worse than saying nothing.
      if (workspace.status !== "ready") {
        await context.say(`Starting up ${spoken}, one sec.`);
      }

      await context.manager.load(workspace.name);
      // Last, and only on success: a failed load must leave the client where it
      // was rather than in a workspace it cannot talk to.
      context.client.setActive(workspace.name);
      return `You're in ${spoken}.`;
    },
  },
  {
    name: "list_workspaces",
    description:
      "List the workspaces that exist and what state each is in. Applies when " +
      "the user asks what projects or workspaces they have, or which one they " +
      "are in. It does NOT apply to listing files, directories, or anything " +
      "inside a project.",
    examples: [
      "what workspaces do I have",
      "list my workspaces",
      "which project am I in",
    ],
    async run(context) {
      const workspaces = context.registry.list();
      if (workspaces.length === 0) return "You have no workspaces yet.";

      const active = context.client.activeWorkspaceName;
      const entries = workspaces.map((workspace) => {
        const where = workspace.name === active ? ", where you are now" : "";
        return `${spokenName(workspace.name)}, ${statusPhrase(workspace.status)}${where}`;
      });
      const count =
        workspaces.length === 1 ? "one workspace" : `${workspaces.length} workspaces`;
      return `You have ${count}. ${entries.join(". ")}.`;
    },
  },
  {
    name: "delete_workspace",
    description:
      "Permanently delete a whole workspace: its container and its working " +
      "directory with everything in it. Applies only to destroying an entire " +
      "project workspace by name. It NEVER applies to deleting files, " +
      "directories, branches, functions, or anything within a project.",
    examples: [
      "delete the space game workspace",
      "get rid of the parser workspace entirely",
      "remove the workspace called old test",
    ],
    takesWorkspace: true,
    async run(context) {
      const workspace = resolveWorkspace(context);
      const spoken = spokenName(workspace.name);

      // The most destructive thing in the system, reached by a routing model's
      // reading of an imperfect transcript. It does not happen without a spoken
      // yes — and silence is a no. The supervisor adds what is in there.
      const approved = await context.confirm(
        `This deletes the ${spoken} workspace and everything in its directory, ` +
          `and it cannot be undone.`,
        { directory: workspace.workDir, scope: "everything" },
      );
      // The supervisor has already said what it is doing, either way.
      if (!approved) return "";

      await context.manager.delete(workspace.name);
      return `Deleted ${spoken}.`;
    },
  },
];

export function findCommand(name: string): MetaCommand | undefined {
  return META_COMMANDS.find((command) => command.name === name);
}

/**
 * What a workspace failure sounds like. Null for anything that isn't one.
 *
 * One sentence per `LifecycleFailure`, and they are deliberately different from
 * each other: each kind means a different thing to go and do, and the whole
 * point of the kinds existing is that the user hears which. The sentences say
 * what happened and, where there is one, what would fix it.
 */
export function spokenWorkspaceError(cause: unknown): string | null {
  if (cause instanceof WorkspaceUnknownError) {
    return (
      `I don't know a workspace called ${spokenName(cause.workspace)}. ` +
      `Say list workspaces to hear what there is, or create it first.`
    );
  }
  if (!(cause instanceof WorkspaceLifecycleError)) return null;

  const spoken = spokenName(cause.workspace);
  switch (cause.kind) {
    case "bad-name":
      // The no-name-at-all case, which is a mishearing rather than a bad name.
      if (cause.workspace.trim() === "") return "I didn't catch which workspace you meant.";
      return `I couldn't make a workspace name out of ${spoken}.`;
    case "name-taken":
      return `There's already a workspace called ${spoken}.`;
    case "image-missing":
      return "The workspace image isn't built yet, so I can't make a container. Build it first.";
    case "agent-file-missing":
      return "I can't find the agent definition, so a new workspace would have no agent in it.";
    case "container-gone":
      return `${spoken}'s container is gone. It's still in my registry, but there's nothing left to start.`;
    case "start-failed":
      return `${spoken}'s container wouldn't start.`;
    case "port-drift":
      return `${spoken} is answering on a different port than I recorded, so I won't talk to it. It needs recreating.`;
    case "not-ready":
      return `I started ${spoken}, but OpenCode inside it never answered.`;
    case "agent-missing":
      return `${spoken} is running, but OpenCode in there doesn't know the agent, so its replies would be unlistenable.`;
    case "not-deletable":
      return `${spoken} isn't a workspace I made, so I won't touch it.`;
  }
}

/**
 * The name the user said, as a workspace name — or a failure that says so.
 *
 * Sanitizing is what makes a spoken name usable as a container name at all;
 * `workspaceMatchKey` is what makes it findable again afterwards. Speech has no
 * spelling, so "Space Game", "space game" and "SpaceGame" have to land on one
 * workspace or the user ends up with three.
 */
function requireHeardName(context: CommandContext): string {
  const name = sanitizeWorkspaceName(context.argument);
  if (name === "") {
    throw new WorkspaceLifecycleError(
      "bad-name",
      context.argument.trim(),
      `no workspace name in "${context.argument}"`,
    );
  }
  return name;
}

/**
 * Resolve a heard name to a workspace that exists.
 *
 * A miss is an error, never the nearest candidate and never a new workspace:
 * the name arrives as a routing model's reading of a Whisper transcript, so a
 * name that does not resolve is at least as likely to be a mishearing as an
 * intention, and guessing means deleting or filling the wrong project.
 */
function resolveWorkspace(
  context: CommandContext,
): { name: string; status: WorkspaceStatus; workDir: string } {
  const name = requireHeardName(context);
  const key = workspaceMatchKey(name);
  const workspace = context.registry
    .list()
    .find((candidate) => workspaceMatchKey(candidate.name) === key);
  if (!workspace) throw new WorkspaceUnknownError(name);
  return workspace;
}

/**
 * Workspace names are hyphenated for Podman's sake; nobody says the hyphen.
 * Kokoro reads "space-game" as one word with a stumble in the middle.
 */
function spokenName(name: string): string {
  return name.replace(/-/g, " ");
}

function statusPhrase(status: WorkspaceStatus): string {
  switch (status) {
    case "ready":
      return "ready";
    case "starting":
      return "starting up";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed to start";
    case "missing":
      return "missing its container";
  }
}

function round(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
