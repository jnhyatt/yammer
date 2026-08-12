/**
 * Wire protocol types and codecs.
 *
 * Mirrors protocol/PROTOCOL.md and client/src/yammer_client/protocol.py.
 * All three change together — this is a cross-language contract, not a shared
 * type definition.
 */

export const PROTOCOL_VERSION = 3;

/**
 * Application-specific WebSocket close codes.
 *
 * `4004 ALREADY_CONNECTED` was retired in v3. Several clients may connect at
 * once, each with its own active workspace and its own turn — the number is
 * left unused rather than recycled, so an old client meeting a new server gets
 * a version mismatch rather than a close code that has changed meaning.
 */
export const CloseCode = {
  AUTH_FAILED: 4001,
  UNSUPPORTED_PROTOCOL: 4002,
  PROTOCOL_VIOLATION: 4003,
} as const;

export interface AudioFormat {
  codec: "pcm_s16le";
  rate: number;
  channels: number;
}

export const CAPTURE_FORMAT: AudioFormat = {
  codec: "pcm_s16le",
  rate: 16_000,
  channels: 1,
};

/** Kokoro's native output rate. Declared to the client in `hello.ok`. */
export const SPEECH_FORMAT: AudioFormat = {
  codec: "pcm_s16le",
  rate: 24_000,
  channels: 1,
};

export type TurnStatus = "transcribing" | "routing" | "working" | "speaking";

export type TurnOutcome =
  | "forwarded"
  | "meta_command"
  | "error"
  | "cancelled"
  /** A tool call was refused at the supervisor prompt, which ends the turn. */
  | "denied";

/**
 * Which voice a speech segment is in.
 *
 * The client uses this to decide whether the segment is interruptible: the
 * supervisor can be talked over, the agent cannot. Two voices is also the only
 * cue distinguishing "the agent is answering you" from "something is asking
 * your permission", so it is protocol, not presentation.
 */
export type SpeechVoice = "agent" | "supervisor";

/**
 * How a permission request ended. The first three mirror OpenCode's own reply
 * vocabulary; `timeout` is ours, and means nobody answered.
 */
export type PermissionResponse = "once" | "always" | "reject" | "timeout";

/**
 * The three workspace codes split by what the user would do about it, not by
 * which function threw: an unknown name is something they said, a failed start
 * is something to go and look at, and the rest is a setup problem. The spoken
 * sentence is finer-grained than this — there is one per `LifecycleFailure` —
 * because the code exists for the client's earcon and the log, and the
 * sentence exists for the person.
 */
export type ErrorCode =
  | "stt_failed"
  | "stt_empty"
  | "router_failed"
  | "opencode_unreachable"
  | "opencode_error"
  | "tts_failed"
  | "supervisor_failed"
  /** The client is not in a workspace and said something that needs one. */
  | "no_workspace"
  /** No workspace of that name. Never an implicit create. */
  | "workspace_unknown"
  /** It exists, and it did not come up: container, port, or OpenCode itself. */
  | "workspace_start_failed"
  /** Anything else about a workspace command — a name clash, a missing image. */
  | "workspace_failed"
  | "internal";

// --- Client → Server -------------------------------------------------------

export interface HelloMsg {
  t: "hello";
  proto: number;
  token: string;
  client?: string;
  audio?: AudioFormat;
}

export interface UtteranceBeginMsg {
  t: "utterance.begin";
  turn: number;
}

export interface UtteranceEndMsg {
  t: "utterance.end";
  turn: number;
}

export interface UtteranceCancelMsg {
  t: "utterance.cancel";
  turn: number;
  reason?: string;
}

/**
 * The user has started answering a permission prompt. Audio frames follow,
 * tagged with the same turn as any other audio — an answer happens *inside* a
 * turn, so it needs no tag of its own, only the request it answers.
 */
export interface AnswerBeginMsg {
  t: "answer.begin";
  turn: number;
  id: string;
}

export interface AnswerEndMsg {
  t: "answer.end";
  turn: number;
  id: string;
}

/** The answer window closed with no speech in it at all. */
export interface AnswerTimeoutMsg {
  t: "answer.timeout";
  turn: number;
  id: string;
}

export type ClientMessage =
  | HelloMsg
  | UtteranceBeginMsg
  | UtteranceEndMsg
  | UtteranceCancelMsg
  | AnswerBeginMsg
  | AnswerEndMsg
  | AnswerTimeoutMsg;

// --- Server → Client -------------------------------------------------------

export type ServerMessage =
  | { t: "hello.ok"; proto: number; server: string; audio: AudioFormat }
  | { t: "turn.accepted"; turn: number }
  | { t: "turn.rejected"; turn: number; reason: string }
  | { t: "turn.status"; turn: number; state: TurnStatus }
  | { t: "transcript"; turn: number; text: string }
  | { t: "speech.begin"; turn: number; seg: number; audio: AudioFormat; voice: SpeechVoice }
  | { t: "speech.end"; turn: number; seg: number }
  /**
   * A tool call is blocked pending the user's spoken answer. The client opens
   * an answer window on this; `question` is what the supervisor is saying, sent
   * for the log rather than for the client to render.
   */
  | { t: "permission.ask"; turn: number; id: string; question: string; attempt: number }
  | {
      t: "permission.resolved";
      turn: number;
      id: string;
      response: PermissionResponse;
    }
  | { t: "error"; turn?: number; code: ErrorCode; message: string }
  | { t: "turn.end"; turn: number; outcome: TurnOutcome };

// --- Codecs ----------------------------------------------------------------

export class ProtocolError extends Error {}

/**
 * Parse and minimally validate an inbound control frame. Throws ProtocolError
 * on anything malformed — the caller closes with PROTOCOL_VIOLATION.
 */
export function decodeClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("control frame is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ProtocolError("control frame is not an object");
  }

  const msg = parsed as Record<string, unknown>;
  const t = msg["t"];

  switch (t) {
    case "hello": {
      if (typeof msg["proto"] !== "number") {
        throw new ProtocolError("hello.proto must be a number");
      }
      if (typeof msg["token"] !== "string") {
        throw new ProtocolError("hello.token must be a string");
      }
      return {
        t: "hello",
        proto: msg["proto"],
        token: msg["token"],
        client: typeof msg["client"] === "string" ? msg["client"] : undefined,
        audio: msg["audio"] as AudioFormat | undefined,
      };
    }
    case "utterance.begin":
    case "utterance.end":
    case "utterance.cancel": {
      const turn = msg["turn"];
      if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) {
        throw new ProtocolError(`${t}.turn must be a non-negative integer`);
      }
      if (t === "utterance.cancel") {
        return {
          t,
          turn,
          reason: typeof msg["reason"] === "string" ? msg["reason"] : undefined,
        };
      }
      return { t, turn };
    }
    case "answer.begin":
    case "answer.end":
    case "answer.timeout": {
      const turn = msg["turn"];
      if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) {
        throw new ProtocolError(`${t}.turn must be a non-negative integer`);
      }
      const id = msg["id"];
      if (typeof id !== "string" || id === "") {
        throw new ProtocolError(`${t}.id must be a non-empty string`);
      }
      return { t, turn, id };
    }
    default:
      throw new ProtocolError(`unknown control message type: ${String(t)}`);
  }
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Split a binary frame into its turn tag and PCM payload.
 *
 * Returns null if the frame is too short to carry a header — treated as a
 * protocol violation by the caller rather than silently ignored.
 */
export function decodeAudioFrame(
  data: Buffer,
): { turn: number; pcm: Buffer } | null {
  if (data.length < 4) return null;
  return { turn: data.readUInt32LE(0), pcm: data.subarray(4) };
}

/** Prefix PCM with its 4-byte little-endian turn tag. */
export function encodeAudioFrame(turn: number, pcm: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(turn >>> 0, 0);
  return Buffer.concat([header, pcm]);
}
