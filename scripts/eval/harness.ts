/**
 * Shared eval harness CLI (T731). See docs/eval-harness.md.
 *
 *   tsx scripts/eval/harness.ts goldens <snapshotDir> [--fact-sample=400]
 *   tsx scripts/eval/harness.ts run <snapshotDir> [--modes=keyword,semantic,hybrid] [--out=report.json]
 *   tsx scripts/eval/harness.ts compare <baseline.json> <candidate.json>
 *
 * `run` prints the JSON on stdout and a table on stderr. `compare` exits 2 when
 * any fact R@1 regresses (plan rule 4).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import { compareReports, formatComparison } from "../../src/core/eval/harness/compare.js";
import { buildGoldens, formatReport, runHarness, type HarnessReport } from "../../src/core/eval/harness/run.js";
import { summarizeGoldens } from "../../src/core/eval/harness/goldens.js";
import type { RecallMode } from "../../src/shared/types.js";

const [cmd, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const load = (p: string): HarnessReport => JSON.parse(readFileSync(p, "utf8")) as HarnessReport;

async function main(): Promise<void> {
  if (cmd === "goldens" && positional[0]) {
    const g = buildGoldens(positional[0], { factSample: Number(flag("fact-sample") ?? 400) });
    console.log(
      JSON.stringify({
        session: summarizeGoldens(g.session),
        factTopic: summarizeGoldens(g.factTopic),
        factCitation: summarizeGoldens(g.factCitation),
      }),
    );
  } else if (cmd === "run" && positional[0]) {
    const modes = (flag("modes") ?? "keyword,semantic,hybrid").split(",") as RecallMode[];
    const report = await runHarness(positional[0], { modes, embedder: buildEmbedder() });
    const out = flag("out");
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    console.error(formatReport(report));
    console.log(JSON.stringify(report));
  } else if (cmd === "compare" && positional[0] && positional[1]) {
    const c = compareReports(load(positional[0]), load(positional[1]));
    console.log(formatComparison(c));
    if (c.factR1Regressions.length > 0) process.exitCode = 2;
  } else {
    console.error("usage: harness.ts goldens <snapshotDir> | run <snapshotDir> [--modes=..] [--out=..] | compare <baseline> <candidate>");
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
