/**
 * Offline replay of the write-time fact judge (T734 / E3). See docs/fact-judge.md.
 *
 *   tsx scripts/eval/fact-judge-replay.ts <snapshotDir> --out-dir=<dir> [--others=300] [--seed=734] [--limit=N] [--resume]
 *
 * Clones the snapshot into <dir> (the live store is never opened), then replays
 * the judge in creation order, serially, over (a) every active fact in the
 * conflicting (subject, predicate) groups and (b) a seeded random sample of
 * active facts from other groups, applying each decision to the clone as it
 * goes. A fact only sees candidates created before it. <dir> is then a
 * snapshot the harness can score: `harness.ts run <dir>` and `compare`.
 *
 * Uses the configured classifier lane (NLM_CLASSIFIER_* from ~/.nlm/.env) and
 * embedder lane; nothing else is called.
 */

import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildClassifier } from "../../src/llm/build-classifier.js";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { countActiveFactConflicts, listActiveFactConflictGroups } from "../../src/core/integrity/check-invariants.js";
import { FactJudge } from "../../src/core/facts/write-judge.js";
import type { Fact } from "../../src/shared/types.js";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../migrations");
const SIDE_FILES = ["goldens.json", "citation-log.jsonl", "fact_query_log.jsonl", "hook-log.jsonl", "query_log.jsonl"];

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const stableRank = (seed: string, id: string): string => createHash("sha1").update(`${seed}:${id}`).digest("hex");

interface FactRow {
  id: string;
  kind: Fact["kind"];
  subject: string;
  predicate: string;
  value: string;
  source_session_id: string;
  source_quote: string | null;
  created_at: string;
  superseded_by: string | null;
  confidence: number;
}
const toFact = (r: FactRow): Fact => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  predicate: r.predicate,
  value: r.value,
  sourceSessionId: r.source_session_id,
  sourceQuote: r.source_quote,
  createdAt: r.created_at,
  supersededBy: r.superseded_by,
  confidence: r.confidence,
});

const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

async function main(): Promise<void> {
  const snapshot = positional[0];
  const outDir = flag("out-dir");
  if (!snapshot || !outDir) {
    console.error("usage: fact-judge-replay.ts <snapshotDir> --out-dir=<dir> [--others=300] [--seed=734] [--limit=N] [--resume]");
    process.exit(1);
  }
  const resume = args.includes("--resume");
  mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, "canonical.sqlite");
  if (!resume) {
    if (existsSync(dbPath)) throw new Error(`${dbPath} exists; pass --resume or pick a new --out-dir`);
    copyFileSync(join(snapshot, "canonical.sqlite"), dbPath, constants.COPYFILE_FICLONE);
    chmodSync(dbPath, 0o600);
    for (const f of SIDE_FILES) if (existsSync(join(snapshot, f))) copyFileSync(join(snapshot, f), join(outDir, f), constants.COPYFILE_FICLONE);
  }
  const logPath = join(outDir, "judge-log.jsonl");
  process.env["NLM_SWEEP_AUDIT_LOG"] = join(outDir, "sweep-audit.jsonl");

  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  const db = storage.rawDb();
  const classifier = buildClassifier();
  const embedder = buildEmbedder();
  await embedder.embed("probe", "document");

  const setPath = join(outDir, "replay-set.json");
  interface ReplaySet {
    before: { conflicts: number; multiValuedGroups: number };
    groups: number;
    conflictIds: string[];
    otherIds: string[];
  }
  let set: ReplaySet;
  if (resume) {
    set = JSON.parse(readFileSync(setPath, "utf8")) as ReplaySet;
  } else {
    const groups = listActiveFactConflictGroups(db);
    const groupKey = (f: { subject: string; predicate: string }): string => `${f.subject}\u0000${f.predicate}`;
    const conflictKeys = new Set(groups.map(groupKey));
    const active = db
      .prepare<[], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id, source_quote, created_at, superseded_by, confidence
         FROM facts WHERE superseded_by IS NULL AND retired_at IS NULL`,
      )
      .all()
      .map(toFact);
    const seed = flag("seed") ?? "734";
    set = {
      before: countActiveFactConflicts(db),
      groups: groups.length,
      conflictIds: active.filter((f) => conflictKeys.has(groupKey(f))).map((f) => f.id),
      otherIds: active
        .filter((f) => !conflictKeys.has(groupKey(f)))
        .sort((a, b) => stableRank(seed, a.id).localeCompare(stableRank(seed, b.id)))
        .slice(0, Number(flag("others") ?? 300))
        .map((f) => f.id),
    };
    writeFileSync(setPath, JSON.stringify(set));
  }
  const arm = new Map<string, "conflict" | "other">([
    ...set.conflictIds.map((id) => [id, "conflict"] as const),
    ...set.otherIds.map((id) => [id, "other"] as const),
  ]);
  const tenantOf = db.prepare<[string], { tenant_id: string }>("SELECT tenant_id FROM facts WHERE id = ?");
  const byId = db.prepare<[string], FactRow>(
    `SELECT id, kind, subject, predicate, value, source_session_id, source_quote, created_at, superseded_by, confidence FROM facts WHERE id = ?`,
  );
  let queue = [...arm.keys()]
    .map((id) => toFact(byId.get(id)!))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const done = new Set<string>();
  if (resume && existsSync(logPath)) {
    for (const l of readFileSync(logPath, "utf8").split("\n")) if (l) done.add((JSON.parse(l) as { newId: string }).newId);
    queue = queue.filter((f) => !done.has(f.id));
  }
  const limit = flag("limit");
  if (limit) queue = queue.slice(0, Number(limit));
  console.error(`conflict groups ${set.groups}, conflict facts ${set.conflictIds.length}, others ${set.otherIds.length}, to run ${queue.length}`);

  const judge = new FactJudge({ store: storage.facts, llm: classifier, embedder, mode: "on", logPath });
  for (const [i, fact] of queue.entries()) {
    await judge.run(tenantOf.get(fact.id)!.tenant_id, [fact], {
      accept: (c) => c.createdAt < fact.createdAt || (c.createdAt === fact.createdAt && c.id < fact.id),
    });
    if ((i + 1) % 25 === 0) console.error(`${i + 1}/${queue.length}`);
  }

  const logged = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { newId: string; action: string; fallback: string | null; latencyMs: number });
  const decisions = logged.map((d) => ({ ...d, arm: arm.get(d.newId) ?? "?" }));
  const tally = (a: string, act: string): number => decisions.filter((d) => d.arm === a && d.action === act).length;
  const modelMs = decisions.map((d) => d.latencyMs);
  const after = countActiveFactConflicts(db);
  const summary = {
    conflictGroups: { before: set.before.conflicts, after: after.conflicts },
    multiValuedGroups: { before: set.before.multiValuedGroups, after: after.multiValuedGroups },
    replayed: decisions.length,
    decisions: Object.fromEntries(
      ["conflict", "other"].map((a) => [a, { KEEP_BOTH: tally(a, "KEEP_BOTH"), SKIP_NEW: tally(a, "SKIP_NEW"), SUPERSEDE_OLD: tally(a, "SUPERSEDE_OLD") }]),
    ),
    fallbacks: decisions.filter((d) => d.fallback !== null).length,
    judgeLatencyMs: { p50: percentile(modelMs, 0.5), p95: percentile(modelMs, 0.95), mean: Math.round(modelMs.reduce((x, y) => x + y, 0) / Math.max(1, modelMs.length)) },
    note: "per-fact added latency: candidate retrieval (embed + KNN) plus the model call",
  };
  writeFileSync(join(outDir, "replay-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await storage.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
