/**
 * Server configuration, entirely from the environment.
 *
 * Everything the requirements doc calls out as expected-to-change is a variable
 * here rather than a literal in code: the STT base URL and model, the router
 * model, and the transport token.
 *
 * A `.env` beside the package populates the environment first, without
 * overriding anything already set — see `env.ts`.
 */

import { loadEnvFile } from "./env.ts";

export interface Config {
  /** Interface to bind. Defaults to loopback — see PROTOCOL.md on scoping. */
  host: string;
  port: number;
  /** Shared secret the client must present in `hello`. */
  token: string;

  stt: {
    /** OpenAI-compatible. Swapping providers is a base-URL + model change. */
    baseUrl: string;
    apiKey: string;
    model: string;
  };

  router: {
    baseUrl: string;
    apiKey: string;
    /** Fixed in config for v1, deliberately not runtime-configurable. */
    model: string;
  };

  opencode: {
    baseUrl: string;
    /** The single directory OpenCode's filesystem access is scoped to. */
    projectDir: string;
    /** Optional provider/model override for OpenCode itself. */
    providerId?: string;
    modelId?: string;
    /**
     * OpenCode agent to prompt with. Defaults to Yammer's own TTS-aware agent
     * (`.opencode/agent/yammer.md`); set to `build` for OpenCode's default,
     * which formats for a screen and reads badly aloud.
     */
    agent: string;
  };

  supervisor: {
    /**
     * Kokoro voice for the approval prompt. Must differ audibly from
     * `tts.voice` — two voices is the user's only cue that they are being asked
     * a question rather than answered.
     */
    voice: string;
    /** How long one answer window stays open before counting as no answer. */
    answerSeconds: number;
    /** Asks before giving up, including the first. Then: reject and abort. */
    maxAttempts: number;
  };

  tts: {
    /** HF repo id for the Kokoro ONNX weights. */
    modelId: string;
    /** fp32 | fp16 | q8 | q4 | q4f16 — q8 is a good CPU default. */
    dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
    voice: string;
    /** onnxruntime-node execution provider. "cuda" requires the CUDA EP
     *  binaries and CUDA/cuBLAS runtime libraries to be present — see
     *  server/README.md's "GPU offload" section. */
    device: "cpu" | "cuda";
  };

  logLevel: "debug" | "info" | "warn" | "error";

  /** The `.env` that was loaded, or null. Reported at startup so a token that
   *  isn't taking effect is diagnosable without guessing. */
  envFile: string | null;
}

class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(`missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigError(`${name} must be a port number, got ${raw}`);
  }
  return parsed;
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${raw}`);
  }
  return parsed;
}

function oneOf<const T extends readonly string[]>(
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return raw as T[number];
}

export function loadConfig(): Config {
  // Before any read of process.env below, and non-overriding, so an explicit
  // `FOO=bar npm start` still beats the file.
  const env = loadEnvFile();

  return {
    envFile: env.path,
    host: optional("YAMMER_HOST", "127.0.0.1"),
    port: port("YAMMER_PORT", 8765),
    token: required("YAMMER_TOKEN"),

    stt: {
      baseUrl: optional("YAMMER_STT_BASE_URL", "https://api.groq.com/openai/v1"),
      apiKey: required("YAMMER_STT_API_KEY"),
      model: optional("YAMMER_STT_MODEL", "whisper-large-v3-turbo"),
    },

    router: {
      baseUrl: optional("YAMMER_ROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
      apiKey: required("YAMMER_ROUTER_API_KEY"),
      model: optional("YAMMER_ROUTER_MODEL", "deepseek/deepseek-v4-flash"),
    },

    opencode: {
      baseUrl: optional("YAMMER_OPENCODE_URL", "http://127.0.0.1:4096"),
      projectDir: required("YAMMER_PROJECT_DIR"),
      providerId: process.env["YAMMER_OPENCODE_PROVIDER"] || undefined,
      modelId: process.env["YAMMER_OPENCODE_MODEL"] || undefined,
      agent: optional("YAMMER_OPENCODE_AGENT", "yammer"),
    },

    supervisor: {
      // Default is British male against the agent's American female default:
      // different enough that a half-heard first word still tells you which is
      // speaking.
      voice: optional("YAMMER_SUPERVISOR_VOICE", "bm_george"),
      answerSeconds: positive("YAMMER_SUPERVISOR_ANSWER_SECONDS", 12),
      maxAttempts: Math.max(
        1,
        Math.floor(positive("YAMMER_SUPERVISOR_MAX_ATTEMPTS", 3)),
      ),
    },

    tts: {
      modelId: optional("YAMMER_TTS_MODEL", "onnx-community/Kokoro-82M-v1.0-ONNX"),
      dtype: oneOf(
        "YAMMER_TTS_DTYPE",
        ["fp32", "fp16", "q8", "q4", "q4f16"] as const,
        "q8",
      ),
      voice: optional("YAMMER_TTS_VOICE", "af_heart"),
      device: oneOf("YAMMER_TTS_DEVICE", ["cpu", "cuda"] as const, "cpu"),
    },

    logLevel: oneOf(
      "YAMMER_LOG_LEVEL",
      ["debug", "info", "warn", "error"] as const,
      "info",
    ),
  };
}
