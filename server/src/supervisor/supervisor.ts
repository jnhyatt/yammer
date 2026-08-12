/**
 * The supervisor: a spoken approval prompt in a second voice.
 *
 * Something wants to do something irreversible. This asks the user out loud,
 * listens for a one-word answer, and settles it. It runs *inside* an already-
 * active turn — the client stays in its waiting state throughout, and the turn
 * tag never changes.
 *
 * **It is deliberately blind to who asked.** A blocked OpenCode tool call and a
 * workspace delete Yammer is about to perform arrive here as the same
 * `ApprovalRequest` (see `approval.ts`), because from the user's side they are
 * the same event: a voice interrupting to ask permission for something that
 * cannot be taken back. Everything that differs between the two lives in the
 * adapters and in `speech.ts`.
 *
 * Three constraints shape the loop:
 *
 * - **A denial ends the turn**, for the agent-sourced half. OpenCode does not
 *   resume the model loop after a rejected tool call; the assistant message
 *   finishes with no text at all. So the supervisor speaks the outcome itself
 *   rather than leaving it to the agent, which will never get the chance.
 * - **Silence means the user is not there.** The realistic reason nobody answers
 *   is that the headphones are out. Rejecting *and* stopping the work keeps the
 *   agent from carrying on unsupervised; the OpenCode session survives, so the
 *   user resumes by asking about it whenever they come back.
 * - **Every exit path settles the request,** including failures. A path that
 *   skips `permission.resolved` strands the client in its answer window exactly
 *   as a missing `turn.end` strands it in waiting.
 */

import type { Config } from "../config.ts";
import { observeWorkingTree, stakesSentence } from "../git.ts";
import { log } from "../log.ts";
import { SPEECH_FORMAT, type PermissionResponse, type ServerMessage } from "../protocol.ts";
import { SttClient, SttError } from "../stt/groq.ts";
import { TtsEngine } from "../tts/kokoro.ts";
import type { ApprovalRequest } from "./approval.ts";
import { matchAnswer } from "./keywords.ts";
import { askQuestion, failureSentence, outcomeSentence, repromptQuestion } from "./speech.ts";

export interface SupervisorSink {
  send(msg: ServerMessage): void;
  sendAudio(turn: number, pcm: Buffer): void;
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
   * Ask, listen, settle. True if it was approved.
   *
   * The agent-sourced caller ignores the return value — OpenCode's blocked
   * prompt call is what waits, and `settle` is what unblocks it. Yammer's own
   * callers are the ones that need the boolean, because for them this *is* the
   * decision.
   */
  async approve(
    request: ApprovalRequest,
    turn: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    log.info("supervising an approval", { id: request.id, turn, source: request.source });

    try {
      // Before the first word, because it is part of the first question: what is
      // sitting in the directory this would damage. Yammer's own look at it.
      const stakes = await this.stakes(request);

      for (let attempt = 0; attempt < this.config.maxAttempts; attempt += 1) {
        if (signal.aborted) return await this.settle(request, turn, "reject", false);

        const question =
          attempt === 0
            ? askQuestion(request, stakes)
            : repromptQuestion(this.lastMiss, request.always !== null);

        this.sink.send({
          t: "permission.ask",
          turn,
          id: request.id,
          question,
          attempt,
        });
        await this.speak(turn, question, signal);
        if (signal.aborted) return await this.settle(request, turn, "reject", false);

        const audio = await this.collectAnswer(turn, request.id);
        const match = await this.classify(audio);
        this.lastMiss = match.kind === "silence" ? "silence" : "unrecognized";

        if (match.kind === "approve") {
          return await this.settle(request, turn, "once", true);
        }
        if (match.kind === "always") {
          // With nothing to widen to, "always" is just a loud yes — and it must
          // not be reported as `always`, which would claim something was
          // remembered when nothing was.
          return await this.settle(request, turn, request.always !== null ? "always" : "once", true);
        }
        if (match.kind === "deny") {
          return await this.settle(request, turn, "reject", true);
        }

        log.info("answer not recognized", {
          id: request.id,
          attempt,
          kind: match.kind,
          heard: match.kind === "unrecognized" ? match.normalized : "",
        });
      }

      // Out of attempts: treat it as nobody being there.
      return await this.settle(request, turn, "timeout", true);
    } catch (cause) {
      log.error("supervisor failed", { id: request.id, error: String(cause) });
      this.sink.send({
        t: "error",
        turn,
        code: "supervisor_failed",
        message: failureSentence(request.source),
      });
      // Anything unexplained is a no, and never a prompt left hanging: an
      // unsettled request wedges OpenCode on a blocked tool call forever.
      return await this.settle(request, turn, "timeout", false).catch(() => false);
    }
  }

  /**
   * Act on the decision, tell the client, and say what happened.
   *
   * `timeout` is not one of OpenCode's replies — the adapter maps it to a
   * rejection and additionally stops the work, which is the difference between
   * "not that one" and "I'm not here, stop".
   *
   * The sentence is awaited rather than fired off, because a Yammer-sourced
   * caller speaks again the moment this returns: two synthesis loops running at
   * once would interleave their segments, and both number theirs from zero.
   */
  private async settle(
    request: ApprovalRequest,
    turn: number,
    response: PermissionResponse,
    speakOutcome: boolean,
  ): Promise<boolean> {
    const approved = response === "once" || response === "always";
    // Recorded *before* settling, not after. Settling a refusal stops the agent,
    // which makes its blocked `prompt()` fail immediately — and the turn manager
    // reads this the moment that happens, to tell an expected empty reply from a
    // real OpenCode failure. Setting it afterwards is a race that loses about
    // half the time, and loses silently: the turn ends `error` with "OpenCode
    // returned an empty response" instead of `denied`.
    //
    // Only the agent's turn can be ended by a refusal; a refused workspace
    // delete leaves the turn perfectly healthy and still owing a sentence.
    if (!approved && request.source === "agent") this.deniedTurn = turn;

    try {
      await request.settle(response);
    } catch (cause) {
      log.error("could not settle an approval", { id: request.id, error: String(cause) });
    }

    this.sink.send({ t: "permission.resolved", turn, id: request.id, response });

    if (speakOutcome) {
      // No signal: this sentence is the user's only notification of the
      // outcome, so it outlives the turn's own cancellation.
      await this.speak(turn, outcomeSentence(request.source, response)).catch((cause) => {
        log.warn("could not speak the outcome", { error: String(cause) });
      });
    }
    return approved;
  }

  /**
   * The grounded clause, or null.
   *
   * Never fatal: a directory that cannot be read is a reason to say less, not a
   * reason to fail an approval prompt the user is waiting on.
   */
  private async stakes(request: ApprovalRequest): Promise<string | null> {
    if (!request.stakes) return null;
    try {
      const tree = await observeWorkingTree(request.stakes.directory);
      return stakesSentence(tree, request.stakes.scope);
    } catch (cause) {
      log.warn("could not observe the working tree", {
        directory: request.stakes.directory,
        error: String(cause),
      });
      return null;
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
  async refuse(request: ApprovalRequest): Promise<void> {
    try {
      await request.settle("reject");
    } catch (cause) {
      log.error("could not refuse an unattended request", {
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
