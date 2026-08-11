/**
 * Router eval runner.
 *
 * Scores one or more model IDs against `cases.ts` by driving the real `Router`
 * class — same code path the server uses, not a reimplementation. Point this
 * at any OpenRouter-compatible model to compare accuracy, critical-case
 * misroutes, and latency before changing `YAMMER_ROUTER_MODEL`.
 *
 * Usage:
 *   npm run eval:router                                   # default comparison set
 *   npm run eval:router -- <model-id> [<model-id> ...]     # specific models
 *
 * Needs YAMMER_ROUTER_API_KEY (and optionally YAMMER_ROUTER_BASE_URL) in the
 * environment or a .env — see env.ts. Nothing else the server needs (STT key,
 * project dir, transport token) is required here; this only exercises the
 * routing call.
 */

import { loadEnvFile } from "../../env.ts";
import { Router, RouterError, type SessionState } from "../router.ts";
import { EVAL_CASES, type EvalCase, type ExpectedAction } from "./cases.ts";

const DEFAULT_MODELS = [
  "google/gemini-2.5-flash-lite",
  // The leading `~` is part of the real OpenRouter model ID (it denotes a
  // rolling alias to whatever DeepSeek currently calls "latest"), not a typo —
  // drop it and every call 400s with "not a valid model ID".
  "~deepseek/deepseek-v4-flash-latest",
  "deepseek/deepseek-v4-flash",
];

// Every case runs against the same mid-sitting session: an active session
// with a few replies. That's the common case an utterance actually arrives
// in, and it's the state where `compact`/`new_session` are live options for
// the router to (mis)pick — an empty-session state would make those two
// commands trivially unlikely regardless of model quality.
const SESSION_STATE: SessionState = { sessionId: "eval-session", turnCount: 6 };

const CONCURRENCY = 5;

interface CaseResult {
  case: EvalCase;
  actual: ExpectedAction | "error";
  ms: number;
  error?: string;
}

async function main(): Promise<void> {
  loadEnvFile();

  const apiKey = process.env["YAMMER_ROUTER_API_KEY"];
  if (!apiKey) {
    console.error(
      "YAMMER_ROUTER_API_KEY is not set. Add it to server/.env (see .env.example) " +
        "or export it, then re-run.\n\nThis eval only needs the router key — it does " +
        "not touch STT, OpenCode, or TTS.",
    );
    process.exitCode = 1;
    return;
  }
  const baseUrl = process.env["YAMMER_ROUTER_BASE_URL"] || "https://openrouter.ai/api/v1";

  const models = process.argv.slice(2);
  const targets = models.length > 0 ? models : DEFAULT_MODELS;

  console.log(`${EVAL_CASES.length} cases, concurrency ${CONCURRENCY}, models: ${targets.join(", ")}\n`);

  const allResults = new Map<string, CaseResult[]>();
  for (const model of targets) {
    const router = new Router({ baseUrl, apiKey, model });
    console.log(`--- ${model} ---`);
    const results = await runCases(router);
    allResults.set(model, results);
    report(model, results);
    console.log();
  }

  if (targets.length > 1) {
    diff(targets, allResults);
  }
}

async function runCases(router: Router): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(EVAL_CASES.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= EVAL_CASES.length) return;
      const evalCase = EVAL_CASES[i]!;
      const started = Date.now();
      try {
        const decision = await router.route(evalCase.transcript, SESSION_STATE);
        results[i] = { case: evalCase, actual: decision.action as ExpectedAction, ms: Date.now() - started };
      } catch (cause) {
        results[i] = {
          case: evalCase,
          actual: "error",
          ms: Date.now() - started,
          error: cause instanceof RouterError ? cause.message : String(cause),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

function report(model: string, results: CaseResult[]): void {
  const correct = results.filter((r) => r.actual === r.case.expected);
  const wrong = results.filter((r) => r.actual !== r.case.expected);
  // A miss is critical if the case was pre-flagged as an adversarial
  // near-miss for a destructive command, OR — regardless of how the case was
  // categorized — if the router actually landed on `new_session`. The second
  // clause catches cases like "make it new" that weren't anticipated as
  // adversarial for this command but produced the destructive outcome anyway;
  // the consequence, not the input's category, is what makes a miss critical.
  const critical = wrong.filter((r) => r.case.critical || r.actual === "new_session");
  const errored = results.filter((r) => r.actual === "error");

  const byCategory = new Map<string, { correct: number; total: number }>();
  for (const r of results) {
    const bucket = byCategory.get(r.case.category) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (r.actual === r.case.expected) bucket.correct += 1;
    byCategory.set(r.case.category, bucket);
  }

  const latencies = results.filter((r) => r.actual !== "error").map((r) => r.ms).sort((a, b) => a - b);
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  console.log(`accuracy: ${correct.length}/${results.length} (${pct(correct.length, results.length)})`);
  for (const [category, { correct: c, total }] of byCategory) {
    console.log(`  ${category.padEnd(18)} ${c}/${total} (${pct(c, total)})`);
  }
  console.log(`latency: mean ${mean.toFixed(0)}ms, p95 ${p95}ms`);

  if (errored.length > 0) {
    console.log(`\n${errored.length} call(s) errored:`);
    for (const r of errored) console.log(`  "${r.case.transcript}" -> ${r.error}`);
  }

  if (critical.length > 0) {
    console.log(`\n!! ${critical.length} CRITICAL misroute(s) — forward instructions routed to a destructive command:`);
    for (const r of critical) {
      console.log(`  "${r.case.transcript}"\n    expected ${r.case.expected}, got ${r.actual}`);
    }
  } else {
    console.log("\nno critical misroutes");
  }

  const nonCriticalWrong = wrong.filter((r) => !r.case.critical);
  if (nonCriticalWrong.length > 0) {
    console.log(`\n${nonCriticalWrong.length} other miss(es):`);
    for (const r of nonCriticalWrong) {
      console.log(`  "${r.case.transcript}" -> expected ${r.case.expected}, got ${r.actual}`);
    }
  }
}

function diff(models: string[], allResults: Map<string, CaseResult[]>): void {
  console.log("--- disagreements across models ---");
  let any = false;
  for (let i = 0; i < EVAL_CASES.length; i++) {
    const actions = models.map((m) => allResults.get(m)![i]!.actual);
    if (new Set(actions).size <= 1) continue;
    any = true;
    console.log(`"${EVAL_CASES[i]!.transcript}" (expected ${EVAL_CASES[i]!.expected})`);
    for (const [m, a] of models.map((m, idx) => [m, actions[idx]] as const)) {
      console.log(`  ${m.padEnd(38)} -> ${a}`);
    }
  }
  if (!any) console.log("none — every model agreed on every case");
}

function pct(n: number, total: number): string {
  return total === 0 ? "n/a" : `${((n / total) * 100).toFixed(0)}%`;
}

main().catch((cause) => {
  console.error("eval failed:", cause);
  process.exitCode = 1;
});
