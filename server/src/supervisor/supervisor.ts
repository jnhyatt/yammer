/**
 * The permission supervisor: a spoken approval prompt in a second voice.
 *
 * When OpenCode blocks a tool call, this asks the user out loud, listens for a
 * one-word answer, and unblocks the call. It runs *inside* an already-active
 * turn — the client stays in its waiting state throughout, and the turn tag
 * never changes.
 *
 * Three constraints shape it:
 *
 * - **A denial ends the turn.** OpenCode does not resume the model loop after a
 *   rejected tool call; the assistant message finishes with no text at all. So
 *   the supervisor speaks the outcome itself rather than leaving it to the
 *   agent, which will never get the chance.
 * - **Silence means the user is not there.** The realistic reason nobody answers
 *   is that the headphones are out. Rejecting *and* aborting stops the agent
 *   from working unsupervised; the OpenCode session survives, so the user
 *   resumes by asking about it whenever they come back.
 * - **Every exit path resolves the request,** including failures. A path that
 *   skips `permission.resolved` strands the client in its answer window exactly
 *   as a missing `turn.end` strands it in waiting.
 */

import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { PermissionReply, PermissionRequest } from "../opencode/permissions.ts";
import { SPEECH_FORMAT, type PermissionResponse, type ServerMessage } from "../protocol.ts";
import { SttClient, SttError } from "../stt/groq.ts";
import { TtsEngine } from "../tts/kokoro.ts";
import { matchAnswer } from "./keywords.ts";
import { askQuestion, outcomeSentence, repromptQuestion } from "./speech.ts";

export interface SupervisorSink {
  send(msg: ServerMessage): void;
  sendAudio(turn: number, pcm: Buffer): void;
}

/**
 * How to act on a request, supplied per request rather than per supervisor.
 *
 * Both halves are properties of the session that raised the question, not of
 * the client being asked it: with a workspace per project there is a permission
 * stream per workspace, so "which server do I answer" has to travel with the
 * request. Phase 5 widens this into an approval-request abstraction that
 * Yammer's own destructive commands can also present.
 */
export interface PermissionContext {
  /** Answer the request, unblocking the tool call either way. */
  reply(id: string, reply: PermissionReply): Promise<void>;
  /** Stop the agent that raised it. Only the no-answer path uses this. */
  abortTurn(): Promise<void>;
}

/** Biases Whisper toward the words we actually expect. Cheap, and it works. */
const STT_BIAS = "approve. always. deny.";

/** 30s at 16 kHz mono s16le — far more than a one-word answer needs. */
const MAX_ANSWER_BYTES = 30 * 16_000 * 2;

interface PendingAnswer {
  turn: number;
  id: string;
  chunks: Buffer[];
  bytes: number;
  /** True between answer.begin and answer.end. */
  receiving: boolean;
  settle: (audio: Buffer | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionSupervisor {
  private readonly sink: SupervisorSink;
  private readonly stt: SttClient;
  private readonly tts: TtsEngine;
  private readonly config: Config["supervisor"];

  private pending: PendingAnswer | null = null;
  /** Set when a request in the current turn was refused, so the turn manager
   *  can tell an expected empty reply from a real OpenCode failure. */
  private deniedTurn: number | null = null;
  /** Why the last attempt failed, so the reprompt can say the right thing. */
  private lastMiss: "silence" | "unrecognized" = "silence";

  constructor(
    sink: SupervisorSink,
    stt: SttClient,
    tts: TtsEngine,
    config: Config["supervisor"],
  ) {
    this.sink = sink;
    this.stt = stt;
    this.tts = tts;
    this.config = config;
  }

  /** True if the given turn was ended by a refusal rather than by an error. */
  wasDenied(turn: number): boolean {
    return this.deniedTurn === turn;
  }

  clearTurn(turn: number): void {
    if (this.deniedTurn === turn) this.deniedTurn = null;
  }

  /**
   * Ask, listen, answer. Resolves once the request is settled either way; the
   * caller does not wait on this — OpenCode's blocked prompt call is what waits.
   */
  async handle(
    request: PermissionRequest,
    turn: number,
    signal: AbortSignal,
    context: PermissionContext,
  ): Promise<void> {
    log.info("supervising permission", { id: request.id, turn });

    try {
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt += 1) {
        if (signal.aborted) return await this.settle(request, turn, "reject", false, context);

        const question =
          attempt === 0
            ? askQuestion(request)
            : repromptQuestion(this.lastMiss === "silence" ? "silence" : "unrecognized");

        this.sink.send({
          t: "permission.ask",
          turn,
          id: request.id,
          question,
          attempt,
        });
        await this.speak(turn, question, signal);
        if (signal.aborted) return await this.settle(request, turn, "reject", false, context);

        const audio = await this.collectAnswer(turn, request.id);
        const match = await this.classify(audio);
        this.lastMiss = match.kind === "silence" ? "silence" : "unrecognized";

        if (match.kind === "approve") {
          return await this.settle(request, turn, "once", true, context);
        }
        if (match.kind === "always") {
          return await this.settle(request, turn, "always", true, context);
        }
        if (match.kind === "deny") {
          return await this.settle(request, turn, "reject", true, context);
        }

        log.info("answer not recognized", {
          id: request.id,
          attempt,
          kind: match.kind,
          heard: match.kind === "unrecognized" ? match.normalized : "",
        });
      }

      // Out of attempts: treat it as nobody being there.
      await this.settle(request, turn, "timeout", true, context);
    } catch (cause) {
      log.error("supervisor failed", { id: request.id, error: String(cause) });
      this.sink.send({
        t: "error",
        turn,
        code: "supervisor_failed",
        message: "The approval prompt failed, so I denied it.",
      });
      // Never leave OpenCode blocked on a prompt we can no longer drive.
      await this.settle(request, turn, "timeout", false, context).catch(() => {});
    }
  }

  /**
   * Reply to OpenCode, tell the client, and say what happened.
   *
   * `timeout` is not one of OpenCode's replies — it maps to `reject` on the wire
   * and additionally aborts the turn, which is the difference between "not that
   * one" and "I'm not here, stop".
   */
  private async settle(
    request: PermissionRequest,
    turn: number,
    response: PermissionResponse,
    speakOutcome: boolean,
    context: PermissionContext,
  ): Promise<void> {
    const reply = response === "timeout" ? "reject" : response;
    try {
      await context.reply(request.id, reply);
    } catch (cause) {
      log.error("could not answer permission", { id: request.id, error: String(cause) });
    }

    if (reply === "reject") this.deniedTurn = turn;

    if (response === "timeout") {
      try {
        await context.abortTurn();
      } catch (cause) {
        log.warn("could not abort the turn after a timeout", { error: String(cause) });
      }
    }

    this.sink.send({ t: "permission.resolved", turn, id: request.id, response });

    if (speakOutcome) {
      // No signal: this sentence is the user's only notification of the
      // outcome, so it outlives the turn's own cancellation.
      await this.speak(turn, outcomeSentence(response)).catch((cause) => {
        log.warn("could not speak the outcome", { error: String(cause) });
      });
    }
  }

  private async classify(audio: Buffer | null) {
    if (audio === null || audio.length === 0) return { kind: "silence" } as const;

    let transcript: string;
    try {
      transcript = await this.stt.transcribe(audio, undefined, { prompt: STT_BIAS });
    } catch (cause) {
      if (cause instanceof SttError && cause.kind === "empty") {
        return { kind: "silence" } as const;
      }
      log.warn("could not transcribe an answer", { error: String(cause) });
      return { kind: "unrecognized", normalized: "" } as const;
    }

    log.info("answer heard", { text: transcript });
    return matchAnswer(transcript);
  }

  // --- answer window -------------------------------------------------------

  /** The request currently awaiting an answer, if any. */
  get awaiting(): { turn: number; id: string } | null {
    return this.pending ? { turn: this.pending.turn, id: this.pending.id } : null;
  }

  private collectAnswer(turn: number, id: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.info("answer window expired", { id });
        this.finishAnswer(null);
      }, this.config.answerSeconds * 1_000);

      this.pending = {
        turn,
        id,
        chunks: [],
        bytes: 0,
        receiving: false,
        settle: resolve,
        timer,
      };
    });
  }

  private finishAnswer(audio: Buffer | null): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.settle(audio);
  }

  answerBegin(turn: number, id: string): void {
    const pending = this.pending;
    if (!pending || pending.turn !== turn || pending.id !== id) return;
    pending.receiving = true;
    pending.chunks = [];
    pending.bytes = 0;
    log.debug("answer started", { id });
  }

  /** Route an audio frame into the answer buffer. False if it isn't ours. */
  appendAudio(turn: number, pcm: Buffer): boolean {
    const pending = this.pending;
    if (!pending || pending.turn !== turn || !pending.receiving) return false;
    if (pending.bytes + pcm.length > MAX_ANSWER_BYTES) return true;
    pending.chunks.push(pcm);
    pending.bytes += pcm.length;
    return true;
  }

  answerEnd(turn: number, id: string): void {
    const pending = this.pending;
    if (!pending || pending.turn !== turn || pending.id !== id) return;
    this.finishAnswer(Buffer.concat(pending.chunks));
  }

  answerTimeout(turn: number, id: string): void {
    const pending = this.pending;
    if (!pending || pending.turn !== turn || pending.id !== id) return;
    this.finishAnswer(null);
  }

  /** The socket dropped mid-prompt. Close the window so `handle` can finish. */
  abandon(): void {
    this.finishAnswer(null);
  }

  /**
   * Refuse without asking, for a request nobody can hear — no turn in flight,
   * or no client attached. Leaving it unanswered would wedge `opencode serve`
   * holding a blocked tool call indefinitely.
   */
  async refuse(request: PermissionRequest, context: PermissionContext): Promise<void> {
    try {
      await context.reply(request.id, "reject");
    } catch (cause) {
      log.error("could not refuse an unattended permission", {
        id: request.id,
        error: String(cause),
      });
    }
  }

  // --- speech --------------------------------------------------------------

  /** Speak in the supervisor's voice, one segment per sentence as usual. */
  private async speak(turn: number, text: string, signal?: AbortSignal): Promise<void> {
    for await (const segment of this.tts.synthesize(text, signal, this.config.voice)) {
      if (signal?.aborted) return;
      this.sink.send({
        t: "speech.begin",
        turn,
        seg: segment.seg,
        audio: SPEECH_FORMAT,
        voice: "supervisor",
      });
      this.sink.sendAudio(turn, segment.pcm);
      this.sink.send({ t: "speech.end", turn, seg: segment.seg });
    }
  }
}
