# Oversized-Session Classification + Backlog Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add map-reduce (hierarchical) classification so session bodies larger than a single classifier context window get full-coverage extraction, and ship a one-shot `nlm reclassify-oversized` command that recovers the ~185 large sessions currently absent from the corpus.

**Architecture:** `classifyLarge(text, classifier)` splits an oversized body into context-sized windows (reusing the existing `chunkSessionText`), classifies each, and **deterministically** reduces the per-chunk results (union+dedupe entities/decisions/open-questions, concat facts, first-non-empty label/summary, min confidence). `classifyAdaptive(text, classifier)` routes short bodies to a single pass and long ones to `classifyLarge`. `reclassifyOversized(deps, opts)` re-parses each failed transcript via its `TranscriptAdapter`, runs `classifyAdaptive`, ingests through `SqliteSessionStore.insertSession` (preserving real runtime/transcript provenance), and resets the `adapter_state` row. A thin `nlm reclassify-oversized` CLI wires the real stack to that function.

**Tech Stack:** TypeScript (ESM/NodeNext, `@core`/`@ports`/`@shared` aliases, explicit `.js` imports), vitest, better-sqlite3, the `ClassifierBox` (Ollama qwen3.5:4b), `chunkSessionText`, `SqliteSessionStore.insertSession`, `TranscriptAdapter.parseSession`, commander CLI.

## Global Constraints

- **`num_ctx` is 16384 TOKENS (~50–60K chars), not 20K chars.** Empirically the classifier returns successfully on bodies up to the 200K `BODY_CAP`, but Ollama silently truncates input beyond `num_ctx` — so a single pass only *sees* ~the first 50–60K chars. Chunk at **`maxChars = 40_000`, `overlap = 1_000`** (≈10K tokens + system prompt + JSON output stays under 16384) so each chunk is fully attended.
- **`classifyLarge` MUST be deterministic given the classifier's per-chunk outputs** — no second LLM "reduce" pass. The reduce is pure merge logic, so it is unit-testable with a fake classifier.
- **Preserve provenance on recovery.** Never-ingested rows get a fresh session insert: pass the adapter's real `runtime` and `transcriptKind` (e.g. `claude-code` / the adapter's `transcriptKind`), NOT `"webhook"`. (`insertSession`'s `ON CONFLICT(id)` keeps original runtime/transcript fields, but these inserts are new rows, so the values passed are what land.)
- **Confidence floor 0.3:** mirror `ingestSession` — skip ingest when `confidence < 0.3` (do not write a low-confidence session); still reset the `adapter_state` failure_count so it is not retried forever.
- **`BODY_CAP = 200_000`:** the stored `body` is capped at 200K chars (matches `ingestSession`/scheduler); classification still covers the whole transcript via chunking even though storage is capped.
- **TDD per task; run `npm run typecheck` (it runs BOTH `tsconfig.json` AND `tsconfig.test.json`) and `npx vitest run` before each commit.**
- ESM/NodeNext `.js` import suffixes; reuse `chunkSessionText` — do not write a second chunker. Public repo, no secrets.
- **Out of scope (file as a follow-up, do not build here):** wiring `classifyAdaptive` into the live `ScanScheduler` hot path. That path wraps `classify` in a 180s wall-clock timeout; a 65-chunk body would blow it, so it needs a separate per-chunk-timeout redesign. This plan recovers the existing backlog via the one-shot command; future oversized sessions still ingest (single-pass, truncated) until that follow-up lands.

---

### Task 1: `classifyLarge` + `classifyAdaptive` (hierarchical classifier)

**Files:**
- Create: `src/core/classifier/hierarchical-classify.ts`
- Test: `tests/unit/classifier/hierarchical-classify.test.ts`

**Interfaces:**
- Consumes: `chunkSessionText(input: { body?: string }, opts: { maxChars?: number; overlap?: number }): string[]` from `@core/embedding/chunk-body.js`; `LLMClient` and `ClassifyResult` from `@ports/llm-client.js` (`ClassifyResult = { label, summary, entities: string[], decisions: string[], open: string[], confidence: number, facts: ExtractedFact[] }`).
- Produces:
  - `classifyLarge(text: string, classifier: LLMClient): Promise<ClassifyResult>`
  - `classifyAdaptive(text: string, classifier: LLMClient): Promise<ClassifyResult>`
  - `SINGLE_PASS_CHAR_BUDGET = 40_000` (exported)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/classifier/hierarchical-classify.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ClassifyResult, LLMClient } from "../../../src/ports/llm-client.js";
import { classifyAdaptive, classifyLarge, SINGLE_PASS_CHAR_BUDGET } from "../../../src/core/classifier/hierarchical-classify.js";

function res(p: Partial<ClassifyResult>): ClassifyResult {
  return { label: "", summary: "", entities: [], decisions: [], open: [], confidence: 1, facts: [], ...p };
}
// A fake classifier that returns a scripted result per call, in order.
function scripted(results: ClassifyResult[]): LLMClient {
  let i = 0;
  return {
    classify: vi.fn(async () => results[i++ % results.length]!),
    embed: async () => { throw new Error("not used"); },
    rewriteForRecall: async () => { throw new Error("not used"); },
  } as unknown as LLMClient;
}

describe("classifyLarge", () => {
  it("unions and case-insensitively dedupes entities/decisions/open across chunks", async () => {
    const clf = scripted([
      res({ label: "A", summary: "sa", entities: ["DuckDB", "Hono"], decisions: ["use wal"], open: ["q1"], confidence: 0.9 }),
      res({ label: "B", summary: "sb", entities: ["duckdb", "Vite"], decisions: ["use wal"], open: ["q2"], confidence: 0.8 }),
    ]);
    const big = "x".repeat(SINGLE_PASS_CHAR_BUDGET + 50_000); // forces >1 chunk
    const out = await classifyLarge(big, clf);
    expect(out.entities.map((e) => e.toLowerCase()).sort()).toEqual(["duckdb", "hono", "vite"]);
    expect(out.decisions).toEqual(["use wal"]); // deduped
    expect(out.open.sort()).toEqual(["q1", "q2"]);
    expect(out.confidence).toBe(0.8); // min
    expect(out.label).toBe("A"); // first non-empty
  });

  it("concatenates facts from all chunks (dedupe deferred to ingest supersedence)", async () => {
    const f = (subject: string) => ({ subject, predicate: "uses", value: "x", kind: "tech" as const });
    const clf = scripted([res({ facts: [f("a")] }), res({ facts: [f("b")] })]);
    const out = await classifyLarge("y".repeat(SINGLE_PASS_CHAR_BUDGET + 50_000), clf);
    expect(out.facts).toHaveLength(2);
  });
});

describe("classifyAdaptive", () => {
  it("single-passes a short body (one classify call, no chunking)", async () => {
    const clf = scripted([res({ label: "short", entities: ["a"] })]);
    await classifyAdaptive("short body", clf);
    expect(clf.classify).toHaveBeenCalledTimes(1);
  });

  it("routes an oversized body through classifyLarge (multiple calls)", async () => {
    const clf = scripted([res({ entities: ["a"] }), res({ entities: ["b"] })]);
    await classifyAdaptive("z".repeat(SINGLE_PASS_CHAR_BUDGET + 50_000), clf);
    expect((clf.classify as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/classifier/hierarchical-classify.test.ts`
Expected: FAIL — module `hierarchical-classify.js` not found.

- [ ] **Step 3: Implement `hierarchical-classify.ts`**

```ts
// src/core/classifier/hierarchical-classify.ts
/**
 * Hierarchical (map-reduce) classification for oversized session bodies.
 *
 * Ollama's num_ctx (16384 tokens, ~50-60K chars) silently truncates input
 * beyond the window, so a single classify pass only attends to the head of a
 * large transcript. classifyLarge chunks the body to fit the window, classifies
 * each chunk, and reduces deterministically. classifyAdaptive routes by length.
 */
import { chunkSessionText } from "@core/embedding/chunk-body.js";
import type { ClassifyResult, LLMClient } from "@ports/llm-client.js";

/** Bodies at or under this length go single-pass; larger ones are chunked. */
export const SINGLE_PASS_CHAR_BUDGET = 40_000;
const CHUNK_CHARS = 40_000;
const CHUNK_OVERLAP = 1_000;

function dedupeCaseInsensitive(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export async function classifyLarge(text: string, classifier: LLMClient): Promise<ClassifyResult> {
  const chunks = chunkSessionText({ body: text }, { maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP });
  if (chunks.length === 0) {
    return { label: "", summary: "", entities: [], decisions: [], open: [], confidence: 0, facts: [] };
  }
  const results: ClassifyResult[] = [];
  for (const chunk of chunks) {
    results.push(await classifier.classify(chunk));
  }
  const firstLabelled = results.find((r) => r.label.trim().length > 0) ?? results[0]!;
  return {
    label: firstLabelled.label,
    summary: firstLabelled.summary,
    entities: dedupeCaseInsensitive(results.flatMap((r) => r.entities)),
    decisions: dedupeCaseInsensitive(results.flatMap((r) => r.decisions)),
    open: dedupeCaseInsensitive(results.flatMap((r) => r.open)),
    confidence: Math.min(...results.map((r) => r.confidence)),
    facts: results.flatMap((r) => r.facts),
  };
}

export async function classifyAdaptive(text: string, classifier: LLMClient): Promise<ClassifyResult> {
  if (text.length <= SINGLE_PASS_CHAR_BUDGET) return classifier.classify(text);
  return classifyLarge(text, classifier);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/classifier/hierarchical-classify.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (both configs).

- [ ] **Step 5: Commit**

```bash
git add src/core/classifier/hierarchical-classify.ts tests/unit/classifier/hierarchical-classify.test.ts
git commit -m "feat(classifier): hierarchical classifyLarge + classifyAdaptive for oversized bodies"
```

---

### Task 2: `reclassifyOversized` recovery function

**Files:**
- Create: `src/core/ingest/reclassify-oversized.ts`
- Test: `tests/integration/reclassify-oversized.test.ts`

**Interfaces:**
- Consumes: `classifyAdaptive` (Task 1); `SqliteSessionStore.insertSession(record, embedder, null, { factStore, facts })`; `extractFacts(result, sessionId, createdAt)` from `@core/facts/extract-facts.js`; `TranscriptAdapter` (`.name`, `.transcriptKind`, `.parseSession(path): Promise<SessionChunk | null>`); a better-sqlite3 `Database` handle via `storage.rawDb()`.
- Produces:
  ```ts
  export interface ReclassifyDeps {
    readonly db: import("better-sqlite3").Database;
    readonly store: import("@core/storage/sqlite-session-store.js").SqliteSessionStore;
    readonly factStore: import("@core/storage/sqlite-fact-store.js").SqliteFactStore;
    readonly embedder: import("@ports/llm-client.js").LLMClient;
    readonly classifier: import("@ports/llm-client.js").LLMClient;
    readonly adapters: ReadonlyArray<import("@ports/transcript-adapter.js").TranscriptAdapter>;
    readonly log?: (msg: string) => void;
  }
  export interface ReclassifyOptions { readonly limit?: number; readonly dryRun?: boolean; }
  export interface ReclassifyResult {
    readonly attempted: number; readonly ingested: number; readonly skippedLowConfidence: number;
    readonly failed: number; readonly missingFile: number;
    readonly entities: number; readonly decisions: number; readonly facts: number;
  }
  export function selectOversizedFailures(db, limit?): Array<{ adapter_name: string; source_path: string }>;
  export async function reclassifyOversized(deps: ReclassifyDeps, opts?: ReclassifyOptions): Promise<ReclassifyResult>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/reclassify-oversized.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { reclassifyOversized } from "../../src/core/ingest/reclassify-oversized.js";
import type { ClassifyResult, LLMClient } from "../../src/ports/llm-client.js";
import type { SessionChunk, TranscriptAdapter } from "../../src/ports/transcript-adapter.js";

const MIGRATIONS = join(process.cwd(), "migrations");

function fakeClassifier(result: ClassifyResult): LLMClient {
  return { classify: async () => result, embed: async () => ({ vector: new Float32Array(768), dims: 768 }), rewriteForRecall: async () => { throw new Error("nope"); } } as unknown as LLMClient;
}
function fakeAdapter(chunk: SessionChunk): TranscriptAdapter {
  return {
    name: "claude-code", runtimeVersion: "test", transcriptKind: "claude-code-jsonl",
    detect: () => ({ adapterName: "claude-code", enabled: true, path: null, hint: null }),
    discover: async () => [],
    parseSession: async () => chunk,
  } as unknown as TranscriptAdapter;
}

describe("reclassifyOversized", () => {
  let dir: string, dbPath: string, srcPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-reclass-"));
    dbPath = join(dir, "t.sqlite");
    srcPath = join(dir, "big.jsonl");
    writeFileSync(srcPath, "x".repeat(120_000));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("re-parses a failed transcript, ingests it, and clears the failure row", async () => {
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS });
    const db = storage.rawDb();
    // Seed a never-ingested failure row (session_id NULL, failure_count at ceiling).
    db.prepare(`INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
                VALUES ('claude-code', ?, 0, 120000, NULL, 3)`).run(srcPath);
    const chunk: SessionChunk = {
      id: "cc_big1", runtime: "claude-code", runtimeSessionId: "rs1", sourcePath: srcPath,
      startedAt: "2026-04-14T00:00:00.000Z", endedAt: "2026-04-14T01:00:00.000Z", durationMin: 60,
      turnCount: 10, byteRange: [0, 120000], projectDir: "/p", gitBranch: "main",
      text: "y".repeat(120_000), label: "raw",
    };
    const result: ClassifyResult = { label: "Big session", summary: "s", entities: ["DuckDB"], decisions: ["use wal"], open: [], confidence: 0.9, facts: [] };

    const out = await reclassifyOversized(
      { db, store: storage.sessions, factStore: storage.facts, embedder: fakeClassifier(result), classifier: fakeClassifier(result), adapters: [fakeAdapter(chunk)] },
      {},
    );

    expect(out.ingested).toBe(1);
    const sess = await storage.sessions.getById("cc_big1");
    expect(sess).not.toBeNull();
    expect(sess!.label).toBe("Big session");
    const ents = db.prepare("SELECT COUNT(*) AS n FROM session_entities WHERE session_id = ?").get("cc_big1") as { n: number };
    expect(ents.n).toBe(1);
    const row = db.prepare("SELECT session_id, failure_count FROM adapter_state WHERE source_path = ?").get(srcPath) as { session_id: string; failure_count: number };
    expect(row.session_id).toBe("cc_big1");
    expect(row.failure_count).toBe(0);
  });

  it("dry-run reports the candidate but writes nothing", async () => {
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS });
    const db = storage.rawDb();
    db.prepare(`INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
                VALUES ('claude-code', ?, 0, 120000, NULL, 3)`).run(srcPath);
    const result: ClassifyResult = { label: "x", summary: "s", entities: [], decisions: [], open: [], confidence: 0.9, facts: [] };
    const out = await reclassifyOversized(
      { db, store: storage.sessions, factStore: storage.facts, embedder: fakeClassifier(result), classifier: fakeClassifier(result), adapters: [fakeAdapter({ id: "cc_x", runtime: "claude-code", runtimeSessionId: "r", sourcePath: srcPath, startedAt: "2026-04-14T00:00:00.000Z", endedAt: "2026-04-14T00:00:00.000Z", durationMin: 1, turnCount: 1, byteRange: [0, 1], projectDir: "/p", gitBranch: "m", text: "z".repeat(120_000), label: "r" })] },
      { dryRun: true },
    );
    expect(out.attempted).toBe(1);
    expect(out.ingested).toBe(0);
    expect(await storage.sessions.getById("cc_x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/reclassify-oversized.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reclassify-oversized.ts`**

```ts
// src/core/ingest/reclassify-oversized.ts
/**
 * One-shot recovery: re-classify large sessions that never ingested (they
 * failed under an old num_ctx and are not retried because the scheduler only
 * reprocesses files that grow). Uses classifyAdaptive so oversized bodies get
 * full-coverage hierarchical extraction.
 */
import type { Database } from "better-sqlite3";
import { classifyAdaptive } from "@core/classifier/hierarchical-classify.js";
import { extractFacts } from "@core/facts/extract-facts.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type { IngestRecord, SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { TranscriptAdapter } from "@ports/transcript-adapter.js";

const BODY_CAP = 200_000;
const CONFIDENCE_FLOOR = 0.3;

export interface ReclassifyDeps {
  readonly db: Database;
  readonly store: SqliteSessionStore;
  readonly factStore: SqliteFactStore;
  readonly embedder: LLMClient;
  readonly classifier: LLMClient;
  readonly adapters: ReadonlyArray<TranscriptAdapter>;
  readonly log?: (msg: string) => void;
}
export interface ReclassifyOptions { readonly limit?: number; readonly dryRun?: boolean; }
export interface ReclassifyResult {
  readonly attempted: number; readonly ingested: number; readonly skippedLowConfidence: number;
  readonly failed: number; readonly missingFile: number;
  readonly entities: number; readonly decisions: number; readonly facts: number;
}

export function selectOversizedFailures(db: Database, limit?: number): Array<{ adapter_name: string; source_path: string }> {
  const sql =
    "SELECT adapter_name, source_path FROM adapter_state " +
    "WHERE session_id IS NULL AND failure_count >= 1 ORDER BY file_size DESC" +
    (limit ? ` LIMIT ${Math.floor(limit)}` : "");
  return db.prepare(sql).all() as Array<{ adapter_name: string; source_path: string }>;
}

export async function reclassifyOversized(deps: ReclassifyDeps, opts: ReclassifyOptions = {}): Promise<ReclassifyResult> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const byName = new Map(deps.adapters.map((a) => [a.name, a]));
  const rows = selectOversizedFailures(deps.db, opts.limit);
  let ingested = 0, skippedLowConfidence = 0, failed = 0, missingFile = 0, entities = 0, decisions = 0, facts = 0;

  for (const row of rows) {
    const adapter = byName.get(row.adapter_name);
    if (!adapter) { failed++; log(`[reclassify] no adapter for ${row.adapter_name}`); continue; }
    let chunk;
    try {
      chunk = await adapter.parseSession(row.source_path);
    } catch (e) {
      missingFile++; log(`[reclassify] parse failed ${row.source_path}: ${e instanceof Error ? e.message : String(e)}`); continue;
    }
    if (!chunk) { missingFile++; continue; }

    const classification = await classifyAdaptive(chunk.text, deps.classifier);
    if (opts.dryRun) { continue; }
    if (classification.confidence < CONFIDENCE_FLOOR) {
      skippedLowConfidence++;
      deps.db.prepare("UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = ? AND source_path = ?").run(row.adapter_name, row.source_path);
      continue;
    }

    const record: IngestRecord = {
      id: chunk.id, runtime: chunk.runtime, runtimeSessionId: chunk.runtimeSessionId,
      startedAt: chunk.startedAt, endedAt: chunk.endedAt, durationMin: chunk.durationMin,
      label: classification.label, summary: classification.summary, body: chunk.text.slice(0, BODY_CAP),
      status: "closed", transcriptKind: adapter.transcriptKind, transcriptPath: row.source_path,
      transcriptOffset: null, transcriptLength: chunk.text.length,
      entities: classification.entities, decisions: classification.decisions, openQuestions: classification.open,
    };
    const extracted = extractFacts(classification, chunk.id, chunk.startedAt);
    try {
      await deps.store.insertSession(record, deps.embedder, null, { factStore: deps.factStore, facts: extracted });
      deps.db.prepare(
        "UPDATE adapter_state SET session_id = ?, last_offset = file_size, failure_count = 0 WHERE adapter_name = ? AND source_path = ?",
      ).run(chunk.id, row.adapter_name, row.source_path);
      ingested++; entities += classification.entities.length; decisions += classification.decisions.length; facts += extracted.length;
    } catch (e) {
      failed++; log(`[reclassify] ingest failed ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { attempted: rows.length, ingested, skippedLowConfidence, failed, missingFile, entities, decisions, facts };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/reclassify-oversized.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (both configs).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/core/ingest/reclassify-oversized.ts tests/integration/reclassify-oversized.test.ts
git commit -m "feat(ingest): reclassifyOversized recovery for never-ingested large sessions"
```

---

### Task 3: `nlm reclassify-oversized` CLI command

**Files:**
- Modify: `src/cli/nlm.ts` (register the command in the commander program, near `backfill-facts`)

**Interfaces:**
- Consumes: the existing stack builders in `nlm.ts` — `buildStack()` (returns `{ storage, store, facts, embedder, classifier, sources, ... }`) and `buildAdapters(sources)` (returns `ReadonlyArray<TranscriptAdapter>`); `reclassifyOversized` (Task 2).

- [ ] **Step 1: Read the existing `backfill-facts` command + `buildStack`/`buildAdapters` in `src/cli/nlm.ts`**

This command mirrors `backfill-facts`'s shape: build the SQLite stack, build adapters from the sources registry, call the one-shot, print a summary, close storage. Confirm the exact names `buildStack` returns (`storage`, `store`/`storage.sessions`, `facts`, `embedder`, `classifier`, `sources`) and that `buildAdapters(sources)` exists; adapt the call below to the real names if they differ.

- [ ] **Step 2: Register the command**

Add to the commander program (mirror `backfill-facts` registration):
```ts
program
  .command("reclassify-oversized")
  .description("One-shot: re-classify large sessions that never ingested (hierarchical classify), recover into the corpus")
  .option("-l, --limit <n>", "max sessions to process", (v) => Number.parseInt(v, 10))
  .option("--dry-run", "count candidates without writing", false)
  .action(async (opts: { limit?: number; dryRun?: boolean }) => {
    const { reclassifyOversized } = await import("../core/ingest/reclassify-oversized.js");
    const stack = await buildStack();
    const adapters = await buildAdapters(stack.sources);
    const r = await reclassifyOversized(
      { db: stack.storage.rawDb(), store: stack.storage.sessions, factStore: stack.facts, embedder: stack.embedder, classifier: stack.classifier, adapters },
      { ...(opts.limit ? { limit: opts.limit } : {}), dryRun: Boolean(opts.dryRun) },
    );
    console.log(
      `reclassify-oversized: attempted=${r.attempted} ingested=${r.ingested} ` +
      `lowConfidence=${r.skippedLowConfidence} missingFile=${r.missingFile} failed=${r.failed} ` +
      `| gained entities=${r.entities} decisions=${r.decisions} facts=${r.facts}`,
    );
    await stack.storage.close();
  });
```
(If `buildStack`/`buildAdapters` are named differently or `buildAdapters` needs more than `sources`, match the real signatures found in Step 1.)

- [ ] **Step 3: Build and smoke-test the command surface**

Run: `npm run build:server && node dist/cli/nlm.js reclassify-oversized --dry-run --limit 1`
Expected: prints a summary line with `attempted=…` and writes nothing (dry-run). Then `npm run typecheck` clean.

- [ ] **Step 4: Commit**

```bash
git add src/cli/nlm.ts
git commit -m "feat(cli): nlm reclassify-oversized command"
```

---

## Manual recovery run (post-merge, operator step)

After the feature merges and the daemon is rebuilt to include it:

1. **Online backup first:** `sqlite3 ~/.nlm/canonical.sqlite ".backup '$HOME/.nlm/canonical.backup-pre340-$(date +%Y%m%d-%H%M%S).sqlite'"`
2. **Dry-run:** `node dist/cli/nlm.js reclassify-oversized --dry-run` — confirm `attempted ≈ 185`.
3. **Recover a small batch first:** `node dist/cli/nlm.js reclassify-oversized --limit 5` — verify sessions appear with entities/decisions; spot-check `getById`.
4. **Full run (background, ~2–3 hr of Ollama time):** `node dist/cli/nlm.js reclassify-oversized` — runs with the daemon live (busy_timeout already configured in the store; insertSession is transactional).
5. **Verify:** the never-ingested count (`SELECT COUNT(*) FROM adapter_state WHERE session_id IS NULL AND failure_count>=1`) drops toward 0; report entities/decisions/facts gained. Delete the backup once satisfied.

## Self-review notes (coverage vs goal)

- Hierarchical chunked classification (full coverage past num_ctx) → Task 1 (`classifyLarge`), chunk size 40K justified in Global Constraints.
- Adaptive routing (don't chunk small bodies) → Task 1 (`classifyAdaptive`).
- Recover the ~185 never-ingested large sessions → Task 2 (`reclassifyOversized`) + Task 3 (CLI) + Manual run.
- Provenance preserved (not "webhook") → Task 2 record uses adapter runtime/transcriptKind.
- Out of scope, documented: wiring `classifyAdaptive` into the live `ScanScheduler` hot path (180s timeout would break on many chunks) — file a follow-up so future oversized sessions auto-chunk on ingest.
