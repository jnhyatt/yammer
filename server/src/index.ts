/**
 * Yammer server entrypoint.
 *
 * Loads config, warms the TTS model so the first utterance of a sitting doesn't
 * pay cold start, then listens.
 */

import { loadConfig } from "./config.ts";
import { log, setLogLevel } from "./log.ts";
import { Router } from "./router/router.ts";
import { SttClient } from "./stt/groq.ts";
import { TtsEngine } from "./tts/kokoro.ts";
import { loadWorkspaces } from "./startup.ts";
import { startServer } from "./ws-server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const { registry: workspaces, manager } = await loadWorkspaces(config);

  log.info("starting yammer server", {
    envFile: config.envFile ?? "(none)",
    workspaces: workspaces.list().map((w) => `${w.name}:${w.status}`).join(",") || "(none)",
    workspaceRoot: config.workspaces.root,
    sttModel: config.stt.model,
    routerModel: config.router.model,
    opencodeAgent: config.opencode.agent,
    voice: config.tts.voice,
  });

  const tts = new TtsEngine(config.tts);
  const deps = {
    stt: new SttClient(config.stt),
    router: new Router(config.router),
    workspaces,
    manager,
    tts,
  };

  // Blocking here is deliberate: better a slow start than a slow first reply.
  await tts.warmUp();

  // Only workspaces with an OpenCode actually answering. A watcher pointed at a
  // stopped container would spend the process's life reconnecting to a closed
  // port; `load` is what starts one and connects to it.
  for (const workspace of workspaces.list()) {
    if (workspace.status !== "ready") {
      log.info("workspace registered but not running", {
        workspace: workspace.name,
        status: workspace.status,
      });
      continue;
    }
    // Warns only — a missing agent still forwards turns, just with screen-shaped
    // formatting read out loud.
    await workspace.opencode.verifyAgent();
    // Started after the agent check so a misconfigured agent is reported first.
    workspace.startWatching();
  }

  const wss = startServer(config, deps);

  // Deliberately not awaited, and after `listen`: reconciliation can only say a
  // container is up, so a workspace that has been running for a week still
  // reads as `starting` until something asks the OpenCode inside it. That is
  // worth correcting and never worth delaying the server for.
  void manager.refreshStatuses().catch((error) => {
    log.warn("could not refresh workspace statuses", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    for (const workspace of workspaces.list()) workspace.stopWatching();
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
