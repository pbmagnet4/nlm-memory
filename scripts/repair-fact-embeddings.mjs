#!/usr/bin/env node
/**
 * One-time repair for ghost fact embeddings (NLM #351): superseded/retired facts
 * whose embedding was never deleted from the sqlite-vec index (pre-fix
 * markSuperseded / ingestSessionFacts left them behind), where they consume
 * ANN k-nearest slots and silently reduce effective recall.
 *
 * Uses the proven single-value DELETE (the only vec0-safe delete shape) in a
 * loop over recall-ineligible facts. Idempotent: re-running deletes nothing new.
 *
 * Usage: node scripts/repair-fact-embeddings.mjs   (back up ~/.nlm/canonical.sqlite first)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SqliteStorage } from "../dist/core/storage/sqlite-storage.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = process.env["NLM_DB_PATH"] ?? join(homedir(), ".nlm", "canonical.sqlite");
const storage = SqliteStorage.create({ dbPath, migrationsDir: join(repoRoot, "migrations") });
await storage.init();
const db = storage.rawDb();
db.pragma("busy_timeout = 10000");

const ghosts = db
  .prepare("SELECT id FROM facts WHERE superseded_by IS NOT NULL OR retired_at IS NOT NULL")
  .all();
const del = db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?");
let deleted = 0;
for (const row of ghosts) {
  try {
    deleted += del.run(row.id).changes;
  } catch (e) {
    console.error(`skip ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`recall-ineligible facts: ${ghosts.length} | ghost embeddings deleted: ${deleted}`);
await storage.close();
