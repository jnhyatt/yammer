/**
 * Connection and turn-lifecycle conformance, against the real server.
 *
 * The companion to `protocol.test.ts`: that one checks the codecs agree with
 * the Python client, this one checks the *behaviour* PROTOCOL.md specifies —
 * handshake, close codes, busy rejection, the error path, and the invariant
 * AGENTS.md states outright: **every turn exit path emits `turn.end`**. A path
 * that skips it strands the client in its waiting state with no way back to
 * idle, and nothing about that looks like an error at the time.
 *
 * `startServer` takes its dependencies injected, so this drives the genuine
 * socket, handshake and TurnManager with fakes standing in only for the four
 * things that would otherwise need network: STT, the router, OpenCode and TTS.
 *
 *   node --test --experimental-strip-types src/ws-server.test.ts
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { before, describe, it } from "node:test";
import { WebSocket } from "ws";

import type { Config } from "./config.ts";
import { setLogLevel } from "./log.ts";
import type { PermissionRequest, PermissionWatcher } from "./opencode/permissions.ts";
import type { OpenCodeClient } from "./opencode/client.ts";
import { CloseCode, PROTOCOL_VERSION, SPEECH_FORMAT, encodeAudioFrame } from "./protocol.ts";
import { SttError } from "./stt/groq.ts";
import { Workspace, WorkspaceRegistry } from "./workspace.ts";
import { startServer, type Deps } from "./ws-server.ts";

const TOKEN = "s3cret-token";
const TIMEOUT_MS = 2_000;

before(() => setLogLevel("error"));

// --- Fakes -----------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll for something that happens server-side and sends no frame of its own. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FakeOptions {
  transcribe?: (audio: Buffer) => Promise<string>;
  /** Answers only. Separate because the supervisor's answers go through STT too. */
  transcribeAnswer?: (audio: Buffer) => Promise<string>;
  route?: () => Promise<{ action: string }>;
  prompt?: () => Promise<string>;
}

/** Records what the pipeline was actually handed, so the test can assert on it. */
interface Recorder {
  audio: Buffer[];
  prompts: string[];
  /** Permission ids answered, and with what. */
  replies: Array<{ id: string; reply: string }>;
}

/** The seam the workspace's permission stream is driven through. */
interface Harness {
  deps: Deps;
  recorder: Recorder;
  workspace: Workspace;
  /** The session id the fake OpenCode hands out, once one has been created. */
  sessionId(): string | null;
  /** Publish a `permission.asked` as OpenCode would. */
  emitPermission(request: Partial<PermissionRequest> & { sessionID: string }): void;
}

const TEST_WORKSPACE = "testproject";

function makeDeps(options: FakeOptions = {}): Harness {
  const recorder: Recorder = { audio: [], prompts: [], replies: [] };

  const stt = {
    transcribe: async (audio: Buffer, _signal?: AbortSignal, opts?: { prompt?: string }) => {
      // The supervisor passes a bias prompt; the turn pipeline does not. That
      // is the only thing distinguishing an answer from an utterance here.
      if (opts?.prompt !== undefined) {
        return options.transcribeAnswer ? options.transcribeAnswer(audio) : "approve";
      }
      recorder.audio.push(audio);
      return options.transcribe ? options.transcribe(audio) : "add a test";
    },
  };

  const router = {
    route: async () => (options.route ? options.route() : { action: "forward" }),
  };

  let sessionId: string | null = null;
  const opencode = {
    createSession: async () => {
      sessionId = "ses_test";
      return sessionId;
    },
    prompt: async (_id: string, text: string) => {
      recorder.prompts.push(text);
      return options.prompt ? options.prompt() : "Done.";
    },
    abort: async () => {},
  };

  const tts = {
    // eslint-disable-next-line require-yield
    async *synthesize(text: string) {
      yield { seg: 0, text, pcm: Buffer.from([0x01, 0x00, 0x02, 0x00]) };
    },
  };

  let asked: ((request: PermissionRequest) => void) | null = null;
  const permissions = {
    onAsked: (handler: (request: PermissionRequest) => void) => {
      asked = handler;
    },
    start: () => {},
    stop: () => {},
    reply: async (id: string, reply: string) => {
      recorder.replies.push({ id, reply });
    },
  };

  // The concrete classes carry private fields, so structural assignment won't
  // do. These fakes implement everything the server path touches; the cast is
  // the price of not standing up Groq, OpenRouter, OpenCode and Kokoro.
  const workspace = new Workspace({
    name: TEST_WORKSPACE,
    workDir: "/tmp",
    baseUrl: "http://127.0.0.1:0",
    opencode: opencode as unknown as OpenCodeClient,
    permissions: permissions as unknown as PermissionWatcher,
  });
  const workspaces = new WorkspaceRegistry([workspace], TEST_WORKSPACE);

  return {
    deps: { stt, router, workspaces, tts } as unknown as Deps,
    recorder,
    workspace,
    sessionId: () => sessionId,
    emitPermission: (request) => {
      assert.ok(asked, "workspace is not watching its permission stream");
      asked({
        id: "per_test",
        permission: "bash",
        patterns: ["rm -rf ."],
        metadata: { command: "rm -rf ." },
        always: ["rm *"],
        ...request,
      });
    },
  };
}

function testConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0, // ephemeral
    token: TOKEN,
    stt: { baseUrl: "", apiKey: "", model: "" },
    router: { baseUrl: "", apiKey: "", model: "" },
    opencode: { baseUrl: "", projectDir: "/tmp", agent: "yammer" },
    state: { dir: "/tmp" },
    container: { socketPath: "/nonexistent.sock" },
    supervisor: { voice: "bm_george", answerSeconds: 12, maxAttempts: 3 },
    tts: { modelId: "", dtype: "q8", voice: "af_heart", device: "cpu" },
    logLevel: "error",
    envFile: null,
  };
}

// --- Harness ---------------------------------------------------------------

type Frame = { binary: false; msg: Record<string, unknown> } | { binary: true; data: Buffer };

class TestClient {
  readonly socket: WebSocket;
  private readonly frames: Frame[] = [];
  private cursor = 0;
  private wake: (() => void) | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const close = deferred<{ code: number; reason: string }>();
    this.closed = close.promise;

    this.socket.on("message", (data: Buffer, isBinary: boolean) => {
      this.frames.push(
        isBinary
          ? { binary: true, data }
          : { binary: false, msg: JSON.parse(data.toString("utf8")) },
      );
      this.wake?.();
    });
    this.socket.on("close", (code, reason) =>
      close.resolve({ code, reason: reason.toString() }),
    );
    // A server-side close during the handshake surfaces as an error on some
    // platforms; the close code is what the test is actually asserting on.
    this.socket.on("error", () => {});
  }

  open(): Promise<unknown[]> {
    return once(this.socket, "open");
  }

  send(raw: string | Buffer): void {
    this.socket.send(raw);
  }

  async hello(token = TOKEN, proto = PROTOCOL_VERSION): Promise<void> {
    await this.open();
    this.send(JSON.stringify({ t: "hello", proto, token, client: "test/0" }));
  }

  /** The next control frame satisfying `match`, consuming everything before it. */
  async next(
    match: (msg: Record<string, unknown>) => boolean,
    what = "message",
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      while (this.cursor < this.frames.length) {
        const frame = this.frames[this.cursor++]!;
        if (!frame.binary && match(frame.msg)) return frame.msg;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for ${what}; saw ${JSON.stringify(
            this.frames.map((f) => (f.binary ? "«binary»" : f.msg["t"])),
          )}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 25));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  ofType(t: string): Promise<Record<string, unknown>> {
    return this.next((msg) => msg["t"] === t, t);
  }

  /** Everything seen so far, in order — for asserting on ordering. */
  seen(): string[] {
    return this.frames.map((f) => (f.binary ? "«binary»" : String(f.msg["t"])));
  }

  binaryFrames(): Buffer[] {
    return this.frames.filter((f) => f.binary).map((f) => (f as { data: Buffer }).data);
  }

  close(): void {
    this.socket.terminate();
  }
}

/** Stand up a real server on an ephemeral port for the duration of `body`. */
async function withServer(
  deps: Deps,
  body: (connect: () => TestClient) => Promise<void>,
): Promise<void> {
  const wss = startServer(testConfig(), deps);
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  const clients: TestClient[] = [];
  try {
    await body(() => {
      const client = new TestClient(port);
      clients.push(client);
      return client;
    });
  } finally {
    for (const client of clients) client.close();
    wss.close();
    await once(wss, "close");
  }
}

// --- Handshake -------------------------------------------------------------

describe("handshake", () => {
  it("answers a valid hello with hello.ok and the speech format", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      const ok = await client.ofType("hello.ok");
      assert.equal(ok["proto"], PROTOCOL_VERSION);
      assert.equal(typeof ok["server"], "string");
      // The client is required to honour this rather than assume 24 kHz, so it
      // has to actually be there.
      assert.deepEqual(ok["audio"], SPEECH_FORMAT);
    });
  });

  // The close code carries the reason; the server never replies with an error
  // message to a failed handshake.
  it("closes with 4001 on a bad token, saying nothing first", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello("wrong-token");
      const { code } = await client.closed;
      assert.equal(code, CloseCode.AUTH_FAILED);
      assert.deepEqual(client.seen(), []);
    });
  });

  it("closes with 4001 when the token is the right length but wrong", async () => {
    // Guards the constant-time compare: it short-circuits on length, so an
    // equal-length mismatch is the case that actually exercises it.
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello("S3CRET-TOKEN");
      assert.equal((await client.closed).code, CloseCode.AUTH_FAILED);
    });
  });

  it("closes with 4002 on a protocol version it does not speak", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello(TOKEN, PROTOCOL_VERSION + 1);
      assert.equal((await client.closed).code, CloseCode.UNSUPPORTED_PROTOCOL);
    });
  });

  it("closes with 4003 when the first frame is not hello", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.open();
      client.send(JSON.stringify({ t: "utterance.begin", turn: 1 }));
      assert.equal((await client.closed).code, CloseCode.PROTOCOL_VIOLATION);
    });
  });

  it("closes with 4003 on a binary frame before hello", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.open();
      client.send(encodeAudioFrame(1, Buffer.alloc(64)));
      assert.equal((await client.closed).code, CloseCode.PROTOCOL_VIOLATION);
    });
  });

  it("closes with 4003 on a second hello after authenticating", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");
      client.send(JSON.stringify({ t: "hello", proto: PROTOCOL_VERSION, token: TOKEN }));
      assert.equal((await client.closed).code, CloseCode.PROTOCOL_VIOLATION);
    });
  });

  it("closes a second client with 4004 and leaves the first alone", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const first = connect();
      await first.hello();
      await first.ofType("hello.ok");

      const second = connect();
      assert.equal((await second.closed).code, CloseCode.ALREADY_CONNECTED);

      // The incumbent is still usable, which is the whole point of rejecting
      // the newcomer rather than taking over.
      first.send(JSON.stringify({ t: "utterance.begin", turn: 1 }));
      assert.equal((await first.ofType("turn.accepted"))["turn"], 1);
    });
  });

  it("accepts a new client once the first disconnects", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const first = connect();
      await first.hello();
      await first.ofType("hello.ok");
      first.close();
      await first.closed;

      const second = connect();
      await second.hello();
      assert.equal((await second.ofType("hello.ok"))["proto"], PROTOCOL_VERSION);
    });
  });
});

// --- Turn lifecycle --------------------------------------------------------

describe("turn lifecycle", () => {
  it("runs a turn end to end and ends it with outcome forwarded", async () => {
    const { deps, recorder } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 7 }));
      assert.equal((await client.ofType("turn.accepted"))["turn"], 7);

      client.send(encodeAudioFrame(7, Buffer.from([1, 0, 2, 0])));
      client.send(encodeAudioFrame(7, Buffer.from([3, 0, 4, 0])));
      client.send(JSON.stringify({ t: "utterance.end", turn: 7 }));

      assert.equal((await client.ofType("transcript"))["text"], "add a test");
      const begin = await client.ofType("speech.begin");
      assert.equal(begin["voice"], "agent");
      assert.deepEqual(begin["audio"], SPEECH_FORMAT);
      await client.ofType("speech.end");

      const end = await client.ofType("turn.end");
      assert.equal(end["turn"], 7);
      assert.equal(end["outcome"], "forwarded");

      // Frames are concatenated in order, with the turn tags stripped.
      assert.equal(recorder.audio.length, 1);
      assert.deepEqual([...recorder.audio[0]!], [1, 0, 2, 0, 3, 0, 4, 0]);
      assert.deepEqual(recorder.prompts, ["add a test"]);

      // The client can start playback before the whole reply is synthesized,
      // so the audio has to arrive between begin and end, not after.
      const order = client.seen();
      const from = order.indexOf("speech.begin");
      assert.equal(order[from + 1], "«binary»");
      assert.equal(order[from + 2], "speech.end");
      assert.deepEqual(client.binaryFrames()[0]!.subarray(0, 4), encodeAudioFrame(7, Buffer.alloc(0)));
    });
  });

  it("rejects a concurrent utterance at begin, not at end", async () => {
    // Rejection has to land while the user is still saying the wake word,
    // rather than after they have spoken a whole sentence into the void.
    const gate = deferred<string>();
    const { deps } = makeDeps({ transcribe: () => gate.promise });

    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 1 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 1 }));
      await client.next((m) => m["t"] === "turn.status" && m["state"] === "transcribing");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 2 }));
      const rejected = await client.ofType("turn.rejected");
      assert.equal(rejected["turn"], 2);
      assert.equal(rejected["reason"], "busy");

      // The rejected turn must not have disturbed the one in flight.
      gate.resolve("add a test");
      const end = await client.ofType("turn.end");
      assert.equal(end["turn"], 1);
      assert.equal(end["outcome"], "forwarded");
    });
  });

  it("drops audio tagged with a turn it is not accepting", async () => {
    const { deps, recorder } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 3 }));
      await client.ofType("turn.accepted");

      client.send(encodeAudioFrame(3, Buffer.from([1, 0])));
      // A late frame from a rejected or cancelled turn. This is the entire
      // reason the tag exists — it must not be resolved by timing.
      client.send(encodeAudioFrame(2, Buffer.from([9, 9])));
      client.send(encodeAudioFrame(3, Buffer.from([2, 0])));
      client.send(JSON.stringify({ t: "utterance.end", turn: 3 }));

      await client.ofType("turn.end");
      assert.deepEqual([...recorder.audio[0]!], [1, 0, 2, 0]);
    });
  });

  it("ends a cancelled turn with outcome cancelled", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 4 }));
      await client.ofType("turn.accepted");
      client.send(encodeAudioFrame(4, Buffer.from([1, 0])));
      client.send(JSON.stringify({ t: "utterance.cancel", turn: 4, reason: "restart" }));

      const end = await client.ofType("turn.end");
      assert.equal(end["turn"], 4);
      assert.equal(end["outcome"], "cancelled");
    });
  });

  it("accepts a new turn after a cancel", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 5 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.cancel", turn: 5, reason: "restart" }));
      await client.ofType("turn.end");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 6 }));
      assert.equal((await client.ofType("turn.accepted"))["turn"], 6);
    });
  });
});

// --- Permission routing ----------------------------------------------------

describe("permission routing", () => {
  // OpenCode publishes permissions per *server*, not per conversation, so with
  // more than one session in flight the session id is the only thing that says
  // whose question it is. Both failures here are silent ones: a misrouted
  // request gets someone else's answer, and an unrouted one wedges `opencode
  // serve` holding a blocked tool call forever.

  it("refuses a permission for a session no client owns", async () => {
    const harness = makeDeps();
    harness.workspace.startWatching();

    await withServer(harness.deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      // Another OpenCode client's prompt, or a session whose client has gone.
      harness.emitPermission({ id: "per_stray", sessionID: "ses_somebody_else" });

      await waitFor(() => harness.recorder.replies.length > 0, "the refusal");
      assert.deepEqual(harness.recorder.replies, [{ id: "per_stray", reply: "reject" }]);
      assert.ok(
        !client.seen().includes("permission.ask"),
        "the connected client must not be asked about someone else's tool call",
      );
    });
  });

  it("asks the owning client, and tells OpenCode what it heard", async () => {
    const gate = deferred<string>();
    const harness = makeDeps({ prompt: () => gate.promise });
    harness.workspace.startWatching();

    await withServer(harness.deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 20 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 20 }));

      // The session is created on the way into the prompt, which is also when
      // its permissions start being routed here.
      await waitFor(() => harness.sessionId() !== null, "the session to be created");
      harness.emitPermission({ sessionID: harness.sessionId()! });

      const ask = await client.ofType("permission.ask");
      assert.equal(ask["turn"], 20, "the prompt belongs to the turn already in flight");
      assert.equal(ask["id"], "per_test");

      client.send(JSON.stringify({ t: "answer.begin", turn: 20, id: "per_test" }));
      client.send(encodeAudioFrame(20, Buffer.from([1, 0])));
      client.send(JSON.stringify({ t: "answer.end", turn: 20, id: "per_test" }));

      const resolved = await client.ofType("permission.resolved");
      assert.equal(resolved["response"], "once");
      assert.deepEqual(harness.recorder.replies, [{ id: "per_test", reply: "once" }]);

      // Approving lets the agent finish, so the turn ends normally.
      gate.resolve("Done.");
      assert.equal((await client.ofType("turn.end"))["outcome"], "forwarded");
    });
  });

  it("refuses a permission that arrives with no turn in flight", async () => {
    const gate = deferred<string>();
    const harness = makeDeps({ prompt: () => gate.promise });
    harness.workspace.startWatching();

    await withServer(harness.deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 21 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 21 }));
      await waitFor(() => harness.sessionId() !== null, "the session to be created");

      gate.resolve("Done.");
      await client.ofType("turn.end");

      // The session is still claimed, but there is nobody mid-turn to ask.
      harness.emitPermission({ id: "per_late", sessionID: harness.sessionId()! });
      await waitFor(() => harness.recorder.replies.length > 0, "the refusal");
      assert.deepEqual(harness.recorder.replies, [{ id: "per_late", reply: "reject" }]);
    });
  });
});

// --- Error path ------------------------------------------------------------

describe("error path", () => {
  it("sends error before the spoken explanation, then turn.end", async () => {
    // The client's error earcon fires on the `error` message, so the user knows
    // a failure is coming before the sentence explaining it arrives.
    const { deps } = makeDeps({
      transcribe: async () => {
        throw new SttError("nothing to transcribe", "empty");
      },
    });

    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");

      client.send(JSON.stringify({ t: "utterance.begin", turn: 9 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 9 }));

      const error = await client.ofType("error");
      assert.equal(error["turn"], 9);
      assert.equal(error["code"], "stt_empty");
      assert.equal(typeof error["message"], "string");

      // Errors carry a spoken form — the message is not just for a log.
      await client.ofType("speech.begin");
      const end = await client.ofType("turn.end");
      assert.equal(end["outcome"], "error");

      const order = client.seen();
      assert.ok(
        order.indexOf("error") < order.indexOf("speech.begin"),
        `error must precede the explanation, got ${JSON.stringify(order)}`,
      );
    });
  });

  it("distinguishes a failed transcription from an empty one", async () => {
    const { deps } = makeDeps({
      transcribe: async () => {
        throw new SttError("groq is down", "failed");
      },
    });
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");
      client.send(JSON.stringify({ t: "utterance.begin", turn: 10 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 10 }));
      assert.equal((await client.ofType("error"))["code"], "stt_failed");
      assert.equal((await client.ofType("turn.end"))["outcome"], "error");
    });
  });

  it("still ends the turn when the router fails", async () => {
    const { deps } = makeDeps({
      route: async () => {
        throw new Error("router exploded");
      },
    });
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");
      client.send(JSON.stringify({ t: "utterance.begin", turn: 11 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 11 }));
      assert.equal((await client.ofType("error"))["code"], "router_failed");
      assert.equal((await client.ofType("turn.end"))["outcome"], "error");
    });
  });

  it("still ends the turn when the router names a command that does not exist", async () => {
    const { deps } = makeDeps({ route: async () => ({ action: "make_coffee" }) });
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");
      client.send(JSON.stringify({ t: "utterance.begin", turn: 12 }));
      await client.ofType("turn.accepted");
      client.send(JSON.stringify({ t: "utterance.end", turn: 12 }));
      assert.equal((await client.ofType("error"))["code"], "internal");
      assert.equal((await client.ofType("turn.end"))["outcome"], "error");
    });
  });

  it("closes with 4003 on a malformed control frame mid-session", async () => {
    const { deps } = makeDeps();
    await withServer(deps, async (connect) => {
      const client = connect();
      await client.hello();
      await client.ofType("hello.ok");
      client.send("not json at all");
      assert.equal((await client.closed).code, CloseCode.PROTOCOL_VIOLATION);
    });
  });
});
