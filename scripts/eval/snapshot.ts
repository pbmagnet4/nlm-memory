/**
 * Create a dated read-only snapshot of the live NLM store for eval runs.
 *
 * Run: npx tsx scripts/eval/snapshot.ts [--date=YYYY-MM-DD] [--nlm-dir=~/.nlm]
 *      [--out-root=~/.nlm/eval/snapshots]
 * Prints the snapshot directory on stdout. Never writes to the live store.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createSnapshot } from "../../src/core/eval/harness/snapshot.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const nlmDir = arg("nlm-dir") ?? join(homedir(), ".nlm");
const outRoot = arg("out-root") ?? join(nlmDir, "eval", "snapshots");
const date = arg("date") ?? new Date().toISOString().slice(0, 10);

createSnapshot({
  sourceDb: join(nlmDir, "canonical.sqlite"),
  logsDir: nlmDir,
  outDir: join(outRoot, date),
})
  .then((r) => {
    if (r.missingLogs.length > 0) console.error(`snapshot: logs not found: ${r.missingLogs.join(", ")}`);
    console.log(r.dir);
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
