/**
 * Turn orchestration.
 *
 * One turn is: buffer audio → transcribe → route → (forward to OpenCode | run a
 * meta-command) → speak the result. Exactly one turn runs at a time; a second
 * utterance arriving mid-turn is rejected rather than queued, so this holds a
 * single piece of turn state rather than a queue.
 *
 * Every exit path from a turn emits `turn.end`, including failures — the client
 * uses it to return to idle.
 */

import { log } from "./log.ts";
import { OpenCodeError } from "./opencode/client.ts";
import type { PermissionRequest } from "./opencode/permissions.ts";
import { SPEECH_FORMAT, type ErrorCode, type ServerMessage, type TurnOutcome } from "./protocol.ts";
import { findCommand } from "./router/commands.ts";
import { RouterError, type Router } from "./router/router.ts";
import { SttClient, SttError } from "./stt/groq.ts";
import type { PermissionContext, PermissionSupervisor } from "./supervisor/supervisor.ts";
import { TtsEngine, TtsError } from "./tts/kokoro.ts";
import type { ClientWorkspaces, WorkspaceSession } from "./workspace.ts";

/** How the orchestrator talks back to whoever owns the socket. */
export interface TurnSink {
  send(msg: ServerMessage): void;
  sendAudio(turn: number, pcm: Buffer): void;
}

interface ActiveTurn {
  id: number;
  chunks: Buffer[];
  bytes: number;
  /** Set once utterance.end arrives and the pipeline starts. */
  processing: boolean;
  abort: AbortController;
  /**
   * The conversation this turn runs in, resolved when the pipeline starts.
   *
   * Held for the life of the turn rather than looked up again, so that a
   * workspace switch cannot land halfway through one and leave the reply, the
   * permission prompts, and the abort pointing at different projects.
   */
  session: WorkspaceSession | null;
}

/** Guard against a stuck client streaming forever. 60s at 16 kHz mono s16le. */
const MAX_UTTERANCE_BYTES = 60 * 16_000 * 2;

export class TurnManager {
  private readonly sink: TurnSink;
  private readonly stt: SttClient;
  private readonly router: Router;
  private readonly client: ClientWorkspaces;
  private readonly tts: TtsEngine;
  private readonly supervisor: PermissionSupervisor;

  private active: ActiveTurn | null = null;
  private replyCount = 0;

  constructor(
    sink: TurnSink,
    stt: SttClient,
    router: Router,
    client: ClientWorkspaces,
    tts: TtsEngine,
    supervisor: PermissionSupervisor,
  ) {
    this.sink = sink;
    this.stt = stt;
    this.router = router;
    this.client = client;
    this.tts = tts;
    this.supervisor = supervisor;
  }

  /**
   * Hand a blocked tool call to the supervisor.
   *
   * Only meaningful while a turn is in flight — a permission with no turn to
   * attach to has nobody listening, so it is refused rather than left blocking
   * OpenCode forever. The workspace has already routed this to the client that
   * owns the session; what is checked here is that the session is also the one
   * this client is currently talking in, which is not the same thing once a
   * client holds conversations in several workspaces at once.
   */
  handlePermission(request: PermissionRequest, context: PermissionContext): void {
    const active = this.active;
    if (!active || !active.processing) {
      log.warn("permission asked with no turn in flight, refusing", { id: request.id });
      void this.supervisor.refuse(request, context);
      return;
    }
    if (active.session?.currentSessionId !== request.sessionID) {
      log.warn("permission asked in a session the current turn is not using, refusing", {
        id: request.id,
        session: request.sessionID,
      });
      void this.supervisor.refuse(request, context);
      return;
    }
    void this.supervisor.handle(request, active.id, active.abort.signal, context);
  }

  /** Route an answer frame, or fall through to ordinary utterance audio. */
  answerBegin(turn: number, id: string): void {
    this.supervisor.answerBegin(turn, id);
  }

  answerEnd(turn: number, id: string): void {
    this.supervisor.answerEnd(turn, id);
  }

  answerTimeout(turn: number, id: string): void {
    this.supervisor.answerTimeout(turn, id);
  }

  /** True while a turn occupies the server, from begin through turn.end. */
  get busy(): boolean {
    return this.active !== null;
  }

  beginUtterance(turn: number): void {
    if (this.active) {
      log.info("rejected utterance, turn in flight", { turn, active: this.active.id });
      this.sink.send({ t: "turn.rejected", turn, reason: "busy" });
      return;
    }
    this.active = {
      id: turn,
      chunks: [],
      bytes: 0,
      processing: false,
      abort: new AbortController(),
      session: null,
    };
    this.sink.send({ t: "turn.accepted", turn });
    log.debug("utterance started", { turn });
  }

  /**
   * Append a binary frame. Frames whose tag doesn't match the turn currently
   * accepting audio are dropped — this is the late-frame case the turn tag
   * exists for (a rejected or cancelled turn still flushing).
   */
  appendAudio(turn: number, pcm: Buffer): void {
    // An answer to a permission prompt arrives mid-turn, when the turn is
    // already `processing` and would otherwise drop the frame. The supervisor
    // gets first refusal on every frame for exactly that reason.
    if (this.supervisor.appendAudio(turn, pcm)) return;

    const active = this.active;
    if (!active || active.id !== turn || active.processing) {
      log.debug("dropped stray audio frame", { turn, bytes: pcm.length });
      return;
    }
    if (active.bytes + pcm.length > MAX_UTTERANCE_BYTES) {
      log.warn("utterance exceeded size cap, dropping frame", { turn });
      return;
    }
    active.chunks.push(pcm);
    active.bytes += pcm.length;
  }

  cancelUtterance(turn: number, reason: string | undefined): void {
    const active = this.active;
    if (!active || active.id !== turn) return;
    log.debug("utterance cancelled", { turn, reason: reason ?? "" });
    active.abort.abort();
    this.active = null;
    this.sink.send({ t: "turn.end", turn, outcome: "cancelled" });
  }

  /** End of audio. Kicks off the pipeline; does not block the socket reader. */
  endUtterance(turn: number): void {
    const active = this.active;
    if (!active || active.id !== turn || active.processing) return;
    active.processing = true;

    void this.run(active).catch((cause) => {
      // The pipeline handles its own errors; anything reaching here is a bug.
      log.error("turn pipeline threw unexpectedly", { turn, error: String(cause) });
      this.finish(turn, "error");
    });
  }

  /** Abandon any in-flight turn, e.g. because the socket dropped. */
  abandon(): void {
    // Close any open answer window first: the supervisor is blocking OpenCode
    // on a question nobody can hear now, and its own path will refuse it.
    this.supervisor.abandon();
    if (!this.active) return;
    log.info("abandoning in-flight turn", { turn: this.active.id });
    this.active.abort.abort();
    this.active = null;
  }

  private async run(turn: ActiveTurn): Promise<void> {
    const id = turn.id;
    const signal = turn.abort.signal;
    const audio = Buffer.concat(turn.chunks);

    // Resolved once, here, rather than held from construction: which project a
    // turn belongs to is a property of the client's state when it speaks.
    const session = this.client.session();
    turn.session = session;
    log.info("processing utterance", {
      turn: id,
      bytes: audio.length,
      workspace: session.workspace.name,
    });

    let transcript: string;
    try {
      this.sink.send({ t: "turn.status", turn: id, state: "transcribing" });
      transcript = await this.stt.transcribe(audio, signal);
    } catch (cause) {
      return this.fail(id, sttCode(cause), spokenSttError(cause), cause);
    }
    if (signal.aborted) return;
    this.sink.send({ t: "transcript", turn: id, text: transcript });

    let action: string;
    try {
      this.sink.send({ t: "turn.status", turn: id, state: "routing" });
      const decision = await this.router.route(
        transcript,
        { sessionId: session.currentSessionId, turnCount: this.replyCount },
        signal,
      );
      action = decision.action;
    } catch (cause) {
      return this.fail(id, "router_failed", "The router failed, so I didn't act on that.", cause);
    }
    if (signal.aborted) return;

    this.sink.send({ t: "turn.status", turn: id, state: "working" });

    let spoken: string;
    let outcome: TurnOutcome;
    if (action === "forward") {
      try {
        spoken = await session.prompt(transcript, signal);
        this.replyCount += 1;
        outcome = "forwarded";
      } catch (cause) {
        // A refusal ends the OpenCode turn with no assistant text, which
        // surfaces here as an "empty response" error. That is the expected
        // shape of a denial, not a failure — and the supervisor has already
        // said what happened, so there is nothing left to speak.
        if (this.supervisor.wasDenied(id)) {
          log.info("turn ended by a refused permission", { turn: id });
          this.supervisor.clearTurn(id);
          return this.finish(id, "denied");
        }
        console.log(cause);
        return this.fail(id, opencodeCode(cause), spokenOpencodeError(cause), cause);
      }
    } else {
      const command = findCommand(action);
      if (!command) {
        return this.fail(id, "internal", "I didn't understand that command.", action);
      }
      try {
        spoken = await command.run(session);
        outcome = "meta_command";
      } catch (cause) {
        console.log(cause);
        return this.fail(id, opencodeCode(cause), spokenOpencodeError(cause), cause);
      }
    }
    if (signal.aborted) return;

    await this.speak(id, spoken, signal);
    this.finish(id, outcome);
  }

  /** Synthesize and stream, one WebSocket segment per sentence. */
  private async speak(turn: number, text: string, signal: AbortSignal): Promise<void> {
    this.sink.send({ t: "turn.status", turn, state: "speaking" });
    try {
      for await (const segment of this.tts.synthesize(text, signal)) {
        if (signal.aborted) return;
        this.sink.send({
          t: "speech.begin",
          turn,
          seg: segment.seg,
          audio: SPEECH_FORMAT,
          voice: "agent",
        });
        this.sink.sendAudio(turn, segment.pcm);
        this.sink.send({ t: "speech.end", turn, seg: segment.seg });
      }
    } catch (cause) {
      // Nothing left to fall back on — a TTS failure can't be spoken aloud.
      log.error("tts failed", { turn, error: String(cause) });
      this.sink.send({
        t: "error",
        turn,
        code: cause instanceof TtsError ? "tts_failed" : "internal",
        message: "Speech synthesis failed.",
      });
    }
  }

  /**
   * Report a failure: the error message first (the client's error earcon fires
   * on it), then the spoken explanation, then turn.end. No retry — v1 has no
   * voice-based error recovery by design.
   */
  private async fail(
    turn: number,
    code: ErrorCode,
    spoken: string,
    cause: unknown,
  ): Promise<void> {
    log.warn("turn failed", { turn, code, error: String(cause) });
    this.sink.send({ t: "error", turn, code, message: spoken });
    const active = this.active;
    if (active && active.id === turn && !active.abort.signal.aborted) {
      await this.speak(turn, spoken, active.abort.signal);
    }
    this.finish(turn, "error");
  }

  private finish(turn: number, outcome: TurnOutcome): void {
    if (this.active?.id === turn) this.active = null;
    this.supervisor.clearTurn(turn);
    this.sink.send({ t: "turn.end", turn, outcome });
    log.info("turn complete", { turn, outcome });
  }
}

function sttCode(cause: unknown): ErrorCode {
  return cause instanceof SttError && cause.kind === "empty" ? "stt_empty" : "stt_failed";
}

function spokenSttError(cause: unknown): string {
  if (cause instanceof SttError && cause.kind === "empty") {
    return "I didn't catch that.";
  }
  return "I couldn't transcribe that.";
}

function opencodeCode(cause: unknown): ErrorCode {
  if (cause instanceof OpenCodeError) {
    return cause.kind === "unreachable" ? "opencode_unreachable" : "opencode_error";
  }
  if (cause instanceof RouterError) return "router_failed";
  return "internal";
}

function spokenOpencodeError(cause: unknown): string {
  if (cause instanceof OpenCodeError && cause.kind === "unreachable") {
    return "I couldn't reach OpenCode.";
  }
  if (cause instanceof OpenCodeError) return "OpenCode returned an error.";
  return "Something went wrong.";
}
