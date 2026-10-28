/**
 * T1142 draw (design §4 step 4). Reads a snapshot copy, never the live database.
 *   tsx scripts/eval/property-holdout-draw.ts <snapshot> <catalog.json> <run-dir>
 */
import { Command } from "commander";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { drawHoldout, gitCandidate } from "./lib/property-holdout.js";

new Command().argument("<snapshot>").argument("<catalog>").argument("<run-dir>")
  .option("--tenant <id>", "Tenant", DEFAULT_TEAM_ID)
  .action((snapshot: string, catalog: string, dir: string, o: { tenant: string }) => {
    try {
      const m = drawHoldout({ snapshot, catalogPath: catalog, dir, tenant: o.tenant, now: new Date(), candidate: gitCandidate() });
      console.log(JSON.stringify({ drawnAt: m.draw!.drawnAt, population: m.draw!.population, flags: m.draw!.flags }));
    } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
  }).parse();
