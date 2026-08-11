/**
 * Cross-language protocol conformance.
 *
 * AGENTS.md is blunt about the bug this guards: `protocol/PROTOCOL.md`,
 * `server/src/protocol.ts` and `client/.../protocol.py` are three views of one
 * contract, and a mismatch between the implementations does not show up as a
 * type error. Nothing checked them against each other.
 *
 * So the frames here are not written by hand. They are dumped from the *real*
 * Python client module by `client/tools/dump_protocol_frames.py` and decoded by
 * the *real* server decoder. A test that builds its own JSON and then parses it
 * proves only that JSON round-trips.
 *
 * Regenerate the fixture after any protocol change:
 *
 *   cd client && .venv/bin/python tools/dump_protocol_frames.py
 *
 * A diff there is the signal to change all three (four, once `Protocol.kt`
 * exists) together.
 *
 *   node --test --experimental-strip-types src/protocol.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CAPTURE_FORMAT,
  CloseCode,
  PROTOCOL_VERSION,
  ProtocolError,
  SPEECH_FORMAT,
  decodeAudioFrame,
  decodeClientMessage,
  encodeAudioFrame,
} from "./protocol.ts";

interface Fixture {
  constants: {
    protocolVersion: number;
    clientId: string;
    captureFormat: { codec: string; rate: number; channels: number };
    defaultSpeechFormat: { codec: string; rate: number; channels: number };
    closeCodes: Record<string, number>;
  };
  controlFrames: Record<string, string>;
  audioFrames: { turn: number; pcmHex: string; frameHex: string }[];
  rejected: { why: string; raw: string }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "fixtures", "protocol", "client-frames.json"),
    "utf8",
  ),
);

describe("constants agree with the Python client", () => {
  it("speaks the same protocol version", () => {
    assert.equal(fixture.constants.protocolVersion, PROTOCOL_VERSION);
  });

  it("agrees on every close code", () => {
    assert.deepEqual(fixture.constants.closeCodes, {
      AUTH_FAILED: CloseCode.AUTH_FAILED,
      UNSUPPORTED_PROTOCOL: CloseCode.UNSUPPORTED_PROTOCOL,
      PROTOCOL_VIOLATION: CloseCode.PROTOCOL_VIOLATION,
      ALREADY_CONNECTED: CloseCode.ALREADY_CONNECTED,
    });
  });

  it("agrees on the capture format", () => {
    assert.deepEqual(fixture.constants.captureFormat, CAPTURE_FORMAT);
  });

  // The client treats this as a fallback only — the real rate arrives in
  // hello.ok and must be honoured — but the two defaults drifting apart would
  // still mean a client that plays at the wrong speed if hello.ok were ever
  // missing the field.
  it("agrees on the default speech format", () => {
    assert.deepEqual(fixture.constants.defaultSpeechFormat, SPEECH_FORMAT);
  });
});

describe("the server decodes what the client actually sends", () => {
  it("decodes hello, carrying the client's declared capture format", () => {
    const msg = decodeClientMessage(fixture.controlFrames["hello"]!);
    assert.equal(msg.t, "hello");
    if (msg.t !== "hello") return;
    assert.equal(msg.proto, PROTOCOL_VERSION);
    assert.equal(msg.token, "s3cret-token");
    assert.equal(msg.client, fixture.constants.clientId);
    assert.deepEqual(msg.audio, CAPTURE_FORMAT);
  });

  it("decodes the utterance bracket", () => {
    assert.deepEqual(decodeClientMessage(fixture.controlFrames["utterance.begin"]!), {
      t: "utterance.begin",
      turn: 7,
    });
    assert.deepEqual(decodeClientMessage(fixture.controlFrames["utterance.end"]!), {
      t: "utterance.end",
      turn: 7,
    });
  });

  it("decodes a cancel with its reason", () => {
    assert.deepEqual(decodeClientMessage(fixture.controlFrames["utterance.cancel"]!), {
      t: "utterance.cancel",
      turn: 7,
      reason: "restart",
    });
  });

  // An answer happens *inside* a turn, so every one of these carries both the
  // turn it belongs to and the permission request it answers.
  for (const t of ["answer.begin", "answer.end", "answer.timeout"] as const) {
    it(`decodes ${t} with both its turn and its request id`, () => {
      assert.deepEqual(decodeClientMessage(fixture.controlFrames[t]!), {
        t,
        turn: 7,
        id: "per_ff18c0de",
      });
    });
  }
});

describe("malformed frames are refused, not tolerated", () => {
  for (const { why, raw } of fixture.rejected) {
    it(`rejects a frame that is ${why}`, () => {
      assert.throws(() => decodeClientMessage(raw), ProtocolError);
    });
  }
});

describe("binary framing", () => {
  for (const frame of fixture.audioFrames) {
    it(`decodes the client's frame for turn ${frame.turn}`, () => {
      const decoded = decodeAudioFrame(Buffer.from(frame.frameHex, "hex"));
      assert.ok(decoded, "frame should not be too short to carry a header");
      assert.equal(decoded.turn, frame.turn);
      assert.equal(decoded.pcm.toString("hex"), frame.pcmHex);
    });

    it(`encodes turn ${frame.turn} the same way the client does`, () => {
      const encoded = encodeAudioFrame(frame.turn, Buffer.from(frame.pcmHex, "hex"));
      assert.equal(encoded.toString("hex"), frame.frameHex);
    });
  }

  // PROTOCOL.md says the tag wraps at 2^32. The fixture covers 4294967295 above;
  // this pins what happens on the far side of the wrap, where a signed-int bug
  // in any of the implementations would surface.
  it("wraps the turn tag rather than going negative", () => {
    const wrapped = encodeAudioFrame(4_294_967_296, Buffer.alloc(0));
    assert.equal(decodeAudioFrame(wrapped)?.turn, 0);
  });

  it("reports a frame too short to carry a header rather than guessing", () => {
    assert.equal(decodeAudioFrame(Buffer.from([1, 2, 3])), null);
  });

  it("accepts an empty payload as a valid frame", () => {
    const decoded = decodeAudioFrame(Buffer.from("00000000", "hex"));
    assert.equal(decoded?.pcm.length, 0);
  });
});
