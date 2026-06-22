#!/usr/bin/env node
/**
 * One-time repair for ORPHAN fact embeddings (NLM #351 follow-up): vec0 vectors
 * whose backing fact row was hard-deleted. The live ingest path
 * (SqliteSessionStore.insertSession) DELETEd a session's prior facts on
 * re-ingest without deleting their embeddings, so the vectors linger with no
 * fact at all. The superseded/retired repair (repair-fact-embeddings.mjs) walks
 * the facts table and therefore cannot see these — they have no row. Orphans
 * still occupy vec0 k-nearest slots and silently reduce effective fact recall.
 *
 * Uses the proven single-value DELETE (the only vec0-safe delete shape) in a
 * loop over embedding ids with no matching fact. Idempotent: re-running deletes
 * nothing new.
 *
 * Usage: node scripts/repair-orphan-fact-embeddings.mjs
 *   Copy-test first:  NLM_DB_PATH=/tmp/copy.sqlite node scripts/repair-orphan-fact-embeddings.mjs
 *   Back up the live store before running against it.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "../dist/core/storage/sqlite-storage.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = process.env["NLM_DB_PATH"] ?? join(homedir(), ".nlm", "canonical.sqlite");
const storage = SqliteStorage.create({ dbPath, migrationsDir: join(repoRoot, "migrations") });
await storage.init();
const db = storage.rawDb();
db.pragma("busy_timeout = 10000");

const orphans = db
  .prepare("SELECT id FROM fact_embeddings_rowids WHERE id NOT IN (SELECT id FROM facts)")
  .all();
const del = db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?");
let deleted = 0;
for (const row of orphans) {
  try {
    deleted += del.run(row.id).changes;
  } catch (e) {
    console.error(`skip ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`orphan embeddings (no backing fact): ${orphans.length} | deleted: ${deleted}`);
await storage.close();
