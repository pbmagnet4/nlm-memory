/**
 * T1782 step 3 — can Clef judge recall relevance offline?
 *
 * The eval set (`--eval-set`, default ~/.nxtos/state/t1782/eval-set.jsonl, see its README)
 * is real (prompt, injected memory) pairs drawn from hook traffic and labelled 0-3 by a
 * judgment model with a rubric: 3 same task, 2 same system related, 1 keyword overlap
 * only, 0 unrelated; `relevant` = relevance >= 2. Synthetic e2e/probe prompts were
 * removed, so this measures the pair population a nightly relevance-precision metric
 * would see.
 *
 * Shape follows the T1778 tuning rules: `state` = the prompt, and one `score` question per
 * injected memory with the memory's label and summary in the question instructions and four
 * ordered levels mirroring the rubric — one call per prompt, except where the request body
 * gets too big for the endpoint and the memories are chunked (see `units`). Three phrasings
 * ride in the same call, so the wording choice costs nothing extra; the phrasing and
 * the keep threshold are picked per model on the tune split (fixed hash of the PROMPT,
 * so every memory of a prompt lands on the same side) and only then read on holdout.
 *
 * Baseline: the hook's own retrieval score (`hits[].score` in ~/.nlm/hook-log.jsonl),
 * joined back by (ts, wouldInject position, memory id) and scored the same way.
 *
 * Determinism: a byte-identical request reproduces its scores to ~0.01 on the 0-3 scale
 * (17 of 60 re-asked questions differed, max 0.014 — near-deterministic, not exact), so
 * each call is cached in ./.eval/t1782/ and a rerun only redoes what failed.
 *
 * Run: npx tsx scripts/eval/t1782-relevance-judge.ts --model both
 *      npx tsx scripts/eval/t1782-relevance-judge.ts --model flash --report-only
 *      npx tsx scripts/eval/t1782-relevance-judge.ts --model both --report-only --dedupe
 * --dedupe drops the repeat occurrences of a (prompt, memory, rank) triple — the hook
 * log re-logs the same injection when a conversation is re-prompted — as a control on
 * whether the repeated pairs carry the result. Scores come from the same cache either
 * way, so it is a reporting filter, not a new call.
 * Out: .eval/t1782/answers-<model>.json ; tables on stdout
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import type { ClefAnswer, ClefQuestion } from "../../src/llm/clef-client.js";
import { CLEF_MODELS, askClefDirect, clefBaseUrl, flag, latency, mapPool, parseModelFlag, type ClefModelKey } from "./lib/clef-direct.js";
import { auc, splitOf } from "./lib/clef-stats.js";
import { spearman } from "./lib/t1778-stats.js";

const EVAL = join(import.meta.dirname, "../../.eval");
const DIR = join(EVAL, "t1782");
mkdirSync(DIR, { recursive: true });

/** Four ordered levels, worded to the labelling rubric (0 unrelated → 3 same task). */
const LEVELS = [
  "Unrelated: a different task in a different system; nothing here bears on the prompt.",
  "Keyword overlap only: shares words, paths or tools with the prompt, but it is a different task in a different system.",
  "Same system, related: the same project, tool or subsystem, and work the prompt could build on.",
  "Same task: directly about the task, decision, value or status the prompt is about.",
];

/** The three wordings the task asks to compare. */
const PHRASES: Record<string, string> = {
  direct: "How relevant is this memory to the prompt?",
  dev: "Would a developer handling this prompt want this memory open?",
  same: "Is this memory about the same task or the same system as the prompt?",
};

/** Memories that dominate one system and get injected under everything — a relevance
 * gate should stop most of them, so they get their own line in the report. */
const HUBS: Array<[string, RegExp]> = [
  ["nxtgit session pinning", /nxtgit session pinning/i],
  ["NLM classifier fix", /classifier fix/i],
  ["Plan J", /plan j\b/i],
  ["LinkedIn cleanup", /linkedin/i],
];

interface Pair {
  pair_id: string; ts: string; prompt: string; memory_id: string;
  memory_label: string; memory_summary: string; hit_rank: number;
  relevance: number; relevant: boolean; hub: string | null;
}

interface Row {
  key: string; ms: number; stateChars: number; nQuestions: number;
  /** Memories judged in this call and how many per call, for provenance. */
  pair_ids: string[]; chunk: number;
  /** 1-minute load average when the call was issued — Clef latency here is queue-bound. */
  load1: number; answers: Record<string, ClefAnswer> | null; error?: string;
}

const readJsonl = <T,>(p: string): T[] =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

/** The answer cache is one JSON array, rewritten in place for resumability. */
const readCache = (p: string): Row[] => (JSON.parse(readFileSync(p, "utf8")) as Row[]);

function pairs(path: string): Pair[] {
  return readJsonl<Omit<Pair, "hub">>(path).map((r) => ({
    ...r,
    hub: HUBS.find(([, re]) => re.test(r.memory_label))?.[0] ?? null,
  }));
}

/** The hook's own retrieval score for a pair, read-only over the hook log. */
function hookScores(rows: readonly Pair[], logPath: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(logPath)) return out;
  const byTs = new Map<string, Pair[]>();
  for (const r of rows) (byTs.get(r.ts) ?? byTs.set(r.ts, []).get(r.ts)!).push(r);
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.includes('"recallOutcome":"ok"')) continue;
    const m = /"ts":"([^"]+)"/.exec(line);
    if (!m || !byTs.has(m[1]!)) continue;
    const wanted = m[1]!;
    const rec = JSON.parse(line) as { ts: string; hits?: Array<{ id: string; score: number }>; wouldInject?: string[] };
    if (rec.ts !== wanted) continue;
    const byId = new Map((rec.hits ?? []).map((h) => [h.id, h.score]));
    (rec.wouldInject ?? []).forEach((id, i) => {
      const s = byId.get(id);
      if (s === undefined) return;
      for (const p of byTs.get(wanted)!) if (p.memory_id === id && p.hit_rank === i + 1) out.set(p.pair_id, s);
    });
  }
  return out;
}

// ---------- collection ---------------------------------------------------------

/** --dedupe and --limit are reporting filters; collection always uses the full set. */
/** Optional --tag keeps a variant run (e.g. one memory per call) in its own cache. */
const answersPath = (model: ClefModelKey) =>
  join(DIR, `answers-${model}${flag("tag", "") ? `.${flag("tag", "")}` : ""}.json`);

/** One call unit: a prompt plus the slice of its injected memories judged in that call.
 * Memories are chunked so a call stays inside the endpoint's request-body limit (one
 * prompt in this set carries 29 memories; 87 score questions came back HTTP 413). */
interface Unit { key: string; prompt: string; mems: Pair[] }

function units(all: readonly Pair[]): Unit[] {
  const perCall = Math.max(1, Number(flag("chunk", "8")));
  const groups = new Map<string, Pair[]>();
  for (const p of all) (groups.get(p.prompt) ?? groups.set(p.prompt, []).get(p.prompt)!).push(p);
  const out: Unit[] = [];
  for (const [prompt, mems] of groups) {
    for (let i = 0; i < mems.length; i += perCall) {
      const slice = mems.slice(i, i + perCall);
      // Key = hash of the prompt and the memories in this call, so a changed eval set
      // only re-calls the prompts it touched.
      out.push({
        key: createHash("sha256").update(`${prompt}\n${slice.map((m) => `${m.memory_id}@${m.hit_rank}`).join(",")}`).digest("hex").slice(0, 16),
        prompt,
        mems: slice,
      });
    }
  }
  return out;
}

async function collect(model: ClefModelKey, all: Pair[]): Promise<void> {
  // The hook log re-records the same injection, so a few (prompt, memory) pairs repeat;
  // they hash to the same unit, so each distinct call is made once.
  const todo0 = [...new Map(units(all).map((u) => [u.key, u])).values()];
  const path = answersPath(model);
  const perCallNow = Number(flag("chunk", "8"));
  const rows: Row[] = existsSync(path) ? readCache(path).filter((r) => r.chunk === perCallNow) : [];
  const done = new Set(rows.filter((r) => r.answers).map((r) => r.key));
  const todo = todo0.filter((u) => !done.has(u.key));
  console.log(`collect ${CLEF_MODELS[model]}: ${todo0.length} calls (${Object.keys(PHRASES).length} questions per memory, <= ${flag("chunk", "8")} memories per call), ${done.size} cached, ${todo.length} to call`);

  let since = 0;
  await mapPool(todo, Number(flag("parallel", "2")), async (u) => {
    const questions: Record<string, ClefQuestion> = {};
    u.mems.forEach((m, i) => {
      for (const [name, q] of Object.entries(PHRASES)) {
        questions[`x${i}_${name}`] = {
          type: "score",
          instructions: `${q}\nMemory ${i + 1}: ${m.memory_label} — ${m.memory_summary}`,
          criteria: LEVELS,
        };
      }
    });
    const row: Row = {
      key: u.key, ms: 0, stateChars: 0, nQuestions: Object.keys(questions).length,
      pair_ids: u.mems.map((m) => m.pair_id), chunk: perCallNow,
      load1: loadavg()[0] ?? 0, answers: null,
    };
    try {
      const r = await askClefDirect({ prompt: u.prompt }, questions, { baseUrl: clefBaseUrl(), model: CLEF_MODELS[model], timeoutMs: 180_000 });
      row.answers = r.answers;
      row.ms = r.ms;
      row.stateChars = r.stateChars;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
    const i = rows.findIndex((x) => x.key === u.key);
    if (i >= 0) rows[i] = row; else rows.push(row);
    if (++since >= 20) { since = 0; writeFileSync(path, JSON.stringify(rows)); }
  }, 20);
  writeFileSync(path, JSON.stringify(rows));
  const ok = rows.filter((r) => r.answers);
  const l = latency(ok.map((r) => r.ms));
  console.log(`  answered ${ok.length}/${todo0.length}; ms p50 ${l.p50} p95 ${l.p95} max ${l.max}; mean state ${Math.round(ok.reduce((s, r) => s + r.stateChars, 0) / Math.max(ok.length, 1))} chars, mean questions ${(ok.reduce((s, r) => s + r.nQuestions, 0) / Math.max(ok.length, 1)).toFixed(1)}; load1 range ${ok.length ? `${Math.min(...ok.map((r) => r.load1)).toFixed(1)}-${Math.max(...ok.map((r) => r.load1)).toFixed(1)}` : "n/a"} (now ${loadavg().map((v) => v.toFixed(1)).join(" ")})`);
  const failed = rows.filter((r) => !r.answers);
  if (failed.length) console.log(`  FAILED ${failed.length}: ${failed.map((r) => `${r.key} ${r.nQuestions}q ${r.error}`).join("; ")}`);
}

// ---------- scoring ------------------------------------------------------------

interface Item { pair_id: string; phrase: string; score: number; relevance: number; relevant: boolean; hub: string | null }

function items(model: ClefModelKey, all: Pair[]): Item[] | null {
  const path = answersPath(model);
  if (!existsSync(path)) return null;
  const rows = new Map(readCache(path).filter((r) => r.answers).map((r) => [r.key, r]));
  const out: Item[] = [];
  let missing = 0;
  for (const u of units(all)) {
    const row = rows.get(u.key);
    if (!row) { missing += u.mems.length; continue; }
    u.mems.forEach((m, i) => {
      for (const name of Object.keys(PHRASES)) {
        const a = row.answers![`x${i}_${name}`];
        if (a?.type === "score") out.push({ pair_id: m.pair_id, phrase: name, score: a.score, relevance: m.relevance, relevant: m.relevant, hub: m.hub });
      }
    });
  }
  if (missing) console.log(`  ${missing} pairs unrecovered from cache`);
  return out;
}

const f = (x: number, d = 3) => (Number.isNaN(x) ? " n/a" : x.toFixed(d));
const pct = (a: number, b: number) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;

/** Highest-F1 keep threshold; ties go to the higher score, i.e. the stricter gate. */
function bestF1(rows: ReadonlyArray<{ score: number; positive: boolean }>) {
  const cands = [...new Set(rows.map((r) => r.score))].sort((a, b) => a - b);
  let best = { t: cands[0] ?? 0, p: 0, r: 0, f1: -1 };
  for (const t of cands) {
    const kept = rows.filter((r) => r.score >= t);
    const tp = kept.filter((r) => r.positive).length;
    const p = tp / Math.max(kept.length, 1);
    const r = tp / Math.max(rows.filter((x) => x.positive).length, 1);
    const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
    if (f1 >= best.f1 - 1e-12) best = { t, p, r, f1 };
  }
  return best;
}
const prf = (rows: ReadonlyArray<{ score: number; positive: boolean }>, t: number) => {
  const kept = rows.filter((r) => r.score >= t);
  const tp = kept.filter((r) => r.positive).length;
  const pos = rows.filter((r) => r.positive).length;
  const precision = kept.length ? tp / kept.length : Number.NaN;
  const recall = pos ? tp / pos : Number.NaN;
  return {
    pos, kept: kept.length, precision, recall,
    f1: Number.isNaN(precision) || precision + recall === 0 ? Number.NaN : (2 * precision * recall) / (precision + recall),
  };
};

/** Split resampled AUC CI, fixed seed, so a 114-row holdout is not read as exact. */
function aucCi(rows: ReadonlyArray<{ score: number; positive: boolean }>, iters = 500): [number, number] | null {
  if (rows.length < 8) return null;
  let s = 1782;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: number[] = [];
  for (let i = 0; i < iters; i++) {
    const draw = Array.from({ length: rows.length }, () => rows[Math.floor(rnd() * rows.length)]!);
    const a = auc(draw);
    if (!Number.isNaN(a)) out.push(a);
  }
  out.sort((a, b) => a - b);
  return out.length < 50 ? null : [out[Math.floor(0.025 * out.length)]!, out[Math.floor(0.975 * out.length)]!];
}

function report(model: ClefModelKey, full: Pair[], view: Pair[], hook: Map<string, number>): void {
  const list = items(model, full);
  if (!list) { console.log(`\n${CLEF_MODELS[model]}: no cache, run without --report-only`); return; }
  const all = view;
  const byPair = new Map(list.map((x) => [`${x.pair_id}|${x.phrase}`, x]));
  const phrases = Object.keys(PHRASES);
  console.log(`\n=== ${CLEF_MODELS[model]} — ${all.length} pairs, ${all.filter((p) => p.relevant).length} relevant; tune/holdout split by prompt hash ===`);
  console.log("phrasing  split    n   AUC [95% CI]         Spearman  thr     P      R      F1    kept");
  const rowsOf = (ph: string, side: "tune" | "holdout") =>
    all.filter((p) => splitOf(p.prompt) === side).map((p) => byPair.get(`${p.pair_id}|${ph}`)!).filter(Boolean)
      .map((x) => ({ ...x, positive: x.relevant }));

  for (const ph of phrases) {
    const tune = rowsOf(ph, "tune");
    const fit = bestF1(tune);
    for (const side of ["tune", "holdout"] as const) {
      const set = rowsOf(ph, side);
      const a = auc(set);
      const ci = side === "holdout" ? aucCi(set) : null;
      const o = prf(set, fit.t);
      const local = bestF1(set);
      const rho = spearman(set.map((x) => [x.score, x.relevance]));
      console.log(
        `${ph.padEnd(9)} ${side.padEnd(7)} ${String(set.length).padEnd(4)} ${f(a)}${ci ? ` [${f(ci[0], 2)},${f(ci[1], 2)}]`.padEnd(12) : " ".repeat(13)}${f(rho)}  ${f(fit.t, 2)}  ${f(o.precision, 2)}  ${f(o.recall, 2)}  ${f(o.f1, 2)}  ${pct(o.kept, set.length).padStart(7)}${side === "holdout" ? `   (holdout own-best F1 ${f(local.f1, 2)} @ ${f(local.t, 2)})` : ""}`,
      );
    }
  }

  const best = phrases.map((ph) => [ph, auc(rowsOf(ph, "tune"))] as const).sort((a, b) => b[1] - a[1])[0]!;
  const tune = rowsOf(best[0], "tune");
  const fit = bestF1(tune);
  console.log(`  picked "${best[0]}" on tune AUC ${f(best[1])}; threshold ${f(fit.t, 2)} from tune.`);

  // The nightly metric is "what share of what we inject is actually relevant", so the
  // gate is also read as an estimator of that share: kept% vs the labelled share.
  const hold = rowsOf(best[0], "holdout");
  const ho = prf(hold, fit.t);
  const tp = hold.filter((x) => x.score >= fit.t && x.positive).length;
  const fp = hold.filter((x) => x.score >= fit.t && !x.positive).length;
  const fn = hold.filter((x) => x.score < fit.t && x.positive).length;
  const tn = hold.filter((x) => x.score < fit.t && !x.positive).length;
  const pctShare = (n: number) => ((100 * n) / Math.max(hold.length, 1)).toFixed(1);
  const bias = Number(pctShare(ho.kept)) - Number(pctShare(ho.pos));
  console.log(`  holdout at that threshold: TP ${tp} FP ${fp} FN ${fn} TN ${tn}; read as an estimator of the metric it says ${pctShare(ho.kept)}% of injections are relevant vs the labelled ${pctShare(ho.pos)}% (bias ${bias >= 0 ? "+" : ""}${bias.toFixed(1)} pts), precision ${f(ho.precision, 2)} recall ${f(ho.recall, 2)} on the relevant ones.`);
  const a0 = auc(hold);
  // The 0-vs-3 slice separates "can it tell relevant from unrelated" from "can it order
  // the middle", which is where a model-led label and a model judge can disagree by rubric.
  const edge = (side: "tune" | "holdout") => {
    const s = rowsOf(best[0], side).filter((x) => x.relevance === 0 || x.relevance === 3);
    return s.length > 4 ? `${f(auc(s))} (n${s.length})` : "n/a";
  };
  console.log(`  verdict ${model}: holdout AUC ${f(a0)} ${a0 >= 0.8 ? ">=" : "<"} 0.80 → ${a0 >= 0.8 ? "good enough for a nightly relevance-precision metric" : "not good enough"} (phrasing "${best[0]}", threshold from tune only). Edge AUC (label 0 vs 3): tune ${edge("tune")}, holdout ${edge("holdout")}.`);

  console.log("  mean score by labelled relevance (tune | holdout):");
  for (const lvl of [0, 1, 2, 3]) {
    const m = (side: "tune" | "holdout") => {
      const s = rowsOf(best[0], side).filter((x) => x.relevance === lvl);
      return s.length ? `${f(s.reduce((t, x) => t + x.score, 0) / s.length, 2)} (${s.length})` : "n/a";
    };
    console.log(`    ${lvl}: ${m("tune").padStart(12)} | ${m("holdout").padStart(12)}`);
  }

  console.log(`  known hub memories at threshold ${f(fit.t, 2)} (share Clef keeps, vs share the label keeps):`);
  for (const [name] of HUBS) {
    const held = rowsOf(best[0], "holdout").filter((x) => x.hub === name);
    const tun = rowsOf(best[0], "tune").filter((x) => x.hub === name);
    const set = [...tun, ...held];
    if (!set.length) { console.log(`    ${name.padEnd(22)} not in the eval set`); continue; }
    console.log(`    ${name.padEnd(22)} n${String(set.length).padEnd(3)} Clef relevant ${pct(set.filter((x) => x.score >= fit.t).length, set.length).padStart(6)} | labelled relevant ${pct(set.filter((x) => x.positive).length, set.length).padStart(6)} | mean score ${f(set.reduce((s, x) => s + x.score, 0) / set.length, 2)}`);
  }

  const hooked = all.filter((p) => hook.has(p.pair_id));
  if (hooked.length > 0) {
    const partial = hooked.length === all.length ? "" : ` (${hooked.length}/${all.length} pairs joined)`;
    console.log(`  baseline — the hook's own retrieval score, same split and same fit rule${partial}:`);
    const base = all.filter((p) => hook.has(p.pair_id)).map((p) => ({ score: hook.get(p.pair_id)!, positive: p.relevant, relevance: p.relevance, side: splitOf(p.prompt) }));
    const fitB = bestF1(base.filter((x) => x.side === "tune"));
    for (const side of ["tune", "holdout"] as const) {
      const set = base.filter((x) => x.side === side);
      const o = prf(set, fitB.t);
      const ci = side === "holdout" ? aucCi(set) : null;
      console.log(`    ${side.padEnd(7)} n${String(set.length).padEnd(4)} AUC ${f(auc(set))}${ci ? ` [${f(ci[0], 2)},${f(ci[1], 2)}]` : ""} Spearman ${f(spearman(set.map((x) => [x.score, x.relevance])))} | thr ${f(fitB.t, 3)} P ${f(o.precision, 2)} R ${f(o.recall, 2)} kept ${pct(o.kept, set.length)}`);
    }
  } else {
    console.log(`  baseline — skipped: no retrieval score in ${flag("hook-log", "~/.nlm/hook-log.jsonl")}`);
  }
}

// ---------- main ---------------------------------------------------------------

const setPath = flag("eval-set", join(homedir(), ".nxtos/state/t1782/eval-set.jsonl"));
const logPath = flag("hook-log", join(homedir(), ".nlm/hook-log.jsonl"));
const all0 = pairs(setPath);
const capped = all0.filter((_, i) => (flag("limit", "") === "" ? true : i < Number(flag("limit", ""))));
// The hook log records the same (prompt, memory) injection more than once; --dedupe
// keeps the first occurrence so the table does not count one event several times.
const seen = new Set<string>();
const dedupe = process.argv.includes("--dedupe");
const all = dedupe ? capped.filter((p) => {
  const k = `${p.prompt}|${p.memory_id}|${p.hit_rank}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
}) : capped;
const hook = hookScores(all, logPath);
console.log(`eval set ${setPath}: ${all.length} pairs${all.length === capped.length ? "" : ` (--dedupe, from ${capped.length})`}, ${all.filter((p) => p.relevant).length} relevant (relevance ${[0, 1, 2, 3].map((l) => `${l}:${all.filter((p) => p.relevance === l).length}`).join(" ")}), hook score joined ${hook.size}/${all.length}`);

const modelFlag = flag("model", "both");
const which: ClefModelKey[] = modelFlag === "both" ? ["flash", "base"] : [parseModelFlag(["--model", modelFlag])];
const reportOnly = process.argv.includes("--report-only");
for (const model of which) {
  if (!reportOnly) await collect(model, capped);
  report(model, capped, all, hook);
}
console.log(`\ncaches ${readdirSync(DIR).join(" ")}; scratch in ./.eval is gitignored, delete when done`);
