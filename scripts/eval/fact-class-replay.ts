/**
 * Offline replay of the fact-class ingest rule (T737 / E6). See docs/fact-classes.md.
 *
 *   tsx scripts/eval/fact-class-replay.ts <snapshotDir> --out-dir=<dir>
 *
 * Clones the snapshot into <dir> (the live store is never opened), then undoes
 * the ingest collapse for event-class predicates: a fact whose successor shares
 * its (subject, predicate) becomes active again and is re-embedded, as it would
 * have stayed with NLM_FACT_CLASSES=on. <dir> is then scored with
 * `harness.ts run <dir>` and `compare`.
 */

import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { composeFactEmbedText } from "../../src/core/facts/embed-backfill.js";
import { EVENT_CLASS_PREDICATES } from "../../src/core/facts/fact-classes.js";
import { countActiveFactConflicts } from "../../src/core/integrity/check-invariants.js";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../migrations");
const SIDE_FILES = ["goldens.json", "citation-log.jsonl", "fact_query_log.jsonl", "hook-log.jsonl", "query_log.jsonl"];

const args = process.argv.slice(2);
const snapshot = args.find((a) => !a.startsWith("--"));
const outDir = args.find((a) => a.startsWith("--out-dir="))?.slice(10);

async function main(): Promise<void> {
  if (!snapshot || !outDir) {
    console.error("usage: fact-class-replay.ts <snapshotDir> --out-dir=<dir>");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, "canonical.sqlite");
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; pick a new --out-dir`);
  copyFileSync(join(snapshot, "canonical.sqlite"), dbPath, constants.COPYFILE_FICLONE);
  chmodSync(dbPath, 0o600);
  for (const f of SIDE_FILES) if (existsSync(join(snapshot, f))) copyFileSync(join(snapshot, f), join(outDir, f), constants.COPYFILE_FICLONE);

  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  const db = storage.rawDb();
  const embedder = buildEmbedder();
  await embedder.embed("probe", "document");
  const before = countActiveFactConflicts(db);

  const marks = EVENT_CLASS_PREDICATES.map(() => "?").join(",");
  const revived = db
    .prepare<string[], { id: string; tenant_id: string; subject: string; predicate: string; value: string }>(
      `SELECT f.id, f.tenant_id, f.subject, f.predicate, f.value FROM facts f
       JOIN facts s ON s.id = f.superseded_by AND s.subject = f.subject AND s.predicate = f.predicate
       WHERE f.retired_at IS NULL AND f.predicate IN (${marks})`,
    )
    .all(...EVENT_CLASS_PREDICATES);
  const unset = db.prepare("UPDATE facts SET superseded_by = NULL WHERE id = ?");
  for (const r of revived) unset.run(r.id);

  let embedded = 0;
  let failed = 0;
  for (const r of revived) {
    try {
      const { vector } = await embedder.embed(composeFactEmbedText(r.subject, r.predicate, r.value), "document");
      await storage.facts.upsertEmbedding(r.tenant_id, r.id, vector);
      embedded++;
    } catch {
      failed++;
    }
    if ((embedded + failed) % 500 === 0) console.error(`${embedded + failed}/${revived.length}`);
  }
  const after = countActiveFactConflicts(db);
  const summary = { eventPredicates: EVENT_CLASS_PREDICATES, revived: revived.length, embedded, failed, before, after };
  writeFileSync(join(outDir, "replay-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await storage.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
