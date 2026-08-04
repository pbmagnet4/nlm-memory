/**
 * Stage A blind judge runner.
 *
 * Reads reports/re-derivation/sample.jsonl, asks a cross-family judge to label
 * each pair against the six-way rubric, and writes labels.jsonl.
 *
 * Three things here are deliberate:
 *
 *  1. Verdicts cache on disk keyed by sha256(model, SYSTEM prompt, user prompt).
 *     The system prompt must be in the key: the rubric lives there, and an
 *     earlier version keyed on the user prompt alone replayed 300/303 stale
 *     verdicts after a rubric edit, returning a byte-identical distribution that
 *     read as convergence. Stale verdicts must never be mixed into a run.
 *
 *  2. A row that fails is recorded and SKIPPED, never fatal. chatOnce retries
 *     once with no backoff, which was fine for the replay eval against a warm
 *     endpoint; across 303 calls LM Studio can swap the resident model and a
 *     cold load measured 42s on 2026-08-04, so both attempts can land inside one
 *     swap. Failed rows get one more pass at the end after a wait.
 *
 *  3. An unparseable reply is stored as label:null and excluded from scoring.
 *     Coercing it to a negative would quietly inflate every recall number.
 *
 * Usage:
 *   npx tsx scripts/eval/re-derivation-label.ts --limit 3      # smoke
 *   npx tsx scripts/eval/re-derivation-label.ts --pilot 40     # stratified pilot
 *   npm run eval:rederiv-label                                 # full run
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatOnce, type ChatOptions } from "./lib/chat-client.js";
import { deriveSeed, makeRng, seededShuffle } from "./lib/recall-impact-replay-lib.js";
import {
  buildJudgePrompt,
  parseVerdict,
  RUBRIC_SYSTEM,
  type SampleRow,
  type Verdict,
} from "./lib/re-derivation-rubric.js";

const OUT_DIR = join(process.cwd(), "reports", "re-derivation");
const CACHE_DIR = join(OUT_DIR, "judge-cache");
const SEED = 20260804;
const CONCURRENCY = 3;
const RETRY_WAIT_MS = 30_000;

const JUDGE_MODEL = process.env["NLM_EVAL_JUDGE_MODEL"] ?? "google/gemma-4-26b-a4b-qat";
const SECOND_MODEL = process.env["NLM_EVAL_JUDGE2_MODEL"] ?? "qwen/qwen3.6-35b-a3b";
const BASE_URL = process.env["NLM_EVAL_JUDGE_BASE_URL"] ?? "http://192.168.1.217:1234/v1";

function opts(model: string): ChatOptions {
  return {
    baseUrl: BASE_URL,
    model,
    apiKey: process.env["NLM_EVAL_JUDGE_API_KEY"] ?? "lm-studio",
    temperature: 0,
    maxTokens: 400,
    reasoningEffort: "none",
    timeoutMs: 240_000,
  };
}

function log(m: string): void {
  process.stderr.write(`${m}\n`);
}

/**
 * The SYSTEM prompt is part of the key, not just the user prompt. The rubric
 * lives in the system message, so keying on the user prompt alone means editing
 * the rubric silently replays stale verdicts - which happened on 2026-08-04 and
 * produced a byte-identical label distribution that looked like convergence.
 */
function cacheKey(model: string, system: string, prompt: string): string {
  return createHash("sha256").update(`${model}\u0000${system}\u0000${prompt}`).digest("hex");
}

function readCache(model: string, system: string, prompt: string): string | null {
  const p = join(CACHE_DIR, `${cacheKey(model, system, prompt)}.json`);
  if (!existsSync(p)) return null;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { raw: string }).raw;
  } catch {
    return null;
  }
}

function writeCacheEntry(model: string, system: string, prompt: string, raw: string): void {
  writeFileSync(
    join(CACHE_DIR, `${cacheKey(model, system, prompt)}.json`),
    JSON.stringify({ model, raw }),
  );
}

async function judge(model: string, row: SampleRow): Promise<{ raw: string; cached: boolean }> {
  const prompt = buildJudgePrompt(row);
  const hit = readCache(model, RUBRIC_SYSTEM, prompt);
  if (hit !== null) return { raw: hit, cached: true };
  const raw = await chatOnce(opts(model), RUBRIC_SYSTEM, prompt);
  writeCacheEntry(model, RUBRIC_SYSTEM, prompt, raw);
  return { raw, cached: false };
}

interface Outcome {
  readonly pairId: string;
  readonly stratum: string;
  verdict: Verdict | null;
  raw?: string;
  error?: string;
}

async function runPass(
  model: string,
  rows: ReadonlyArray<SampleRow & { stratum: string }>,
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  let done = 0;
  let cachedCount = 0;
  const workers = Array.from({ length: CONCURRENCY }, async (_, w) => {
    for (let i = w; i < rows.length; i += CONCURRENCY) {
      const row = rows[i]!;
      try {
        const { raw, cached } = await judge(model, row);
        if (cached) cachedCount++;
        out.set(row.pairId, {
          pairId: row.pairId,
          stratum: row.stratum,
          verdict: parseVerdict(raw),
          raw,
        });
      } catch (e) {
        out.set(row.pairId, {
          pairId: row.pairId,
          stratum: row.stratum,
          verdict: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (++done % 20 === 0) log(`  judged ${done}/${rows.length} (${cachedCount} cached)`);
    }
  });
  await Promise.all(workers);
  return out;
}

function stratifiedPick(
  rows: ReadonlyArray<SampleRow & { stratum: string }>,
  n: number,
  purpose: string,
): Array<SampleRow & { stratum: string }> {
  const byStratum = new Map<string, Array<SampleRow & { stratum: string }>>();
  for (const r of rows) {
    const l = byStratum.get(r.stratum);
    if (l) l.push(r);
    else byStratum.set(r.stratum, [r]);
  }
  const keys = [...byStratum.keys()].sort();
  const per = Math.floor(n / keys.length);
  const picked: Array<SampleRow & { stratum: string }> = [];
  for (const k of keys) {
    const pool = seededShuffle(byStratum.get(k)!, makeRng(deriveSeed(SEED, `${purpose}:${k}`)));
    picked.push(...pool.slice(0, per));
  }
  // Top up deterministically to hit n exactly.
  const chosen = new Set(picked.map((p) => p.pairId));
  const rest = seededShuffle(
    rows.filter((r) => !chosen.has(r.pairId)),
    makeRng(deriveSeed(SEED, `${purpose}:topup`)),
  );
  picked.push(...rest.slice(0, Math.max(0, n - picked.length)));
  return picked.sort((x, y) => x.pairId.localeCompare(y.pairId));
}

function spotCheckMarkdown(
  rows: ReadonlyArray<SampleRow & { stratum: string }>,
  outcomes: Map<string, Outcome>,
  n: number,
): string {
  const pos: Array<SampleRow & { stratum: string }> = [];
  const neg: Array<SampleRow & { stratum: string }> = [];
  for (const r of rows) {
    const v = outcomes.get(r.pairId)?.verdict;
    if (!v) continue;
    (v.label === "GENUINE" ? pos : neg).push(r);
  }
  const half = Math.floor(n / 2);
  const pick = [
    ...seededShuffle(pos, makeRng(deriveSeed(SEED, "spotcheck:pos"))).slice(0, half),
    ...seededShuffle(neg, makeRng(deriveSeed(SEED, "spotcheck:neg"))).slice(0, n - half),
  ];
  const shuffled = seededShuffle(pick, makeRng(deriveSeed(SEED, "spotcheck:order")));

  const head = [
    "# Stage A spot check",
    "",
    "Label each pair yourself, then hand the file back. The judge's verdicts are",
    "deliberately not shown - seeing them first would make the agreement number",
    "meaningless.",
    "",
    "Write one of these on the `Your label:` line:",
    "",
    "- **GENUINE** - the later session worked out something the earlier one had already settled, with no sign it knew.",
    "- **REVISIT** - the later session knowingly changed or refined the earlier decision.",
    "- **RITUAL** - same recurring routine, different subject (\"Task 6 approved\" vs \"Approved Task 2\").",
    "- **SAME_TOPIC_DIFFERENT_DECISION** - same area, genuinely different question settled.",
    "- **DUPLICATE** - the same piece of work recorded twice.",
    "",
    "---",
    "",
  ].join("\n");

  const body = shuffled
    .map((r, i) => {
      const side = (name: string, s: SampleRow["a"]): string =>
        [
          `**${name}** (${s.startedAt.slice(0, 10)}) - ${s.label}`,
          "",
          ...s.decisions.map((d) => `- ${d}`),
          "",
          `> ${s.excerpt.trim().slice(0, 600)}`,
        ].join("\n");
      return [
        `## ${i + 1}. \`${r.pairId}\``,
        "",
        side("Earlier", r.a),
        "",
        side("Later", r.b),
        "",
        "**Your label:** ______",
        "",
        "---",
        "",
      ].join("\n");
    })
    .join("\n");

  return head + body;
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const numArg = (flag: string): number | null => {
    const i = args.indexOf(flag);
    return i === -1 ? null : Number(args[i + 1]);
  };
  const limit = numArg("--limit");
  const pilot = numArg("--pilot");

  const samplePath = join(OUT_DIR, "sample.jsonl");
  const all = readFileSync(samplePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SampleRow & { stratum: string });

  let rows = all;
  let outName = "labels.jsonl";
  if (pilot !== null) {
    rows = stratifiedPick(all, pilot, "pilot");
    outName = "labels-pilot.jsonl";
  } else if (limit !== null) {
    rows = all.slice(0, limit);
    outName = "labels-smoke.jsonl";
  }

  log(`judging ${rows.length} pairs with ${JUDGE_MODEL} at ${BASE_URL}`);
  let outcomes = await runPass(JUDGE_MODEL, rows);

  const failed = rows.filter((r) => outcomes.get(r.pairId)?.error);
  if (failed.length) {
    log(`${failed.length} rows failed; waiting ${RETRY_WAIT_MS / 1000}s then retrying those only`);
    await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    const second = await runPass(JUDGE_MODEL, failed);
    for (const [k, v] of second) if (!v.error) outcomes.set(k, v);
  }

  const parsed = [...outcomes.values()].filter((o) => o.verdict);
  const parseFails = [...outcomes.values()].filter((o) => !o.verdict && !o.error);
  const callFails = [...outcomes.values()].filter((o) => o.error);

  // Consistency subsample against a different family.
  const consistencyRows = stratifiedPick(rows, Math.min(30, rows.length), "consistency");
  let agree = 0;
  let compared = 0;
  const secondVerdicts = new Map<string, Verdict | null>();
  if (process.env["NLM_SKIP_CONSISTENCY"] !== "1") {
    log(`consistency subsample: ${consistencyRows.length} pairs with ${SECOND_MODEL}`);
    const s = await runPass(SECOND_MODEL, consistencyRows);
    for (const r of consistencyRows) {
      const a = outcomes.get(r.pairId)?.verdict;
      const b = s.get(r.pairId)?.verdict;
      secondVerdicts.set(r.pairId, b ?? null);
      if (!a || !b) continue;
      compared++;
      if ((a.label === "GENUINE") === (b.label === "GENUINE")) agree++;
    }
  }

  writeFileSync(
    join(OUT_DIR, outName),
    `${rows
      .map((r) => {
        const o = outcomes.get(r.pairId);
        return JSON.stringify({
          pairId: r.pairId,
          stratum: r.stratum,
          verdict: o?.verdict ?? null,
          secondVerdict: secondVerdicts.get(r.pairId) ?? null,
          error: o?.error ?? null,
        });
      })
      .join("\n")}\n`,
  );

  const dist = new Map<string, number>();
  for (const o of parsed) dist.set(o.verdict!.label, (dist.get(o.verdict!.label) ?? 0) + 1);

  log("");
  log(`total ${rows.length} | parsed ${parsed.length} | parse-fail ${parseFails.length} | call-fail ${callFails.length}`);
  log(`labels: ${[...dist.entries()].sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (compared) log(`binary agreement with ${SECOND_MODEL}: ${agree}/${compared} (${((100 * agree) / compared).toFixed(1)}%)`);
  if (parseFails.length / Math.max(1, rows.length) > 0.05) {
    log("WARNING: parse failures above 5% - fix the rubric before scoring");
  }

  if (pilot === null && limit === null) {
    writeFileSync(join(OUT_DIR, "spot-check.md"), spotCheckMarkdown(rows, outcomes, 20));
    log("wrote spot-check.md");
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
