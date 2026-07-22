/**
 * Seed loader: reads ~/.nlm/work-topics.json and creates active workstreams +
 * populates workstream_entities, idempotently.
 *
 * Run: npx tsx scripts/seed-workstreams.ts [--file=<path>] [--db=<path>]
 *
 * Stack-opener mirrors scripts/eval/candidate-recall-diagnostic.ts:54-56, 149-151
 * (fileURLToPath → __dirname → resolve("../migrations"), SqliteStorage.create).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkTopics } from "../src/core/workstream/work-topics.js";
import { DEFAULT_TEAM_ID } from "../src/core/tenancy/default-team.js";
export type { WorkTopic } from "../src/core/workstream/work-topics.js";
export { parseWorkTopics };

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const arg = (k: string): string | undefined => {
    const h = process.argv.find((a) => a.startsWith(`--${k}=`));
    return h ? h.slice(k.length + 3) : undefined;
  };

  const topicsPath =
    arg("file")?.replace(/^~/, homedir()) ?? join(homedir(), ".nlm", "work-topics.json");

  const dbPath =
    arg("db")?.replace(/^~/, homedir()) ??
    (process.env["NLM_DB_PATH"] ?? join(homedir(), ".nlm", "canonical.sqlite"));

  // Mirrors the pattern in scripts/eval/candidate-recall-diagnostic.ts:54-56, 149-151.
  const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

  const topics = parseWorkTopics(JSON.parse(readFileSync(topicsPath, "utf8")));

  const { SqliteStorage } = await import("../src/core/storage/sqlite-storage.js");
  const { makeWorkstreamId, normalizeLabel } = await import("../src/core/workstream/model.js");

  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  try {
    let created = 0;
    let topped = 0;
    for (const t of topics) {
      const existing = await storage.workstreams.findByNormalizedLabel(DEFAULT_TEAM_ID, normalizeLabel(t.label));
      const ws =
        existing ?? (await storage.workstreams.create(DEFAULT_TEAM_ID, { id: makeWorkstreamId(), label: t.label, scope: null }));
      if (!existing) {
        created++;
      } else {
        topped++;
      }
      await storage.workstreams.upsertEntities(DEFAULT_TEAM_ID, ws.id, t.entities);
    }
    process.stdout.write(
      `seed-workstreams: ${topics.length} topics -> ${created} created, ${topped} already-present (entities topped up)\n`,
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
