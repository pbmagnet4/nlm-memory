/**
 * Stage A calibration sweep and readout.
 *
 * Joins the frozen sample to the judge labels, sweeps candidate detector
 * configurations across seven dimensions, and writes a report.
 *
 * The sweep compares FEATURE DESIGNS, not thresholds on one feature. The
 * 2026-08-04 ground-truth check found the shipped feature confounded with
 * decision-set size and floated off zero by function words, so "where should
 * the floor go" is the wrong question and the incumbent is scored as one row
 * among alternatives rather than as the baseline everything is tuned around.
 *
 * Usage: npm run eval:rederiv-calibrate
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PairFeatures } from "./lib/re-derivation-features.js";
import {
  paretoFront,
  predicate,
  scoreConfig,
  type LabeledPair,
  type PredicateConfig,
  type Signal,
} from "./lib/re-derivation-scoring.js";

const OUT_DIR = join(process.cwd(), "reports", "re-derivation");
const REPORT_DATE = "2026-08-04";

const SIGNALS: Signal[] = [
  "rawPooled",
  "strippedPooled",
  "rawMaxPair",
  "strippedMaxPair",
  "cosine",
  "max",
];
const FLOORS = [
  ...Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100,
  ),
  0.96,
  0.97,
  0.98,
];
const MIN_TOKENS = [0, 5, 10, 20];
const GAPS = [0, 3, 7, 14, 30];

/** What ships today, per src/core/metrics/re-derivation.ts. */
const INCUMBENT: PredicateConfig = {
  signal: "rawPooled",
  floor: 0.5,
  gapDays: 7,
  requireEntity: true,
  excludeSubagents: false,
  minTokens: 0,
};

interface SampleRow {
  readonly pairId: string;
  readonly stratum: string;
  readonly features: PairFeatures;
  readonly a: { label: string; startedAt: string };
  readonly b: { label: string; startedAt: string };
}

function readJsonl<T>(p: string): T[] {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function pct(n: number): string {
  return `${(100 * n).toFixed(1)}%`;
}

function describe(c: PredicateConfig): string {
  const bits = [`${c.signal ?? "strippedPooled"} >= ${c.floor}`];
  if (c.minTokens) bits.push(`minTok ${c.minTokens}`);
  bits.push(`gap ${c.gapDays ?? 0}d`);
  if (c.requireEntity) bits.push("entity");
  if (c.excludeSubagents) bits.push("no-subagent");
  return bits.join(", ");
}

function main(): void {
  const frameRaw = JSON.parse(readFileSync(join(OUT_DIR, "frame.json"), "utf8")) as {
    window: { lo: string; hi: string; days: number };
    corpus: { sessionsInWindow: number; decisionBearing: number };
    detectorEligible: number;
    decisionlessSidePairs: number;
    frameSize: number;
    strata: Record<string, { definition: string; population: number; quota: number; drawn: number }>;
    embedModel: string;
    zeroEntityUncovered: number;
  };
  const sample = new Map(readJsonl<SampleRow>(join(OUT_DIR, "sample.jsonl")).map((r) => [r.pairId, r]));
  const labels = readJsonl<{
    pairId: string;
    stratum: string;
    verdict: { label: string; confidence: number; reason: string } | null;
  }>(join(OUT_DIR, "labels.jsonl"));

  const frame: Record<string, { population: number; drawn: number }> = {};
  for (const [k, v] of Object.entries(frameRaw.strata)) {
    frame[k] = { population: v.population, drawn: v.drawn };
  }

  const labeled: LabeledPair[] = [];
  const dist = new Map<string, number>();
  const byStratum = new Map<string, { n: number; genuine: number }>();
  let unparsed = 0;
  for (const l of labels) {
    if (!l.verdict) {
      unparsed++;
      continue;
    }
    dist.set(l.verdict.label, (dist.get(l.verdict.label) ?? 0) + 1);
    const row = sample.get(l.pairId);
    if (!row) continue;
    const genuine = l.verdict.label === "GENUINE";
    labeled.push({ stratum: l.stratum, genuine, features: row.features });
    const s = byStratum.get(l.stratum) ?? { n: 0, genuine: 0 };
    s.n++;
    if (genuine) s.genuine++;
    byStratum.set(l.stratum, s);
  }

  // Sweep.
  const results: Array<{ config: PredicateConfig; precision: number; recall: number; f1: number; precisionCI: readonly [number, number]; recallCI: readonly [number, number]; weightedTP: number; weightedFP: number; weightedFN: number }> = [];
  for (const signal of SIGNALS) {
    for (const floor of FLOORS) {
      for (const minTokens of MIN_TOKENS) {
        for (const gapDays of GAPS) {
          for (const requireEntity of [true, false]) {
            for (const excludeSubagents of [false, true]) {
              const config: PredicateConfig = {
                signal,
                floor,
                minTokens,
                gapDays,
                requireEntity,
                excludeSubagents,
              };
              const r = scoreConfig(labeled, frame, config);
              results.push({ config, ...r });
            }
          }
        }
      }
    }
  }

  const inc = scoreConfig(labeled, frame, INCUMBENT);
  const incFires = labeled.filter((l) => predicate(INCUMBENT)(l.features));

  const firing = results.filter((r) => r.weightedTP + r.weightedFP > 0);
  const pareto = paretoFront(firing);
  const bestF1 = [...firing].sort((a, b) => b.f1 - a.f1)[0];
  const highPrec = [...firing]
    .filter((r) => r.precisionCI[0] >= 0.5)
    .sort((a, b) => b.recall - a.recall)[0];

  const genuineRows = labels.filter((l) => l.verdict?.label === "GENUINE");

  const L: string[] = [];
  L.push(`# Stage A: re-derivation detector calibration`);
  L.push("");
  L.push(`Date: ${REPORT_DATE}. Spec: \`docs/superpowers/specs/2026-08-04-stage-a-detector-calibration-design.md\`.`);
  L.push("");
  L.push(`> **PROVISIONAL.** Every number below rests on judge labels that have not yet`);
  L.push(`> been checked by a human. With ${genuineRows.length} positives across ${labeled.length} labelled pairs, the`);
  L.push(`> population estimate is dominated by a handful of labels in heavily-upweighted`);
  L.push(`> strata. Do not pick a threshold from this until \`spot-check.md\` comes back.`);
  L.push("");

  L.push(`## Identities and settings`);
  L.push("");
  L.push(`- Window frozen: \`${frameRaw.window.lo}\` .. \`${frameRaw.window.hi}\` (${frameRaw.window.days}d)`);
  L.push(`- Corpus in window: ${frameRaw.corpus.sessionsInWindow.toLocaleString()} sessions, ${frameRaw.corpus.decisionBearing.toLocaleString()} decision-bearing`);
  L.push(`- Judge: \`google/gemma-4-26b-a4b-qat\`, temperature 0, max_tokens 400, reasoning_effort none, blind`);
  L.push(`- Consistency: \`qwen/qwen3.6-35b-a3b\`, 30/30 binary agreement`);
  L.push(`- Embedder: \`${frameRaw.embedModel}\``);
  L.push(`- Labelled: ${labeled.length} of ${labels.length}; unparseable verdicts excluded: ${unparsed}`);
  L.push("");

  L.push(`## Finding D confirmed at full scale`);
  L.push("");
  L.push(`The shipped detector counts a pair as eligible on entity-sharing before it looks`);
  L.push(`at decisions:`);
  L.push("");
  L.push(`- detector-eligible pairs: **${frameRaw.detectorEligible.toLocaleString()}**`);
  L.push(`- of those, at least one side carries zero decisions: **${frameRaw.decisionlessSidePairs.toLocaleString()}** (${pct(frameRaw.decisionlessSidePairs / frameRaw.detectorEligible)})`);
  L.push(`- labelable frame after removing them: **${frameRaw.frameSize.toLocaleString()}**`);
  L.push("");
  L.push(`Two thirds of the reported denominator is pairs that can never be a positive.`);
  L.push(`This is independent of the unit question and can be fixed on its own (#427).`);
  L.push("");

  L.push(`## Label distribution`);
  L.push("");
  L.push(`| label | n | share |`);
  L.push(`|---|---:|---:|`);
  for (const [k, v] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    L.push(`| ${k} | ${v} | ${pct(v / labeled.length)} |`);
  }
  L.push("");
  L.push(`| stratum | definition | population | drawn | weight | GENUINE |`);
  L.push(`|---|---|---:|---:|---:|---:|`);
  for (const [k, v] of Object.entries(frameRaw.strata)) {
    const s = byStratum.get(k) ?? { n: 0, genuine: 0 };
    const w = v.drawn ? v.population / v.drawn : 0;
    L.push(`| ${k} | ${v.definition} | ${v.population.toLocaleString()} | ${v.drawn} | ${w.toFixed(1)} | ${s.genuine} |`);
  }
  L.push("");

  L.push(`## The incumbent configuration`);
  L.push("");
  L.push(`\`${describe(INCUMBENT)}\` - what \`src/core/metrics/re-derivation.ts\` ships today.`);
  L.push("");
  L.push(`| metric | value | 95% interval |`);
  L.push(`|---|---:|---|`);
  L.push(`| precision | ${pct(inc.precision)} | [${pct(inc.precisionCI[0])}, ${pct(inc.precisionCI[1])}] |`);
  L.push(`| recall | ${pct(inc.recall)} | [${pct(inc.recallCI[0])}, ${pct(inc.recallCI[1])}] |`);
  L.push(`| weighted TP / FP / FN | ${inc.weightedTP.toFixed(0)} / ${inc.weightedFP.toFixed(0)} / ${inc.weightedFN.toFixed(0)} | |`);
  L.push("");
  L.push(`It fires on ${incFires.length} of the ${labeled.length} labelled pairs.`);
  L.push("");

  L.push(`## Every GENUINE the judge found`);
  L.push("");
  L.push(`This is the whole positive class. It is small enough to read, and reading it is`);
  L.push(`the point: a threshold recommendation derived from these without checking them`);
  L.push(`would be an artifact of a handful of judge calls.`);
  L.push("");
  L.push(`| stratum | J' | cosine | gap | subagent sides | earlier | later |`);
  L.push(`|---|---:|---:|---:|---:|---|---|`);
  for (const l of genuineRows) {
    const r = sample.get(l.pairId);
    if (!r) continue;
    const f = r.features;
    L.push(
      `| ${l.stratum} | ${f.strippedPooledJaccard.toFixed(2)} | ${(f.maxPairCosine ?? 0).toFixed(2)} | ${f.gapDays.toFixed(0)}d | ${f.subagentSides} | ${r.a.startedAt.slice(0, 10)} ${r.a.label} | ${r.b.startedAt.slice(0, 10)} ${r.b.label} |`,
    );
  }
  L.push("");

  L.push(`## Recommended operating points`);
  L.push("");
  L.push(`Two different numbers, per open question 3 of the parent spec. The counting`);
  L.push(`threshold feeds the metric; the firing threshold gates an interrupt, where a`);
  L.push(`false positive costs operator attention rather than a rounding error.`);
  L.push("");
  L.push(`| purpose | configuration | precision | recall | F1 |`);
  L.push(`|---|---|---:|---:|---:|`);
  if (bestF1) L.push(`| counting (best F1) | \`${describe(bestF1.config)}\` | ${pct(bestF1.precision)} | ${pct(bestF1.recall)} | ${bestF1.f1.toFixed(3)} |`);
  if (highPrec) L.push(`| firing (precision LB >= 50%) | \`${describe(highPrec.config)}\` | ${pct(highPrec.precision)} | ${pct(highPrec.recall)} | ${highPrec.f1.toFixed(3)} |`);
  L.push("");

  L.push(`## Pareto front`);
  L.push("");
  L.push(`${pareto.length} of ${firing.length} firing configurations are undominated on both precision and recall.`);
  L.push("");
  L.push(`| configuration | precision | recall | F1 |`);
  L.push(`|---|---:|---:|---:|`);
  for (const r of [...pareto].sort((a, b) => b.f1 - a.f1).slice(0, 15)) {
    L.push(`| \`${describe(r.config)}\` | ${pct(r.precision)} | ${pct(r.recall)} | ${r.f1.toFixed(3)} |`);
  }
  L.push("");

  L.push(`## Limitations, declared before the numbers are read`);
  L.push("");
  L.push(`1. **The labels are unchecked.** ${genuineRows.length} positives carry the entire result. See spot-check.md.`);
  L.push(`2. **Recall is conditional on this frame.** ${frameRaw.zeroEntityUncovered.toLocaleString()} zero-entity pairs were never sampled and are not represented in any denominator here.`);
  L.push(`3. **A1 is 53 pairs.** The incumbent's precision interval is wide no matter what, because that is how few pairs it fires on.`);
  L.push(`4. **Weighted estimates are fragile at this base rate.** A single label in A4 or A5 moves the population estimate by thousands, which is why the intervals use a Kish effective sample size rather than raw n.`);
  L.push(`5. **The judge over-calls GENUINE on recurring work.** Two rubric passes removed standing-policy compliance and scheduled reviews; same-day near-identical sessions are still occasionally called GENUINE rather than DUPLICATE.`);
  L.push("");

  writeFileSync(join(OUT_DIR, `${REPORT_DATE}-stage-a-calibration.md`), `${L.join("\n")}\n`);
  writeFileSync(
    join(OUT_DIR, `${REPORT_DATE}-stage-a-calibration.json`),
    `${JSON.stringify(
      {
        provisional: true,
        frame: frameRaw,
        labelDistribution: Object.fromEntries(dist),
        labelled: labeled.length,
        incumbent: { config: INCUMBENT, ...inc },
        bestF1: bestF1 ? { config: bestF1.config, precision: bestF1.precision, recall: bestF1.recall, f1: bestF1.f1 } : null,
        firing: highPrec ? { config: highPrec.config, precision: highPrec.precision, recall: highPrec.recall, f1: highPrec.f1 } : null,
        paretoCount: pareto.length,
        configurationsSwept: results.length,
      },
      null,
      2,
    )}\n`,
  );

  process.stderr.write(
    `swept ${results.length} configurations; incumbent precision ${pct(inc.precision)} recall ${pct(inc.recall)}\n`,
  );
}

main();
