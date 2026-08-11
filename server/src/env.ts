/**
 * `.env` loading.
 *
 * The server needs several secrets (transport token, STT key, router key), and
 * exporting them by hand every time is exactly the friction that leads to them
 * ending up in shell history. A `.env` beside the package is the ergonomic
 * alternative.
 *
 * Two rules, both deliberate:
 *
 * - **The real environment always wins.** A variable already set in the process
 *   environment is never overwritten by the file, so `YAMMER_LOG_LEVEL=debug
 *   npm start` behaves the way you'd expect even with a `.env` present. This is
 *   Node's own `loadEnvFile` semantics, not something layered on top.
 * - **The first file found wins; files are not merged.** Search order is
 *   `$YAMMER_ENV_FILE`, then `server/.env`, then the repository root `.env`.
 *   Layering would mean a variable's value depends on which of two files it
 *   appears in, which is a bad thing to have to reason about at 3am with a baby
 *   on your shoulder.
 *
 * See `../.env.example` for the file format. The client's `env.py` implements
 * the same search and the same parse — change them together.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where the config actually came from, for the startup log line. */
export interface EnvSource {
  /** Absolute path of the file that was loaded, or null if none was found. */
  path: string | null;
}

class EnvError extends Error {}

const packageRoot = dirname(import.meta.dirname);
const repoRoot = dirname(packageRoot);

/**
 * Load a `.env` into `process.env`, without clobbering what's already there.
 *
 * An explicit `YAMMER_ENV_FILE` that doesn't exist is an error — you asked for
 * that file by name. A missing default `.env` is not; the environment may well
 * be populated some other way.
 */
export function loadEnvFile(): EnvSource {
  const explicit = process.env["YAMMER_ENV_FILE"];
  if (explicit !== undefined && explicit !== "") {
    const path = resolve(explicit);
    if (!existsSync(path)) {
      throw new EnvError(`YAMMER_ENV_FILE points at ${path}, which does not exist`);
    }
    process.loadEnvFile(path);
    return { path };
  }

  for (const candidate of [join(packageRoot, ".env"), join(repoRoot, ".env")]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return { path: candidate };
    }
  }

  return { path: null };
}
