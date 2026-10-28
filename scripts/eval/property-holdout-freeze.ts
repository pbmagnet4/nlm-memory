/**
 * T1142 freeze (design §4 steps 1-3) and window census.
 *   freeze: tsx scripts/eval/property-holdout-freeze.ts <snapshot> <catalog.json> <run-dir> --t1130 <T1130-dir>
 *   count:  tsx scripts/eval/property-holdout-freeze.ts <snapshot> <catalog.json> <run-dir> --count
 * --count prints the admissible proposal count and nothing else.
 */
import { join } from "node:path";
import { Command } from "commander";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { countProposals, freezeHoldout, gitCandidate } from "./lib/property-holdout.js";

new Command().argument("<snapshot>").argument("<catalog>").argument("<run-dir>")
  .option("--t1130 <dir>", "T1130 evaluation directory holding sample.json and literal-sample.json")
  .option("--count", "print the proposal count on the window and nothing else")
  .option("--tenant <id>", "Tenant", DEFAULT_TEAM_ID)
  .action((snapshot: string, catalog: string, dir: string, o: { t1130?: string; count?: boolean; tenant: string }) => {
    try {
      if (o.count) { console.log(countProposals(snapshot, catalog, dir, o.tenant, gitCandidate())); return; }
      if (!o.t1130) throw new Error("--t1130 <dir> is required to freeze");
      const m = freezeHoldout({ snapshot, catalogPath: catalog, dir, tenant: o.tenant, now: new Date(), candidate: gitCandidate(),
        sampleFiles: [join(o.t1130, "sample.json"), join(o.t1130, "literal-sample.json")] });
      console.log(JSON.stringify({ freezeAt: m.freezeAt, candidate: m.candidate, windowCloseRule: m.windowCloseRule, exclusions: m.exclusions }));
    } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
  }).parse();
