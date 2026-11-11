/**
 * T1142 scorer (design §4 step 5). Refuses on any hash mismatch or a missing seal.
 *   tsx scripts/eval/property-holdout-score.ts <run-dir>
 */
import { Command } from "commander";
import { scoreHoldout } from "./lib/property-holdout-score.js";

new Command().argument("<run-dir>").action((dir: string) => {
  try {
    const s = scoreHoldout(dir, new Date());
    console.log(JSON.stringify({ q1: s.q1, q2: { references: s.q2.references, postStratified: s.q2.postStratified, passed: s.q2.passed }, gatesPassed: s.decision.gatesPassed }));
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}).parse();
