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

export interface WorkTopic {
  readonly label: string;
  readonly entities: ReadonlyArray<string>;
}

export function parseWorkTopics(raw: unknown): ReadonlyArray<WorkTopic> {
  if (Array.isArray(raw)) {
    return raw.map((t) => {
      if (
        !t ||
        typeof t !== "object" ||
        typeof (t as { label?: unknown }).label !== "string" ||
        !Array.isArray((t as { entities?: unknown }).entities)
      ) {
        throw new Error(
          `work-topics: array item is not {label, entities[]}: ${JSON.stringify(t)}`,
        );
      }
      return {
        label: (t as { label: string }).label,
        entities: ((t as { entities: unknown[] }).entities).map(String),
      };
    });
  }
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>);
    // Alias-map shape { "<alias>": "<canonical>" } (the operator file's real shape,
    // same map work-digest's aliasTopicProvider consumes): group aliases under their
    // canonical label. Canonical = workstream label; aliases (+ the canonical itself)
    // = its entities.
    if (entries.length > 0 && entries.every(([, v]) => typeof v === "string")) {
      const byCanonical = new Map<string, Set<string>>();
      for (const [alias, canonical] of entries as Array<[string, string]>) {
        const set = byCanonical.get(canonical) ?? new Set<string>([canonical]);
        set.add(alias);
        byCanonical.set(canonical, set);
      }
      return [...byCanonical].map(([label, entities]) => ({ label, entities: [...entities] }));
    }
    // Label-to-entities map { "<label>": ["<entity>", ...] }.
    return entries.map(([label, ents]) => {
      if (!Array.isArray(ents)) {
        throw new Error(`work-topics: value for "${label}" is neither a string (alias map) nor an array (entity map)`);
      }
      return { label, entities: ents.map(String) };
    });
  }
  throw new Error("work-topics: expected an object map or an array of {label, entities[]}");
}

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
      const existing = await storage.workstreams.findByNormalizedLabel(normalizeLabel(t.label));
      const ws =
        existing ?? (await storage.workstreams.create({ id: makeWorkstreamId(), label: t.label }));
      if (!existing) {
        created++;
      } else {
        topped++;
      }
      await storage.workstreams.upsertEntities(ws.id, t.entities);
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
