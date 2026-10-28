/**
 * Integration tests for the exemplar embed-backfill against a real
 * SQLite + sqlite-vec store. No network: a deterministic stub CodeEmbedder
 * stands in for Ollama/CodeRankEmbed.
 *
 * Models the production failure: an exemplar is inserted but its
 * fire-and-forget embed dropped the vector. The backfill discovers the
 * vectorless row, embeds it, and upserts — after which it is retrievable by
 * vector search. A second run is a no-op (no rows missing a vector).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { codeHash } from "../../src/core/exemplars/ingest-exemplar.js";
import { backfillExemplarEmbeddings } from "../../src/core/exemplars/embed-backfill.js";
import type { CodeEmbedder, EmbedCodeResult } from "../../src/ports/code-embedder.js";
import type { CodeExemplarInput } from "../../src/shared/types.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const INSTALL_SCOPE = "install-test";
const LANE = { provider: "ollama", model: "code-a", onStale: "rebuild" } as const;

function unitWithLeading(value: number, dim = 768): Float32Array {
  const v = new Float32Array(dim);
  v[0] = value;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) ** 2;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(dim);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

class StubCodeEmbedder implements CodeEmbedder {
  calls = 0;
  constructor(private readonly dim = 768, private readonly failFromCall = Infinity) {}
  async embed(): Promise<EmbedCodeResult> {
    this.calls += 1;
    if (this.calls >= this.failFromCall) throw new Error("boom");
    const vector = unitWithLeading(this.calls, this.dim);
    return { vector, dim: vector.length };
  }
}

function makeExemplarInput(overrides: Partial<CodeExemplarInput> = {}): CodeExemplarInput {
  const code = overrides.code ?? "function add(a, b) {\n  return a + b;\n}";
  return {
    installScope: INSTALL_SCOPE,
    signalId: null,
    sessionId: null,
    repo: "/repo/alpha",
    model: "qwen3-coder",
    lang: "ts",
    taskContext: "add two numbers",
    code,
    codeHash: codeHash(code),
    outcome: "pass",
    gitSha: null,
    survived: null,
    scope: null,
    ts: "2026-06-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("backfillExemplarEmbeddings", () => {
  let tmp: string;
  let dbPath: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-exemplar-bf-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("embeds vectorless rows and makes them retrievable", async () => {
    // Two exemplars inserted with NO embedding (the dropped-vector case).
    const inputs = [
      makeExemplarInput({ code: "const a = 1;", taskContext: "declare a constant" }),
      makeExemplarInput({ code: "export function f() { return 2; }", taskContext: "export a fn" }),
    ];
    for (const inp of inputs) await storage.exemplars.insert("team_local", inp);

    // Pre-condition: vector search finds nothing (no vectors exist).
    const before = await storage.exemplars.searchByVector("team_local", unitWithLeading(1), {
      installScope: INSTALL_SCOPE,
    });
    expect(before.length).toBe(0);

    const embedder = new StubCodeEmbedder();
    const report = await backfillExemplarEmbeddings({ tenantId: "team_local", dbPath, embedder, store: storage.exemplars, ...LANE });

    expect(report.dbMissing).toBe(false);
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
    expect(report.failed).toBe(0);
    expect(embedder.calls).toBe(3); // probe + 2 rows

    // Post-condition: the exemplars are now retrievable by vector search.
    const after = await storage.exemplars.searchByVector("team_local", unitWithLeading(1), {
      installScope: INSTALL_SCOPE,
    });
    expect(after.length).toBe(2);
  });

  it("is idempotent — a second run finds no missing rows", async () => {
    await storage.exemplars.insert("team_local", makeExemplarInput());

    const first = await backfillExemplarEmbeddings({ tenantId: "team_local", ...LANE,
      dbPath,
      embedder: new StubCodeEmbedder(),
      store: storage.exemplars,
    });
    expect(first.succeeded).toBe(1);

    const embedder2 = new StubCodeEmbedder();
    const second = await backfillExemplarEmbeddings({ tenantId: "team_local", dbPath, embedder: embedder2, store: storage.exemplars, ...LANE });
    expect(second.total).toBe(0);
    expect(second.succeeded).toBe(0);
    expect(embedder2.calls).toBe(1); // probe only
  });

  it("leaves already-embedded rows untouched and only fills the gap", async () => {
    const embedded = makeExemplarInput({ code: "const x = 1;", taskContext: "x" });
    const vectorless = makeExemplarInput({ code: "const y = 2;", taskContext: "y" });
    const { id: embeddedId } = await storage.exemplars.insert("team_local", embedded);
    await storage.exemplars.insert("team_local", vectorless);
    // Pre-seed a vector for the first row only.
    await storage.exemplars.upsertEmbedding("team_local", embeddedId, unitWithLeading(7));

    const embedder = new StubCodeEmbedder();
    const report = await backfillExemplarEmbeddings({ tenantId: "team_local", dbPath, embedder, store: storage.exemplars, ...LANE });

    // Only the vectorless row gets embedded.
    expect(report.total).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(embedder.calls).toBe(2); // probe + 1 row
  });

  it("reports dbMissing when the database does not exist", async () => {
    const report = await backfillExemplarEmbeddings({ tenantId: "team_local", ...LANE,
      dbPath: join(tmp, "nope.sqlite"),
      embedder: new StubCodeEmbedder(),
      store: storage.exemplars,
    });
    expect(report.dbMissing).toBe(true);
    expect(report.total).toBe(0);
  });
});

describe("backfillExemplarEmbeddings, lane rebuild", () => {
  let tmp: string;
  let dbPath: string;
  let storage: SqliteStorage;

  const vecDim = (): number => {
    const db = new Database(dbPath, { readonly: true });
    sqliteVec.load(db);
    try {
      const r = db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'code_exemplars_vec'").get();
      return Number(/float\[(\d+)\]/.exec(r!.sql)![1]);
    } finally {
      db.close();
    }
  };
  const vecCount = (): number => {
    const db = new Database(dbPath, { readonly: true });
    sqliteVec.load(db);
    try {
      return db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM code_exemplars_vec").get()!.n;
    } finally {
      db.close();
    }
  };
  const run = (embedder: CodeEmbedder, extra: Partial<Parameters<typeof backfillExemplarEmbeddings>[0]> = {}) =>
    backfillExemplarEmbeddings({ tenantId: "team_local", dbPath, embedder, store: storage.exemplars, ...LANE, ...extra });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-exemplar-rb-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    for (const c of ["const a = 1;", "const b = 2;", "const c = 3;"]) {
      await storage.exemplars.insert("team_local", makeExemplarInput({ code: c, taskContext: c }));
    }
    // Lane is built at 768 with model code-a.
    expect((await run(new StubCodeEmbedder())).succeeded).toBe(3);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rebuilds at the new dim, re-embeds every row and records the config", async () => {
    const embedder = new StubCodeEmbedder(384);
    const report = await run(embedder, { model: "code-b" });
    expect(report).toMatchObject({ rebuilt: true, total: 3, succeeded: 3, failed: 0 });
    expect(vecDim()).toBe(384);
    expect(vecCount()).toBe(3);
    expect(storage.embeddingConfig.getLane("code")).toEqual({ lane: "code", provider: "ollama", model: "code-b", dim: 384 });
  });

  it("rebuilds for a model change at the same dim", async () => {
    const report = await run(new StubCodeEmbedder(768), { model: "code-b" });
    expect(report).toMatchObject({ rebuilt: true, succeeded: 3 });
    expect(storage.embeddingConfig.getLane("code")?.model).toBe("code-b");
  });

  it("an interrupted rebuild resumes without dropping again", async () => {
    // probe is call 1; the first row embeds (call 2); everything after fails the run.
    await expect(run(new StubCodeEmbedder(384, 3), { model: "code-b" })).rejects.toThrow("boom");
    expect(vecDim()).toBe(384);
    expect(vecCount()).toBe(1);
    expect(storage.embeddingConfig.getLane("code")?.model).toBe("code-b");

    const resume = new StubCodeEmbedder(384);
    const report = await run(resume, { model: "code-b" });
    expect(report.rebuilt).toBeUndefined();
    expect(report).toMatchObject({ total: 2, succeeded: 2 });
    expect(vecCount()).toBe(3);
  });

  it('onStale "skip" writes nothing when the lane is stale', async () => {
    const embedder = new StubCodeEmbedder(384);
    const report = await run(embedder, { model: "code-b", onStale: "skip" });
    expect(report).toMatchObject({ stale: true, total: 0, succeeded: 0 });
    expect(embedder.calls).toBe(1);
    expect(vecDim()).toBe(768);
    expect(vecCount()).toBe(3);
    expect(storage.embeddingConfig.getLane("code")?.model).toBe("code-a");
  });

  it("dry-run reports the drop and writes nothing", async () => {
    const report = await run(new StubCodeEmbedder(384), { model: "code-b", dryRun: true });
    expect(report).toMatchObject({ dryRun: true, stale: true, total: 0 });
    expect(vecDim()).toBe(768);
    expect(vecCount()).toBe(3);
    expect(storage.embeddingConfig.getLane("code")?.model).toBe("code-a");
  });
});
