/**
 * T1142 labelling for L1 (Edward), in sittings with resume.
 *   tsx scripts/eval/property-holdout-label.ts <run-dir>               label the next cards
 *   tsx scripts/eval/property-holdout-label.ts <run-dir> --adjudicate  re-read session cards marked unsure
 *   tsx scripts/eval/property-holdout-label.ts <run-dir> --seal        hash labels.json into labels.sealed
 * Type q at any prompt to stop and resume later.
 */
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { pathsIn, readJson } from "./lib/property-holdout-io.js";
import type { Card } from "./lib/property-holdout-cards.js";
import { adjudicate, labelSitting } from "./lib/property-holdout-label-session.js";
import { isSealed, sealLabels } from "./lib/property-holdout-labels.js";

new Command().argument("<run-dir>").option("--seal", "seal the labels").option("--adjudicate", "adjudicate unsure session cards")
  .action(async (dir: string, o: { seal?: boolean; adjudicate?: boolean }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const cards = readJson<{ cards: Card[] }>(pathsIn(dir).cards).cards;
      if (o.seal) { const s = sealLabels(dir, cards, new Date()); console.log(`sealed ${s.cards} labels at ${s.sealedAt}`); return; }
      if (isSealed(dir)) throw new Error("labels are sealed and can no longer change");
      const terminal = { ask: (p: string) => rl.question(p), print: (t: string) => console.log(t) };
      if (o.adjudicate) { console.log(`adjudicated ${await adjudicate(dir, cards, terminal)} cards`); return; }
      const r = await labelSitting(dir, cards, terminal, () => new Date());
      console.log(`\nlabelled ${r.labelled} this sitting, ${r.remaining} remaining`);
    } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; } finally { rl.close(); }
  }).parseAsync();
