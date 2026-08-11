/**
 * Text-to-speech via Kokoro, running in-process on the server.
 *
 * Synthesis is sentence-chunked and streamed: each sentence is emitted as soon
 * as it is synthesized, so the client starts playing after the first sentence
 * rather than after the whole response. On a multi-sentence answer that is the
 * difference between roughly a second and roughly fifteen before any audio.
 */

import { KokoroTTS, TextSplitterStream } from "kokoro-js";

import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { SPEECH_FORMAT } from "../protocol.ts";
import { floatToPcm16 } from "../wav.ts";

export class TtsError extends Error {}

type VoiceId = Parameters<KokoroTTS["stream"]>[1] extends { voice?: infer V } ? V : never;

export interface SpeechSegment {
  /** Zero-based index within this turn. */
  seg: number;
  /** The sentence, for logging. */
  text: string;
  /** Signed 16-bit PCM at SPEECH_FORMAT.rate. */
  pcm: Buffer;
}

export class TtsEngine {
  private readonly config: Config["tts"];
  private model: KokoroTTS | null = null;
  private loading: Promise<KokoroTTS> | null = null;

  constructor(config: Config["tts"]) {
    this.config = config;
  }

  /**
   * Load the model. Called at startup so the first utterance of a sitting
   * doesn't pay several seconds of cold start.
   */
  async warmUp(): Promise<void> {
    await this.load();
  }

  private load(): Promise<KokoroTTS> {
    if (this.model) return Promise.resolve(this.model);
    this.loading ??= (async () => {
      const started = Date.now();
      log.info("loading Kokoro", { model: this.config.modelId, dtype: this.config.dtype });
      const model = await KokoroTTS.from_pretrained(this.config.modelId, {
        dtype: this.config.dtype,
        // kokoro-js's .d.ts only lists wasm/webgpu/cpu, but the JS passes
        // `device` straight through to @huggingface/transformers, which does
        // support "cuda" as a Node execution provider — the type is just
        // stale, not a real constraint. See README's "GPU offload" section.
        device: this.config.device as "cpu" | "webgpu" | "wasm" | null,
      });
      this.model = model;
      log.info("Kokoro ready", { ms: Date.now() - started });
      return model;
    })();
    return this.loading;
  }

  /**
   * Synthesize `text`, yielding one segment per sentence.
   *
   * Aborting stops synthesis at the next sentence boundary — mid-sentence
   * cancellation isn't worth the complexity when sentences are short.
   *
   * `voiceOverride` selects the supervisor's voice. Kokoro takes the voice per
   * `stream()` call, so a second voice costs one config string and no extra
   * memory — the model is already loaded and shared.
   */
  async *synthesize(
    text: string,
    signal?: AbortSignal,
    voiceOverride?: string,
  ): AsyncGenerator<SpeechSegment> {
    const model = await this.load();
    const spoken = normalizeForSpeech(text);
    if (spoken === "") return;

    let seg = 0;
    try {
      // Voice is a config string; kokoro-js types it as a union of its bundled
      // voice ids. It validates the name itself and throws on an unknown one.
      const voice = (voiceOverride ?? this.config.voice) as VoiceId;

      // Drive the splitter ourselves rather than passing a plain string.
      // kokoro-js's string path builds a TextSplitterStream and pushes to it
      // but never closes it, and the splitter deliberately withholds a
      // sentence whose terminator lands at the end of the buffer in case more
      // text follows. With no close() that text never arrives, so the async
      // iterator awaits forever and synthesis hangs on essentially any input.
      // Pushing and closing explicitly flushes the tail and terminates.
      const splitter = new TextSplitterStream();
      splitter.push(spoken);
      splitter.close();

      const stream = model.stream(splitter, { voice });

      for await (const chunk of stream) {
        if (signal?.aborted) {
          log.debug("tts aborted", { seg });
          return;
        }

        const raw = chunk.audio;
        if (raw.sampling_rate !== SPEECH_FORMAT.rate) {
          // The protocol advertises SPEECH_FORMAT in hello.ok, so a model that
          // emits a different rate would desync playback silently.
          throw new TtsError(
            `Kokoro emitted ${raw.sampling_rate} Hz, protocol expects ${SPEECH_FORMAT.rate} Hz`,
          );
        }

        yield { seg, text: chunk.text, pcm: floatToPcm16(raw.audio) };
        seg += 1;
      }
    } catch (cause) {
      if (cause instanceof TtsError) throw cause;
      throw new TtsError(`synthesis failed: ${String(cause)}`);
    }
  }
}

/**
 * Light cleanup before synthesis.
 *
 * OpenCode is configured to produce TTS-appropriate output already (§5), so
 * this is a backstop for stray formatting rather than a reformatting layer —
 * it must not change wording.
 */
function normalizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")     // fenced code blocks read as noise
    .replace(/`([^`]*)`/g, "$1")          // inline code ticks
    .replace(/^\s*#{1,6}\s+/gm, "")       // heading markers
    .replace(/^\s*[-*+]\s+/gm, "")        // bullet markers
    .replace(/\*\*([^*]*)\*\*/g, "$1")    // bold
    .replace(/\s+/g, " ")
    .trim();
}
