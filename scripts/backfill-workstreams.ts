/**
 * scripts/backfill-workstreams.ts — match-only historical backfill against the live stack.
 * Reuses buildMatchInputs (Task 1) so the backfill matcher == the runtime matcher (spec §15).
 *
 * Run: npx tsx scripts/backfill-workstreams.ts [--db=<path>] [--dry-run]
 *
 * Stack-opener mirrors scripts/seed-workstreams.ts (SqliteStorage.create pattern).
 * Session-listing projection mirrors scripts/eval/dump-matcher-candidates.ts
 * (SELECT id,label,COALESCE(summary,'')) plus getEntities() per session (critical
 * correction: entities are required for entity-Jaccard scoring — omitting them zeroes
 * that half of the score).
 *
 * Binds with binding_source='backfill' (distinct from 'classifier') so the R4/R6
 * reversal (WHERE binding_source='backfill') is surgical and safe at any time.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatchInputs } from "../src/core/workstream/build-match-inputs.js";
import { backfillWorkstreams } from "../src/core/workstream/backfill-workstreams.js";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "../src/core/workstream/thresholds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const arg = (k: string): string | undefined => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : undefined;
};
const flag = (k: string): boolean => process.argv.includes(`--${k}`);

async function main(): Promise<void> {
  const dbPath =
    arg("db")?.replace(/^~/, homedir()) ??
    (process.env["NLM_DB_PATH"] ?? join(homedir(), ".nlm", "canonical.sqlite"));
  const dryRun = flag("dry-run");

  const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

  const { SqliteStorage } = await import("../src/core/storage/sqlite-storage.js");
  const { OllamaClient } = await import("../src/llm/ollama-client.js");

  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  const embedder = new OllamaClient();

  if (dryRun) {
    process.stdout.write("backfill-workstreams: --dry-run — no bindings will be written\n");
  }

  try {
    const res = await backfillWorkstreams({
      // Historical sessions: mirror dump-matcher-candidates.ts's SELECT id,label,COALESCE(summary,'')
      // AND fetch entities per session so entity-Jaccard scoring is populated.
      listSessions: async () => {
        const rows = storage.sessions.rawDb().prepare<[], { id: string; label: string; summary: string }>(
          "SELECT id, label, COALESCE(summary,'') AS summary FROM sessions WHERE label IS NOT NULL AND label != '' ORDER BY started_at ASC",
        ).all();
        return Promise.all(
          rows.map(async (r) => ({
            sessionId: r.id,
            label: r.label,
            summary: r.summary,
            entities: await storage.sessions.getEntities(r.id),
          })),
        );
      },
      buildInputs: (input) =>
        buildMatchInputs(
          {
            workstreams: storage.workstreams,
            sessions: storage.sessions,
            embedder,
            thresholds: DEFAULT_THRESHOLDS,
            weights: DEFAULT_WEIGHTS,
          },
          input,
        ),
      setBinding: async (s, w, c) => {
        if (!dryRun) {
          await storage.sessions.setWorkstreamBinding(s, w, "backfill", c);
        }
      },
      log: (m) => process.stdout.write(m + "\n"),
    });
    process.stdout.write(
      `backfill-workstreams: considered ${res.considered}, bound ${res.bound}, skipped ${res.skipped}\n`,
    );
  } finally {
    await storage.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
