/**
 * Yammer server entrypoint.
 *
 * Loads config, warms the TTS model so the first utterance of a sitting doesn't
 * pay cold start, then listens.
 */

import { loadConfig } from "./config.ts";
import { log, setLogLevel } from "./log.ts";
import { PermissionWatcher } from "./opencode/permissions.ts";
import { OpenCodeSession } from "./opencode/session.ts";
import { Router } from "./router/router.ts";
import { SttClient } from "./stt/groq.ts";
import { TtsEngine } from "./tts/kokoro.ts";
import { startServer } from "./ws-server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info("starting yammer server", {
    envFile: config.envFile ?? "(none)",
    projectDir: config.opencode.projectDir,
    sttModel: config.stt.model,
    routerModel: config.router.model,
    opencodeAgent: config.opencode.agent,
    voice: config.tts.voice,
  });

  const tts = new TtsEngine(config.tts);
  const permissions = new PermissionWatcher(
    config.opencode.baseUrl,
    config.opencode.projectDir,
  );
  const deps = {
    stt: new SttClient(config.stt),
    router: new Router(config.router),
    opencode: new OpenCodeSession(config.opencode),
    tts,
    permissions,
  };

  // Blocking here is deliberate: better a slow start than a slow first reply.
  await tts.warmUp();

  // Warns only — a missing agent still forwards turns, just with screen-shaped
  // formatting read out loud.
  await deps.opencode.verifyAgent();

  // Started after the agent check so a misconfigured agent is reported first.
  permissions.start();

  const wss = startServer(config, deps);

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    permissions.stop();
    wss.close(() => process.exit(0));
    // Don't hang forever on a wedged socket.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
