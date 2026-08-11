/**
 * Minimal RIFF/WAVE muxing.
 *
 * The client sends raw PCM (protocol/PROTOCOL.md), but OpenAI-compatible
 * transcription endpoints want a container. This wraps the buffer rather than
 * shelling out to ffmpeg for what is a 44-byte header.
 */

import type { AudioFormat } from "./protocol.ts";

const BITS_PER_SAMPLE = 16;

export function pcmToWav(pcm: Buffer, format: AudioFormat): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const blockAlign = format.channels * bytesPerSample;
  const byteRate = format.rate * blockAlign;

  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4); // chunk size = header tail + data
  header.write("WAVE", 8, "ascii");

  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);

  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Duration in seconds of a raw PCM buffer at the given format. */
export function pcmDurationSeconds(pcm: Buffer, format: AudioFormat): number {
  const bytesPerFrame = (BITS_PER_SAMPLE / 8) * format.channels;
  return pcm.length / bytesPerFrame / format.rate;
}

/** Convert float samples in [-1, 1] to interleaved signed 16-bit PCM. */
export function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    // Asymmetric scaling: -1 maps to -32768, +1 maps to +32767.
    out.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
  }
  return out;
}
