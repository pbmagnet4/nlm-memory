/**
 * Phase 4 decision input: intent distribution from the recall query log.
 * Read-only. No writes to the live DB or any log file.
 *
 * Run:
 *   npx tsx scripts/eval/intent-distribution.ts
 *   npx tsx scripts/eval/intent-distribution.ts --log=/path/to/query_log.jsonl --days=30
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
const DEFAULT_LOG = process.env["NLM_QUERY_LOG"] ?? join(HOME, ".nlm", "query_log.jsonl");
const DEFAULT_DAYS = 30;

type QueryIntent = "lookup" | "relational" | "temporal" | "other";
const INTENT_LABELS: ReadonlyArray<QueryIntent> = ["lookup", "relational", "temporal", "other"];

function arg(k: string): string | undefined {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : undefined;
}

function main(): void {
  const logPath = arg("log") ?? DEFAULT_LOG;
  const days = Number(arg("days") ?? DEFAULT_DAYS);

  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    console.error(`intent-distribution: cannot read ${logPath}`);
    process.exit(1);
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const counts: Record<QueryIntent, number> = { lookup: 0, relational: 0, temporal: 0, other: 0 };
  let total = 0;
  let noIntentField = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsRaw = obj["ts"];
    if (typeof tsRaw !== "string") continue;
    const ts = Date.parse(tsRaw);
    if (!Number.isFinite(ts) || ts < cutoff) continue;

    total++;
    const intent = obj["intent"];
    if (typeof intent !== "string") {
      noIntentField++;
      continue;
    }
    const label = INTENT_LABELS.includes(intent as QueryIntent) ? (intent as QueryIntent) : "other";
    counts[label]++;
  }

  const withIntent = total - noIntentField;

  console.log(`intent-distribution  log=${logPath}  days=${days}`);
  console.log(`  total queries: ${total}  (${withIntent} with intent field, ${noIntentField} pre-telemetry)`);
  console.log("");

  if (withIntent === 0) {
    console.log("  no intent-tagged entries in window");
    return;
  }

  const pct = (n: number): string => `${((n / withIntent) * 100).toFixed(1)}%`;

  for (const label of INTENT_LABELS) {
    const n = counts[label];
    console.log(`  ${label.padEnd(10)} ${String(n).padStart(6)}  ${pct(n)}`);
  }
  console.log(`  ${"total".padEnd(10)} ${String(withIntent).padStart(6)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
