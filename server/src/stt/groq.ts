/**
 * Speech-to-text via an OpenAI-compatible transcription endpoint.
 *
 * Defaults to Groq's whisper-large-v3-turbo. The endpoint shape is
 * OpenAI-compatible on purpose — switching providers is a base-URL and model
 * change in config, nothing here.
 */

import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { CAPTURE_FORMAT } from "../protocol.ts";
import { pcmDurationSeconds, pcmToWav } from "../wav.ts";

/** Below this, the buffer is silence or a clipped syllable, not an utterance. */
const MIN_UTTERANCE_SECONDS = 0.25;

export class SttError extends Error {
  readonly kind: "empty" | "failed";

  constructor(message: string, kind: "empty" | "failed") {
    super(message);
    this.kind = kind;
  }
}

export class SttClient {
  private readonly config: Config["stt"];

  constructor(config: Config["stt"]) {
    this.config = config;
  }

  /**
   * Transcribe one utterance.
   *
   * `options.prompt` biases the decoder toward an expected vocabulary. The
   * supervisor uses it for approve/always/deny: a one-word answer gives Whisper
   * almost no context to work with, and the bias measurably cuts the "a prove"
   * class of mistranscription. It is not used on ordinary utterances, where
   * biasing would distort a genuinely open-ended prompt.
   *
   * @throws SttError kind="empty" when there is nothing worth forwarding,
   *         kind="failed" when the provider errored.
   */
  async transcribe(
    pcm: Buffer,
    signal?: AbortSignal,
    options?: { prompt?: string },
  ): Promise<string> {
    const seconds = pcmDurationSeconds(pcm, CAPTURE_FORMAT);
    if (seconds < MIN_UTTERANCE_SECONDS) {
      throw new SttError(`utterance too short (${seconds.toFixed(2)}s)`, "empty");
    }

    const wav = pcmToWav(pcm, CAPTURE_FORMAT);
    const form = new FormData();
    form.set("file", new Blob([wav as unknown as Uint8Array], { type: "audio/wav" }), "utterance.wav");
    form.set("model", this.config.model);
    form.set("response_format", "json");
    // Whisper hallucinates confidently on silence; a low temperature helps.
    form.set("temperature", "0");
    if (options?.prompt) form.set("prompt", options.prompt);

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        signal: signal ?? null,
      });
    } catch (cause) {
      throw new SttError(`transcription request failed: ${String(cause)}`, "failed");
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "<unreadable>");
      throw new SttError(
        `transcription returned ${response.status}: ${detail.slice(0, 300)}`,
        "failed",
      );
    }

    let payload: { text?: unknown };
    try {
      payload = (await response.json()) as { text?: unknown };
    } catch (cause) {
      throw new SttError(`transcription response was not JSON: ${String(cause)}`, "failed");
    }

    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    log.debug("transcribed", {
      seconds: Number(seconds.toFixed(2)),
      ms: Date.now() - started,
      chars: text.length,
    });

    if (text === "") {
      throw new SttError("transcript was empty", "empty");
    }
    return text;
  }
}
