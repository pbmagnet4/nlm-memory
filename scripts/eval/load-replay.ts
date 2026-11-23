/**
 * Load-replay eval (T1775b): replay real prompt-hook traffic from the hook
 * log against an NLM daemon (started on a copy of the DB) and score it
 * against the recall SLOs — timeout rate < 2 %, recall p95 < 1000 ms. Prints
 * the report as JSON on stdout, exits 1 on any SLO breach, 0 on a clean run,
 * 2 on bad input. Read-only apart from HTTP GETs; the report carries counts
 * and latencies only, never prompt text.
 *
 * Usage:
 *   npm run eval:load-replay -- [--log <path>] [--since <ISO>] [--limit <n>]
 *     [--speed <x>] [--concurrency <n>] [--base-url <url>]
 *
 * Hook-log lines written by T1775b or later replay the exact query the hook
 * sent (recallQuery); older lines rebuild it from the 200-char preview and
 * are counted as `approximate` in the report — approximate replays may see
 * slightly different recall latencies for long or context-augmented prompts.
 * A run that selects no records or measures no request exits 2 (`noData`),
 * never as a silent pass.
 *
 * All the judgment (filtering, windowing, schedule, percentiles, breaches)
 * is the unit-tested pure lib; this file only reads the log, speaks HTTP and
 * exits.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoloadEnv } from "../../src/llm/env-autoload.js";
import { fetchWithTimeout } from "../../src/hook/hook-helpers.js";
import { hookAuthHeaders } from "../../src/hook/hook-auth.js";
import { recallTimeoutMs } from "../../src/hook/recall-over-http.js";
import {
  buildReport,
  buildSchedule,
  defaultSinceMs,
  LOAD_TARGETS,
  parseHookLogLines,
  recallUrl,
  replayQuery,
  selectWindow,
  type MeasuredRequest,
} from "./lib/load-replay-lib.js";

interface CliArgs {
  readonly log: string;
  readonly since: string | null;
  readonly limit: number;
  readonly speed: number;
  readonly concurrency: number;
  readonly baseUrl: string;
}

function fail(message: string): never {
  process.stderr.write(`load-replay: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) fail(`unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`flag ${arg} needs a value`);
    flags.set(arg, value!);
    i++;
  }
  const intFlag = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer, got "${raw}"`);
    return n;
  };

  const speedRaw = flags.get("--speed") ?? "10";
  const speed = Number(speedRaw);
  if (!Number.isFinite(speed) || speed < 0) fail(`--speed must be >= 0, got "${speedRaw}"`);

  const baseUrl = flags.get("--base-url") ?? "http://127.0.0.1:3940";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") fail(`--base-url must be http(s), got "${baseUrl}"`);
  } catch {
    fail(`--base-url is not a valid URL: "${baseUrl}"`);
  }

  const since = flags.get("--since") ?? null;
  if (since !== null && Number.isNaN(Date.parse(since))) fail(`--since is not a parseable timestamp: "${since}"`);

  return {
    log: flags.get("--log") ?? join(homedir(), ".nlm", "hook-log.jsonl"),
    since,
    limit: intFlag("--limit", 500),
    speed,
    concurrency: intFlag("--concurrency", 4),
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}

async function sendRecall(
  baseUrl: string,
  query: string,
  conversationId: string | undefined,
  timeoutMs: number,
): Promise<MeasuredRequest> {
  const started = performance.now();
  try {
    const res = await fetchWithTimeout(
      recallUrl(baseUrl, query, conversationId),
      { headers: hookAuthHeaders({ "x-recall-source": "hook" }) },
      timeoutMs,
    );
    if (!res.ok) {
      void res.body?.cancel();
      return { outcome: "http-error", ms: performance.now() - started };
    }
    try {
      await res.json();
    } catch {
      return { outcome: "http-error", ms: performance.now() - started };
    }
    return { outcome: "ok", ms: performance.now() - started };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { outcome: aborted ? "timeout" : "unreachable", ms: performance.now() - started };
  }
}

/** GET /api/health/slo's actual.stalls; null when unavailable. */
async function fetchStalls(baseUrl: string, timeoutMs: number): Promise<unknown> {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/health/slo`,
      { headers: hookAuthHeaders() },
      timeoutMs,
    );
    if (!res.ok) {
      void res.body?.cancel();
      return null;
    }
    const body = (await res.json()) as { actual?: { stalls?: unknown } };
    return body?.actual?.stalls ?? null;
  } catch {
    return null;
  }
}

interface Job {
  readonly offsetMs: number;
  readonly query: string;
  readonly conversationId?: string;
}

async function runSchedule(
  jobs: ReadonlyArray<Job>,
  baseUrl: string,
  timeoutMs: number,
  concurrency: number,
): Promise<MeasuredRequest[]> {
  const startedAt = performance.now();
  const results: MeasuredRequest[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const wait = startedAt + jobs[i]!.offsetMs - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      results[i] = await sendRecall(baseUrl, jobs[i]!.query, jobs[i]!.conversationId, timeoutMs);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, jobs.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  autoloadEnv();
  const args = parseArgs(process.argv.slice(2));

  let raw: string;
  try {
    raw = readFileSync(args.log, "utf8");
  } catch (e) {
    fail(`cannot read hook log ${args.log}: ${(e as Error).message}`);
  }

  const { records, malformed, skipped } = parseHookLogLines(raw!);
  if (malformed > 0 || skipped > 0) {
    process.stderr.write(`load-replay: skipped ${skipped} non-replay lines, ${malformed} malformed\n`);
  }

  const sinceMs = args.since !== null ? Date.parse(args.since) : (defaultSinceMs(records) ?? 0);
  const selected = selectWindow(records, sinceMs, args.limit);

  const offsets = buildSchedule(selected.map((r) => r.tsMs), args.speed);
  const timed: Job[] = [];
  let noQuery = 0;
  let approximate = 0;
  selected.forEach((rec, i) => {
    const built = replayQuery(rec);
    if (built.query === null) {
      noQuery++;
      return;
    }
    if (built.approximate) approximate++;
    timed.push({
      offsetMs: offsets[i]!,
      query: built.query,
      ...(rec.conversationId !== "unknown" ? { conversationId: rec.conversationId } : {}),
    });
  });

  const timeoutMs = recallTimeoutMs();
  const stallsBefore = await fetchStalls(args.baseUrl, timeoutMs);
  const measured = await runSchedule(timed, args.baseUrl, timeoutMs, args.concurrency);
  const stallsAfter = await fetchStalls(args.baseUrl, timeoutMs);

  const report = buildReport(measured, { skipped: noQuery, approximate });
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: {
          log: args.log,
          baseUrl: args.baseUrl,
          since: new Date(sinceMs).toISOString(),
          limit: args.limit,
          speed: args.speed,
          concurrency: args.concurrency,
          perRequestTimeoutMs: timeoutMs,
        },
        targets: LOAD_TARGETS,
        parsed: records.length,
        selected: selected.length,
        ...report,
        healthStalls: { before: stallsBefore, after: stallsAfter },
      },
      null,
      2,
    )}\n`,
  );
  if (report.noData) {
    process.stderr.write(
      `load-replay: NO DATA — requests: 0 (${selected.length} record(s) selected, none measured) — not a pass\n`,
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = report.breaches.length > 0 ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`load-replay: ${(e as Error).stack ?? String(e)}\n`);
  process.exitCode = 1;
});
