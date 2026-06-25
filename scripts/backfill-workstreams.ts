/**
 * scripts/backfill-workstreams.ts - name-only historical backfill against the live stack.
 *
 * Run: npx tsx scripts/backfill-workstreams.ts [--db=<path>] [--dry-run]
 *
 * Binds with binding_source='backfill' (distinct from 'classifier') so a
 * reversal (WHERE binding_source='backfill') is surgical and safe at any time.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillWorkstreams } from "../src/core/workstream/backfill-workstreams.js";
import { decideWorkstreamByName } from "../src/core/workstream/name-match.js";
import { parseWorkTopics, aliasToLabelMap } from "../src/core/workstream/work-topics.js";
import { NAMING_CONTENT_CHARS } from "../src/core/workstream/bind.js";
import { buildClassifier } from "../src/llm/build-classifier.js";

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

  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  const classifier = buildClassifier();

  const topicsPath = join(homedir(), ".nlm", "work-topics.json");
  let aliasToLabel: Map<string, string>;
  try {
    aliasToLabel = aliasToLabelMap(parseWorkTopics(JSON.parse(readFileSync(topicsPath, "utf8"))));
  } catch {
    aliasToLabel = new Map();
  }

  if (dryRun) {
    process.stdout.write("backfill-workstreams: --dry-run - no bindings will be written\n");
  }

  try {
    const ws = await storage.workstreams.listAll();
    const res = await backfillWorkstreams({
      listSessions: async () => {
        const rows = storage.sessions.rawDb().prepare<[], { id: string; label: string; summary: string; body: string }>(
          "SELECT id, label, COALESCE(summary,'') AS summary, COALESCE(body,'') AS body FROM sessions WHERE label IS NOT NULL AND label != '' ORDER BY started_at ASC",
        ).all();
        return rows.map((r) => ({
          sessionId: r.id,
          content: `${r.label}\n${(r.body || r.summary).slice(0, NAMING_CONTENT_CHARS)}`,
        }));
      },
      nameSession: async (_sessionId: string, content: string) => {
        const hints = ws.map((w) => ({
          label: w.label,
          aliases: [] as string[],
        }));
        return classifier.nameWorkstream(content, hints);
      },
      decide: (named) => decideWorkstreamByName(named, ws, aliasToLabel),
      setBinding: async (s, w) => {
        if (!dryRun) {
          await storage.sessions.setWorkstreamBinding(s, w, "backfill", null);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
