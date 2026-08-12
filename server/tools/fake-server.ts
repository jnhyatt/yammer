/**
 * The real server, with the four networked dependencies faked out.
 *
 * `server/src/ws-server.test.ts` does this inside the Node test runner. This
 * does it as a process, for a client in another language: `android`'s
 * `ServerConformanceTest` spawns it and drives the Kotlin client against it over
 * a real socket.
 *
 * That is worth a file because of what it covers that nothing else does. The
 * protocol fixture checks the *codecs* agree; this checks the two state machines
 * agree — that the frames go out in an order the server accepts, that the server
 * gets a turn's worth of audio and not a truncated one, and that a permission
 * prompt answered by voice actually settles. Those are the failures that only
 * appear when both halves run at once.
 *
 * Everything below the socket is fake, and deliberately so: real STT, a real
 * router, real OpenCode and real Kokoro would make the check depend on four
 * network services and a GPU to tell you whether a JSON field was misspelled.
 *
 * v3 added workspaces, and a connection starts in none of them — see
 * PROTOCOL.md's "Connection lifecycle". This registers exactly one, already
 * `ready` and already watching its (fake) permission stream, and treats the
 * very first utterance any connection sends as "load" into it, the same way
 * `ws-server.test.ts`'s `TestClient.enter()` does. A driver only needs to run
 * one ordinary-looking turn before the ones it actually wants to assert on.
 *
 *   node --experimental-strip-types tools/fake-server.ts [--port N]
 *
 * Prints `listening <port>` on stdout once, then serves until killed.
 */

import type { AddressInfo } from "node:net";

import type { Config } from "../src/config.ts";
import { setLogLevel } from "../src/log.ts";
import type { OpenCodeClient } from "../src/opencode/client.ts";
import type { PermissionReply, PermissionRequest, PermissionWatcher } from "../src/opencode/permissions.ts";
import { Workspace, WorkspaceRegistry } from "../src/workspace.ts";
import { startServer, type Deps } from "../src/ws-server.ts";

const TOKEN = "s3cret-token";

/** The one workspace this fake registers. A driver loads it before anything else. */
const WORKSPACE = "test";

/**
 * The transcript reports how many bytes of audio actually arrived.
 *
 * It reaches the client as an ordinary `transcript` frame, which makes the whole
 * audio path checkable from the other end: a driver that buffered 20 blocks and
 * trimmed 8 knows exactly what number to expect, and framing bugs that would
 * otherwise show up as a bad transcription months later fail here instead.
 */
const transcriptFor = (audio: Buffer) => `received ${audio.length} bytes`;

/**
 * Kokoro emits 24 kHz mono s16le; this emits a recognizable ramp of the same.
 * A client that mangles the framing gets audio that is visibly not this.
 */
function fakeSpeech(seg: number): Buffer {
  const samples = 240; // 10 ms
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE((i * 37 + seg) % 3000, i * 2);
  return pcm;
}

function main(): void {
  const portArg = process.argv.indexOf("--port");
  const port = portArg === -1 ? 0 : Number(process.argv[portArg + 1]);
  setLogLevel((process.env.YAMMER_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "error");

  /** Resolves the blocked `prompt` call once the permission is answered. */
  let settlePermission: ((reply: PermissionReply) => void) | null = null;
  let askPermission: ((request: PermissionRequest) => void) | null = null;
  let prompts = 0;

  /**
   * Whether some connection's first utterance — the "load" turn every driver
   * has to send now that a connection starts in no workspace — has been seen.
   * A single mutable flag is enough because the fixture is one server per test.
   */
  let entered = false;
  const ENTER_TRANSCRIPT = `load ${WORKSPACE}`;

  const stt = {
    // `classify` is the only caller that passes a bias prompt, which is what
    // distinguishes "transcribe this utterance" from "what did they answer".
    transcribe: async (
      audio: Buffer,
      _signal?: AbortSignal,
      options?: { prompt?: string },
    ): Promise<string> => {
      if (options?.prompt) return "approve";
      if (!entered) {
        entered = true;
        return ENTER_TRANSCRIPT;
      }
      return transcriptFor(audio);
    },
  };

  const router = {
    route: async (transcript: string) => {
      if (transcript === ENTER_TRANSCRIPT) {
        return { action: "load_workspace", workspace: WORKSPACE };
      }
      return { action: "forward", workspace: "" };
    },
  };

  const opencode = {
    createSession: async (): Promise<string> => "ses_fake",
    /**
     * The second prompt of the session asks for permission before answering,
     * so a driver gets both paths by running two forwarded turns — no side
     * channel and nothing to configure. Entering the workspace does not call
     * this, so the count is unaffected by the turn that "load" spends.
     */
    prompt: async (): Promise<string> => {
      prompts += 1;
      if (prompts !== 2) return "Done.";

      const reply = await new Promise<PermissionReply>((resolve) => {
        settlePermission = resolve;
        askPermission?.({
          id: "per_fake0001",
          sessionID: "ses_fake",
          permission: "bash",
          patterns: ["git push origin main --force"],
          metadata: { command: "git push origin main --force" },
          always: ["git push *"],
        });
      });
      return reply === "reject" ? "" : "Pushed.";
    },
    abort: async (): Promise<void> => {
      settlePermission?.("reject");
      settlePermission = null;
    },
  };

  const permissions = {
    onAsked: (handler: (request: PermissionRequest) => void) => {
      askPermission = handler;
    },
    start: (): void => {},
    stop: (): void => {},
    reply: async (_id: string, reply: PermissionReply): Promise<void> => {
      const settle = settlePermission;
      settlePermission = null;
      settle?.(reply);
    },
  };

  const tts = {
    async *synthesize(text: string) {
      // One segment per sentence, as Kokoro does.
      const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
      for (let seg = 0; seg < sentences.length; seg += 1) {
        yield { seg, text: sentences[seg] as string, pcm: fakeSpeech(seg) };
      }
    },
  };

  // The concrete classes carry private fields, so structural assignment won't
  // do. These fakes implement everything the server path touches; the cast is
  // the price of not standing up a container runtime and a real OpenCode.
  const workspace = new Workspace({
    name: WORKSPACE,
    // Deliberately not a real directory: nothing here exercises the supervisor's
    // grounded `git diff` clause. `git.test.ts` covers that against real repos.
    workDir: "/nonexistent/test",
    baseUrl: "http://127.0.0.1:0",
    opencode: opencode as unknown as OpenCodeClient,
    permissions: permissions as unknown as PermissionWatcher,
  });
  // Real deployments start watching once a workspace is `ready` — `index.ts` on
  // boot, `WorkspaceManager` on create/load. This fake has no lifecycle class
  // standing in for either, so it does the one thing they both do for a
  // workspace that is ready from the start.
  workspace.startWatching();

  const workspaces = new WorkspaceRegistry([workspace]);

  // Already registered and already `ready`, so `load` is only ever the switch.
  // The lifecycle's own failure points have their own suite.
  const manager = {
    create: async (name: string) => ({ name }),
    load: async (name: string) => ({ name }),
    delete: async (_name: string): Promise<void> => {},
  };

  const config: Config = {
    host: "127.0.0.1",
    port,
    token: TOKEN,
    stt: { baseUrl: "", apiKey: "", model: "" },
    router: { baseUrl: "", apiKey: "", model: "" },
    opencode: { agent: "yammer" },
    state: { dir: "/tmp" },
    container: { socketPath: "/nonexistent.sock" },
    workspaces: {
      image: "localhost/yammer-opencode:latest",
      root: "/tmp",
      agentFile: "/nonexistent/yammer.md",
      authFile: "/nonexistent/auth.json",
      readySeconds: 1,
      stopSeconds: 1,
    },
    supervisor: { voice: "bm_george", answerSeconds: 10, maxAttempts: 3 },
    tts: { modelId: "", dtype: "q8", voice: "af_heart", device: "cpu" },
    logLevel: "error",
    envFile: null,
  };

  const deps = { stt, router, workspaces, manager, tts } as unknown as Deps;

  const wss = startServer(config, deps);
  wss.on("listening", () => {
    process.stdout.write(`listening ${(wss.address() as AddressInfo).port}\n`);
  });
}

main();
