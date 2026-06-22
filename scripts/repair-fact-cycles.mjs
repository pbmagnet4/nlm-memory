#!/usr/bin/env node
/**
 * One-time repair for fact supersedence cycles (NLM #351 bug 2). A batch with
 * two facts for the same (subject,predicate) used to make them supersede each
 * other (A->B, B->A); both then have a non-null superseded_by and are
 * recall-ineligible forever. The collapse winner fix prevents new ones; this
 * breaks the existing pairs.
 *
 * Per 2-cycle (a<->b), break it without creating a duplicate-active (I5a):
 *   - if another active fact already exists for (subject,predicate): point both
 *     a and b at it (they were redundant duplicates).
 *   - else: keep the winner (lexicographically smaller id) active, point the
 *     loser at the winner.
 *
 * Idempotent. Reactivated winners may lack an embedding (the ghost backfill
 * deleted superseded facts' vectors) — they remain keyword-recallable and
 * re-embed on the next embed pass. Back up the DB before running.
 *
 * Usage: node scripts/repair-fact-cycles.mjs   (or NLM_DB_PATH=/copy node ...)
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

const cyclePairs = db
  .prepare(
    `SELECT a.id AS aid, b.id AS bid, a.subject AS subject, a.predicate AS predicate
     FROM facts a JOIN facts b ON a.superseded_by = b.id AND b.superseded_by = a.id
     WHERE a.id < b.id`,
  )
  .all();

const activeOther = db.prepare(
  `SELECT id FROM facts
   WHERE subject = ? AND predicate = ? AND superseded_by IS NULL AND id NOT IN (?, ?)
   LIMIT 1`,
);
const setSuperseded = db.prepare("UPDATE facts SET superseded_by = ? WHERE id = ?");
const reactivate = db.prepare("UPDATE facts SET superseded_by = NULL WHERE id = ?");

let pointedAtExisting = 0;
let reactivatedWinner = 0;
const repair = db.transaction(() => {
  for (const { aid, bid, subject, predicate } of cyclePairs) {
    const other = activeOther.get(subject, predicate, aid, bid);
    if (other) {
      setSuperseded.run(other.id, aid);
      setSuperseded.run(other.id, bid);
      pointedAtExisting += 1;
    } else {
      // winner = aid (already the smaller id by the WHERE a.id < b.id)
      reactivate.run(aid);
      setSuperseded.run(aid, bid);
      reactivatedWinner += 1;
    }
  }
});
repair();

console.log(
  `2-cycles repaired: ${cyclePairs.length} (pointed at existing active: ${pointedAtExisting}, reactivated winner: ${reactivatedWinner})`,
);
await storage.close();
