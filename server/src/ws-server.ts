/**
 * WebSocket listener: handshake, framing, and connection lifecycle.
 *
 * Deliberately dumb about what a turn means — it validates frames and hands
 * them to a TurnManager. One client at a time (§ Operating assumptions); a
 * second connection is closed with ALREADY_CONNECTED.
 */

import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { OpenCodeSession } from "./opencode/session.ts";
import {
  CloseCode,
  PROTOCOL_VERSION,
  ProtocolError,
  SPEECH_FORMAT,
  decodeAudioFrame,
  decodeClientMessage,
  encodeAudioFrame,
  encodeServerMessage,
  type ServerMessage,
} from "./protocol.ts";
import type { PermissionWatcher } from "./opencode/permissions.ts";
import { Router } from "./router/router.ts";
import { SttClient } from "./stt/groq.ts";
import { PermissionSupervisor } from "./supervisor/supervisor.ts";
import { TtsEngine } from "./tts/kokoro.ts";
import { TurnManager } from "./turn.ts";

const SERVER_ID = "yammer-server/0.1.0";

/** How long a client has to complete the handshake before being dropped. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

export interface Deps {
  stt: SttClient;
  router: Router;
  opencode: OpenCodeSession;
  tts: TtsEngine;
  permissions: PermissionWatcher;
}

export function startServer(config: Config, deps: Deps): WebSocketServer {
  const wss = new WebSocketServer({ host: config.host, port: config.port });
  let connected: WebSocket | null = null;

  wss.on("listening", () => {
    log.info("listening", { host: config.host, port: config.port });
  });

  wss.on("connection", (socket, request) => {
    const peer = request.socket.remoteAddress ?? "unknown";

    if (connected && connected.readyState === connected.OPEN) {
      log.warn("rejecting second client", { peer });
      socket.close(CloseCode.ALREADY_CONNECTED, "client already connected");
      return;
    }
    connected = socket;

    handleConnection(socket, peer, config, deps, () => {
      if (connected === socket) connected = null;
    });
  });

  wss.on("error", (error) => log.error("server error", { error: String(error) }));

  return wss;
}

function handleConnection(
  socket: WebSocket,
  peer: string,
  config: Config,
  deps: Deps,
  onClose: () => void,
): void {
  log.info("client connected", { peer });

  let authenticated = false;

  const send = (msg: ServerMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeServerMessage(msg));
  };

  const sink = {
    send,
    sendAudio: (turn: number, pcm: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(encodeAudioFrame(turn, pcm));
    },
  };

  const supervisor = new PermissionSupervisor(
    sink,
    deps.permissions,
    deps.stt,
    deps.tts,
    config.supervisor,
    () => deps.opencode.abort(),
  );

  const turns = new TurnManager(
    sink,
    deps.stt,
    deps.router,
    deps.opencode,
    deps.tts,
    supervisor,
  );

  // Permissions are published globally by OpenCode, so filter to the session
  // this server actually drives — another OpenCode client's prompts are not
  // ours to answer.
  deps.permissions.onAsked((request) => {
    if (request.sessionID !== deps.opencode.currentSessionId) {
      log.debug("ignoring permission for another session", { id: request.id });
      return;
    }
    turns.handlePermission(request);
  });

  const handshakeTimer = setTimeout(() => {
    if (!authenticated) {
      log.warn("handshake timed out", { peer });
      socket.close(CloseCode.PROTOCOL_VIOLATION, "handshake timeout");
    }
  }, HANDSHAKE_TIMEOUT_MS);

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    try {
      if (isBinary) {
        if (!authenticated) {
          throw new ProtocolError("binary frame before hello");
        }
        const frame = decodeAudioFrame(data);
        if (!frame) throw new ProtocolError("binary frame shorter than its header");
        turns.appendAudio(frame.turn, frame.pcm);
        return;
      }

      const msg = decodeClientMessage(data.toString("utf8"));

      if (!authenticated) {
        if (msg.t !== "hello") {
          throw new ProtocolError(`expected hello, got ${msg.t}`);
        }
        if (msg.proto !== PROTOCOL_VERSION) {
          log.warn("protocol version mismatch", { peer, got: msg.proto });
          socket.close(
            CloseCode.UNSUPPORTED_PROTOCOL,
            `server speaks protocol ${PROTOCOL_VERSION}`,
          );
          return;
        }
        if (!tokenMatches(msg.token, config.token)) {
          log.warn("authentication failed", { peer });
          socket.close(CloseCode.AUTH_FAILED, "bad token");
          return;
        }

        authenticated = true;
        clearTimeout(handshakeTimer);
        log.info("client authenticated", { peer, client: msg.client ?? "unknown" });
        send({
          t: "hello.ok",
          proto: PROTOCOL_VERSION,
          server: SERVER_ID,
          audio: SPEECH_FORMAT,
        });
        return;
      }

      switch (msg.t) {
        case "hello":
          throw new ProtocolError("duplicate hello");
        case "utterance.begin":
          turns.beginUtterance(msg.turn);
          return;
        case "utterance.end":
          turns.endUtterance(msg.turn);
          return;
        case "utterance.cancel":
          turns.cancelUtterance(msg.turn, msg.reason);
          return;
        case "answer.begin":
          turns.answerBegin(msg.turn, msg.id);
          return;
        case "answer.end":
          turns.answerEnd(msg.turn, msg.id);
          return;
        case "answer.timeout":
          turns.answerTimeout(msg.turn, msg.id);
          return;
      }
    } catch (cause) {
      if (cause instanceof ProtocolError) {
        log.warn("protocol violation", { peer, error: cause.message });
        socket.close(CloseCode.PROTOCOL_VIOLATION, cause.message.slice(0, 120));
        return;
      }
      log.error("error handling frame", { peer, error: String(cause) });
      send({ t: "error", code: "internal", message: "Something went wrong." });
    }
  });

  socket.on("close", (code, reason) => {
    clearTimeout(handshakeTimer);
    // Disconnection abandons the in-flight turn — there is no resumption.
    turns.abandon();
    onClose();
    log.info("client disconnected", { peer, code, reason: reason.toString() });
  });

  socket.on("error", (error) => {
    log.warn("socket error", { peer, error: String(error) });
  });
}

/** Constant-time compare so the token isn't discoverable by timing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
