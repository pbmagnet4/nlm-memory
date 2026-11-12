/**
 * T1778 E4 — Clef as a second opinion on the dream contradiction proposals.
 *
 * The T1609 dry runs (scripts/eval/dream-contradiction-dryrun.ts) flagged a
 * handful of active facts as contradicted by their own source transcript. The
 * 500-sample run was then relabeled by hand from the transcript excerpts and
 * landed at 3 TP / 3 FP — 50 % against a 90 % auto-apply gate, so the pass is
 * triage-only today. The labels are quoted from the vault change history
 * (Operations/Tool Lessons/nlm-memory.md, "2026-11-09 — Dreaming passes
 * shipped"); nothing here invents a label.
 *
 * Clef is asked the narrow question an adoption gate would actually ask, given
 * the same evidence the reviewer read: does THIS quote contradict THIS fact? It
 * does not get the whole transcript, so this is not a re-judge of the gemma
 * pass — it scores a cheap confirm/deny layer sitting on top of it.
 *
 * Run: npx tsx scripts/eval/t1778-e4-dream.ts [--model=both]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, loadAvg, pctl, warm, type ClefModel } from "./lib/t1778-clef.js";
import { dreamQuestions, dreamState, type DreamVariant } from "./lib/t1778-questions.js";
import { auc } from "./lib/t1778-stats.js";

type Label = "TP" | "FP" | "unlabeled";
interface Pair { factId: string; label: Label; labelSource: string; fact: string; evidence: string; run: string }
interface Row { factId: string; label: Label; model: string; variant: string; score: number; pContradict: number; ms: number; error?: string }

const LABELED: Record<string, { label: Label; why: string }> = {
  fact_25e09a4d: { label: "TP", why: "Journey-declutter reversal" },
  fact_fea4f038: { label: "TP", why: "TRIBE misdescription" },
  fact_b80fda6f: { label: "TP", why: "KNXT live-vs-building" },
  fact_0514df08: { label: "FP", why: "fail-soft/fail-safe agreement" },
  fact_c2649904: { label: "FP", why: "stale NavFlow-elimination quote" },
  fact_8bb517fc: { label: "FP", why: "spec-instruction-as-negation" },
};

const VARIANTS: DreamVariant[] = ["D1_noul", "D2_score", "D3_noulStrict"];
const arg = (k: string, def: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? def;
const dir = join(import.meta.dirname, "../../.eval/dream");
mkdirSync(dir, { recursive: true });

interface Finding { factId: string; subject: string; predicate: string; value: string; evidenceQuote?: string; verdict?: string; model?: string }
function findings(file: string, run: string): Pair[] {
  const doc = JSON.parse(readFileSync(join(import.meta.dirname, "../../.eval", file), "utf8")) as { findings: Finding[] };
  return doc.findings
    .filter((f) => f.verdict === "contradicted")
    .map((f) => {
      const id = f.factId.slice(0, 13);
      const lab = LABELED[id] ?? { label: "unlabeled" as Label, why: "no human label in the change history" };
      return {
        factId: id, label: lab.label, labelSource: lab.why, run,
        fact: `${f.subject} ${f.predicate}: ${f.value}`,
        evidence: f.evidenceQuote ?? "",
      };
    });
}

const pairs = [...findings("dream-resample500.json", "resample500"), ...findings("dream-dryrun150.json", "dryrun150")];
console.log(`E4 — ${pairs.length} contradicted proposals; labels: ${pairs.map((p) => `${p.factId}:${p.label}`).join(" ")}`);

const models: ClefModel[] = arg("model", "both") === "both" ? ["clef-flash-oQ8e", "clef-oQ4e"] : [arg("model", "") as ClefModel];
const out: Row[] = existsSync(join(dir, "rows.json")) ? (JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")) as Row[]) : [];
const have = new Set(out.map((r) => `${r.factId}|${r.model}|${r.variant}`));

for (const model of models) {
  console.log(`warm ${model} ${await warm(model)} ms, load ${loadAvg()}`);
  for (const variant of VARIANTS) {
    const ms: number[] = [];
    for (const p of pairs) {
      if (have.has(`${p.factId}|${model}|${variant}`)) continue;
      try {
        const r = await ask(model, dreamState(p), dreamQuestions(variant));
        const a = r.answers["contradict"];
        const probs = a && a.type !== "noul" ? a.probabilities : {};
        const pHigh = (probs["2"] ?? 0) + (probs["3"] ?? 0);
        const score = a?.type === "noul" ? a.noul : a?.type === "score" ? a.score : Number.NaN;
        out.push({ factId: p.factId, label: p.label, model, variant, score, pContradict: a?.type === "noul" ? a.noul : pHigh, ms: r.ms });
        ms.push(r.ms);
      } catch (e) {
        out.push({ factId: p.factId, label: p.label, model, variant, score: Number.NaN, pContradict: 0, ms: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }
    writeFileSync(join(dir, "rows.json"), JSON.stringify(out));
    if (ms.length) console.log(`  ${model} ${variant}: ${ms.length} calls, p50 ${pctl(ms, 0.5)} ms`);
  }
}

console.log(`\nfact | label (why) | then per model/variant score`);
for (const p of pairs) {
  const cells = models.flatMap((m) => VARIANTS.map((v) => {
    const r = out.find((x) => x.factId === p.factId && x.model === m && x.variant === v);
    if (!r || !Number.isFinite(r.score)) return "  --  ";
    return `${v.slice(0, 2)} ${r.score.toFixed(2)}`;
  }));
  console.log(`  ${p.factId} ${p.label.padEnd(9)} ${p.run.padEnd(12)} ${p.fact.slice(0, 46).padEnd(48)} | ${cells.join(" | ")}`);
}
console.log(`\nAUC of the contradict signal vs TP/FP (labelled pairs only, n small):`);
for (const m of models) {
  for (const v of VARIANTS) {
    const rows = out.filter((r) => r.model === m && r.variant === v && r.label !== "unlabeled" && Number.isFinite(r.score));
    const byId = new Map(pairs.map((p) => [p.factId, p]));
    const scored = rows.map((r) => ({ score: r.pContradict, positive: byId.get(r.factId)!.label === "TP" }));
    const tp = scored.filter((s) => s.positive), fp = scored.filter((s) => !s.positive);
    const agree = `${tp.map((t) => t.score.toFixed(2)).join(",")} vs ${fp.map((t) => t.score.toFixed(2)).join(",")}`;
    console.log(`  ${m.padEnd(16)} ${v.padEnd(15)} AUC ${auc(scored).toFixed(3)} (t ${tp.length} f ${fp.length})  TP:${agree}`);
  }
}
