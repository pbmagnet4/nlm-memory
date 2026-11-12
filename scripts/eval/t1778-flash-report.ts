/**
 * T1778 — fit and report. Read-only over the caches in ./.eval; prints the tables for
 * docs/eval/T1778-clef-flash.md, and with --e4 runs the E4 contradiction probe once.
 *
 * Every threshold or logistic model is fitted per model on the tune split (fixed hash
 * of the row id, scripts/eval/lib/clef-stats.ts) and only then read on holdout.
 *
 * Run: npx tsx scripts/eval/t1778-flash-report.ts [--e4]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClefAnswer, ClefQuestion } from "../../src/llm/clef-client.js";
import { gateFeatures } from "../../src/core/classifier/gate-model.js";
import { CLEF_MODELS, askClefDirect, clefBaseUrl, latency, mapPool, type ClefModelKey } from "./lib/clef-direct.js";
import { auc, splitOf, wilson } from "./lib/clef-stats.js";
import { fitLogReg } from "./lib/logreg.js";

const EVAL = join(import.meta.dirname, "../../.eval");
const read = <T,>(p: string): T => JSON.parse(readFileSync(join(EVAL, p), "utf8")) as T;
const f = (x: number, d = 3) => (Number.isNaN(x) ? "  n/a" : x.toFixed(d));
const pct = (a: number, b: number) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;

interface GateRow { id: string; set: string; runtime: string; chars: number; decisions: number; facts: number; answers: Record<string, ClefAnswer> | null; ms: number }
interface ItemRow { key: string; ms: number; stateChars: number; answers: Record<string, ClefAnswer> | null }

// ---------- E1: the ingest gate, refitted per model -----------------------------
function e1(): void {
  console.log("\n=== E1 ingest gate: same 1,220 sessions, same panel, per-model fit ===");
  const sets: Array<[string, GateRow[]]> = [["27B clef-oQ4e", read<GateRow[]>("gate-answers-27b.json")]];
  const flashPath = join(EVAL, "flash/gate-answers-flash.json");
  if (existsSync(flashPath)) sets.push(["flash clef-flash-oQ8e", read<GateRow[]>(flashPath)]);
  const worthwhile = new Map(read<{ id: string; importance: number }[]>("labels-final.json").map((l) => [l.id, l.importance >= 2]));

  for (const [name, rows0] of sets) {
    const seen = new Set<string>();
    const rows = rows0.filter((r) => r.answers && !seen.has(r.id) && seen.add(r.id));
    const scored = rows.map((row) => ({
      row, x: gateFeatures(row.answers!, row.chars), y: row.decisions + row.facts > 0 ? 1 : 0,
      imp: (row.answers!["importance"] as { score: number }).score,
    }));
    const train = scored.filter((s) => s.row.set !== "audited" && splitOf(s.row.id) === "tune");
    const fit = fitLogReg(train.map((s) => s.x), train.map((s) => s.y), { l2: 0.01, iters: 4000, lr: 0.3 });
    const p = (s: (typeof scored)[number]) => {
      let z = fit.bias;
      for (let j = 0; j < fit.weights.length; j++) z += fit.weights[j]! * ((s.x[j]! - fit.mean[j]!) / fit.std[j]!);
      return 1 / (1 + Math.exp(-z));
    };
    let threshold = 0;
    for (const t of [...new Set(train.map(p))].sort((a, b) => a - b)) {
      const sk = train.filter((s) => p(s) < t);
      if (sk.reduce((n, s) => n + s.row.decisions, 0) <= 0.005 * train.reduce((n, s) => n + s.row.decisions, 0)
        && sk.reduce((n, s) => n + s.row.facts, 0) <= 0.025 * train.reduce((n, s) => n + s.row.facts, 0)) threshold = t;
      else break;
    }
    console.log(`\n${name}: ${rows.length} answered (${train.length} tune); fitted skip threshold P(stored) < ${f(threshold)}`);
    const groups: Array<[string, typeof scored, boolean]> = [
      ["yield holdout", scored.filter((s) => s.row.set === "yield" && splitOf(s.row.id) === "holdout"), false],
      ["live holdout", scored.filter((s) => s.row.set === "live" && splitOf(s.row.id) === "holdout"), false],
      ["audited all", scored.filter((s) => s.row.set === "audited"), true],
    ];
    for (const [label, set, audited] of groups) {
      if (!set.length) continue;
      for (const [g, skip, sc] of [["fitted", (s: typeof set[number]) => p(s) < threshold, p], ["imp<1.5", (s: typeof set[number]) => s.imp < 1.5, (s: typeof set[number]) => s.imp]] as const) {
        const sk = set.filter(skip);
        console.log(`  ${label.padEnd(13)} ${g.padEnd(7)} n${String(set.length).padEnd(4)} AUC ${f(auc(set.map((s) => ({ score: sc(s), positive: s.y === 1 }))))} | skip ${pct(sk.length, set.length)} | dec lost ${pct(sk.reduce((n, s) => n + s.row.decisions, 0), set.reduce((n, s) => n + s.row.decisions, 0))} | facts lost ${pct(sk.reduce((n, s) => n + s.row.facts, 0), set.reduce((n, s) => n + s.row.facts, 0))}`);
        if (audited && g === "fitted") {
          const pos = set.filter((s) => worthwhile.get(s.row.id));
          const miss = pos.filter((s) => p(s) < threshold).length;
          console.log(`                audited-worthwhile skipped ${miss}/${pos.length}, kept lower bound ${(100 * wilson(pos.length - miss, pos.length)[0]).toFixed(0)}%`);
        }
      }
    }
  }

  const probePath = join(EVAL, "gate-latency-probe.json");
  if (!existsSync(probePath)) return;
  const entries = Object.values(read<Record<string, { chars: number; ms: Record<string, number> }>>(probePath));
  console.log(`\n  serial cost probe (${entries.length} sessions across the length range, one call at a time):`);
  for (const key of ["flash", "base"] as ClefModelKey[]) {
    const all = latency(entries.map((e) => e.ms[key]!));
    const small = latency(entries.filter((e) => e.chars < 8000).map((e) => e.ms[key]!));
    const big = latency(entries.filter((e) => e.chars >= 8000).map((e) => e.ms[key]!));
    console.log(`  ${key.padEnd(6)} p50 ${all.p50}ms p95 ${all.p95}ms | <8k chars p50 ${small.p50}ms (${small.n}) | >=8k p50 ${big.p50}ms (${big.n}) | mean ${Math.round(all.total / all.n)}ms -> ${((all.total / all.n / 1000) * 1220 / 60).toFixed(0)} min serially per 1,220 sessions`);
  }
}

// ---------- E2 / E3: one score question per thing, one state read ---------------
function truthOf(task: "e2" | "e3"): Map<string, boolean[]> {
  if (task === "e2") {
    const gold = readFileSync(join(EVAL, "gold-usefulness.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { key: string; gold: string });
    return new Map(gold.map((g) => [g.key, [g.gold !== "unused"]]));
  }
  const rows = readFileSync(join(EVAL, "precision-sample.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { i: number; verdict: string; statements: string[] });
  return new Map(rows.map((r) => [String(r.i), r.statements.map((s) => s !== undefined && r.verdict === "CORRECT")]));
}

function gate(task: "e2" | "e3"): void {
  console.log(`\n=== ${task === "e2" ? "E2 recall relevance gate (labels: context used, not on-topic)" : "E3 populate informativeness gate (labels: line correct for the page)"} ===`);
  const truth = truthOf(task);
  for (const model of ["flash", "base"] as ClefModelKey[]) {
    const path = join(EVAL, `relevance/${task}-${model}.json`);
    if (!existsSync(path)) { console.log(`  ${model}: not collected yet`); continue; }
    const rows = read<ItemRow[]>(path).filter((r) => r.answers);
    const items = rows.flatMap((r) => Object.entries(r.answers!).flatMap(([k, a]) => {
      const i = Number(k.slice(1, k.indexOf("_")));
      const pos = (truth.get(r.key) ?? [])[i];
      if (pos === undefined || a.type !== "score") return [];
      return [{ key: r.key, i, phrase: k.slice(k.indexOf("_") + 1), s: a.score, pos }];
    }));
    const phrases = [...new Set(items.map((x) => x.phrase))];
    const tuneAuc = new Map(phrases.map((ph) => [ph, auc(items.filter((x) => x.phrase === ph && splitOf(x.key) === "tune").map((x) => ({ score: x.s, positive: x.pos })))]));
    const best = [...tuneAuc.entries()].sort((a, b) => b[1] - a[1])[0]!;
    console.log(`  ${model} (picked "${best[0]}"): tune AUC ${[...tuneAuc.entries()].map(([k, v]) => `${k} ${f(v)}`).join(" ")}`);
    for (const which of ["tune", "holdout"] as const) {
      const set = items.filter((x) => x.phrase === best[0] && (splitOf(x.key) === "tune") === (which === "tune"));
      if (!set.length) continue;
      const pos = set.filter((x) => x.pos), neg = set.filter((x) => !x.pos);
      const a = auc(set.map((x) => ({ score: x.s, positive: x.pos })));
      let thr = 0;
      for (const t of [...new Set(set.map((x) => x.s))].sort((x, y) => x - y)) {
        if (task === "e3" ? pos.filter((x) => x.s >= t).length >= 0.8 * pos.length : pos.every((x) => x.s >= t)) thr = t;
        else break;
      }
      const keep = set.filter((x) => x.s >= thr);
      const keptPos = pos.filter((x) => x.s >= thr).length;
      if (task === "e3") {
        console.log(`    ${which.padEnd(7)} n${set.length} (${pos.length} correct) AUC ${f(a)} | thr ${f(thr, 2)} keeps ${pct(keptPos, pos.length)} of CORRECT, precision ${f(keep.length ? keep.filter((x) => x.pos).length / keep.length : NaN)} (drops ${pct(neg.length - neg.filter((x) => x.s >= thr).length, neg.length)} of wrong)`);
      } else {
        console.log(`    ${which.padEnd(7)} n${set.length} (${pos.length} informed) AUC ${f(a)} | thr ${f(thr, 2)} keeps 100% of informed, skips ${pct(neg.filter((x) => x.s < thr).length, neg.length)} of unused`);
      }
    }
    const l = latency(rows.map((r) => r.ms).filter((v) => v > 0));
    console.log(`    calls: ${rows.length}, mean state ${Math.round(rows.reduce((s, r) => s + r.stateChars, 0) / rows.length)} chars, ms as collected (contended) p50 ${l.p50} p95 ${l.p95}`);
  }
}

// ---------- E4: dream contradiction proposals ----------------------------------
interface Finding { subject: string; predicate: string; value: string; verdict: string; evidenceQuote: string }

async function e4(run: boolean): Promise<void> {
  console.log("\n=== E4 dream contradiction judge ===");
  const sets = [["resample500", read<{ findings: Finding[]; summary: Record<string, number> }>("dream-resample500.json")], ["dryrun150", read<{ findings: Finding[]; summary: Record<string, number> }>("dream-dryrun150.json")]] as const;
  const contradicted: Finding[] = [], stillTrue: Finding[] = [];
  for (const [, d] of sets) for (const x of d.findings) (x.verdict === "contradicted" ? contradicted : x.verdict === "still-true" ? stillTrue : []).push(x);
  for (const [name, d] of sets) console.log(`  ${name}: ${Object.entries(d.summary).filter(([k]) => ["sampled", "judged", "contradicted", "stillTrue", "unverifiable", "errors"].includes(k)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  proposals with a quoted line: ${contradicted.length} contradicted, ${stillTrue.length} still-true; every label is the 12B judge's own verdict, no human label exists`);
  if (!run) return;
  const probes = [...contradicted, ...stillTrue.slice(0, 12)];
  const questions: Record<string, ClefQuestion> = {
    contradict: { type: "noul", instructions: "Do the fact and the quoted line from its own source session contradict each other?", criteria: { true: "The line denies the fact, supersedes it, or states a different value for the same thing", false: "The line agrees with the fact or says nothing about it" } },
    degree: { type: "score", instructions: "How strongly do the fact and the quoted line conflict?", criteria: ["No conflict: the line agrees with the fact or is silent about it", "Tension: related, but both could be true", "Probable conflict: the line points to a different value", "Direct conflict: the line states a different value for the same thing"] },
  };
  const out: Record<string, unknown[]> = {};
  for (const key of ["flash", "base"] as ClefModelKey[]) {
    const rows = await mapPool(probes, 1, async (p) => {
      const r = await askClefDirect({ fact: `${p.subject} ${p.predicate}: ${p.value}`, quoted_line: p.evidenceQuote }, questions, { baseUrl: clefBaseUrl(), model: CLEF_MODELS[key], timeoutMs: 60_000 });
      const nl = r.answers["contradict"], sc = r.answers["degree"];
      return { verdict: p.verdict, noul: nl?.type === "noul" ? nl.noul : -1, score: sc?.type === "score" ? sc.score : -1, ms: r.ms };
    }, 25);
    out[key] = rows;
    const pos = rows.filter((r) => r.verdict === "contradicted"), neg = rows.filter((r) => r.verdict === "still-true");
    const rank = (k: "noul" | "score") => pos.length * neg.length === 0 ? Number.NaN
      : pos.reduce((s, p) => s + neg.reduce((t, n) => t + (p[k] > n[k] ? 1 : p[k] === n[k] ? 0.5 : 0), 0), 0) / (pos.length * neg.length);
    const l = latency(rows.map((r) => r.ms));
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    console.log(`  ${CLEF_MODELS[key]}: ranks the judge's own contradicted pairs above its still-true ones with AUC noul ${f(rank("noul"))}, score ${f(rank("score"))} | p50 ${l.p50}ms p95 ${l.p95}ms`);
    console.log(`    medians noul ${med(pos.map((r) => r.noul))} vs ${med(neg.map((r) => r.noul))}; score ${med(pos.map((r) => r.score))} vs ${med(neg.map((r) => r.score))}`);
  }
  writeFileSync(join(EVAL, "e4-probe.json"), JSON.stringify(out, null, 1));
}

e1();
gate("e2");
gate("e3");
await e4(process.argv.includes("--e4"));
