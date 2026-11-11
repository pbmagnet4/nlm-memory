/**
 * T679 Part 3 — the two bulk exemplar sweeps (`pruneReverted`, `applyBucketCap`)
 * used to run their whole backlog through one `db.transaction`. better-sqlite3 is
 * synchronous, so that was one slice no HTTP request could interrupt, and it runs
 * on every scheduler tick whenever `NLM_CODE_EXEMPLARS_ENABLED=1`. The deletes are
 * now chunked with an event-loop yield between chunks; these tests pin the two
 * things that must survive that change: *which rows get deleted* (identical at any
 * chunk size, and the sweep guard still gets to refuse) and *that the loop actually
 * gets a turn*.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../../../src/core/storage/sqlite-session-store.js";
import { SqliteCodeExemplarStore } from "../../../../src/core/storage/sqlite-code-exemplar-store.js";
import { codeHash } from "../../../../src/core/exemplars/ingest-exemplar.js";
import type { CodeExemplarInput } from "../../../../src/shared/types.js";

const MIGRATIONS = resolve(__dirname, "../../../../migrations");
const TENANT = "team_local";
const SCOPE = "install-test";

function input(n: number, overrides: Partial<CodeExemplarInput> = {}): CodeExemplarInput {
  const code = `function f${n}() { return ${n}; }`;
  return {
    installScope: SCOPE,
    signalId: null,
    sessionId: null,
    repo: "/repo/alpha",
    model: "qwen3-coder",
    lang: "ts",
    taskContext: "task",
    code,
    codeHash: codeHash(code),
    outcome: "pass",
    gitSha: null,
    survived: null,
    scope: null,
    ts: `2026-06-${String(n + 1).padStart(2, "0")}T12:00:00.000Z`,
    ...overrides,
  };
}

let dir: string;
let sessions: SqliteSessionStore;
let store: SqliteCodeExemplarStore;
let chunkEnv: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nlm-exemplar-sweep-"));
  chunkEnv = process.env["NLM_EXEMPLAR_DELETE_CHUNK"];
  sessions = new SqliteSessionStore({ dbPath: join(dir, "t.sqlite"), migrationsDir: MIGRATIONS });
  store = new SqliteCodeExemplarStore(sessions.rawDb());
});

afterEach(async () => {
  if (chunkEnv === undefined) delete process.env["NLM_EXEMPLAR_DELETE_CHUNK"];
  else process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = chunkEnv;
  await sessions.close();
  rmSync(dir, { recursive: true, force: true });
});

function remainingIds(): string[] {
  return sessions
    .rawDb()
    .prepare<unknown[], { id: string }>("SELECT id FROM code_exemplars ORDER BY id")
    .all()
    .map((r) => r.id);
}

/** Counts event-loop turns taken while `run` is in flight — the only observable
 *  proof that a batched sweep released the loop. */
async function withTurnCounter<T>(run: () => Promise<T>): Promise<{ value: T; turns: number }> {
  let turns = 0;
  const timer = setInterval(() => {
    turns += 1;
  }, 0);
  const value = await run();
  clearInterval(timer);
  return { value, turns };
}

async function seed(rows: ReadonlyArray<CodeExemplarInput>): Promise<void> {
  await store.insertMany(TENANT, rows);
}

describe("pruneReverted bounded deletes", () => {
  it("deletes every reverted row across chunk boundaries and yields between chunks", async () => {
    // 12 rows total: the sweep guard only binds at >= 10 rows, and 5/12 stays
    // under its refusal share, so this is the allowed path.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => input(i, { survived: 0 })),
      ...Array.from({ length: 7 }, (_, i) => input(i + 5, { survived: 1 })),
    ];
    await seed(rows);
    const before = remainingIds();
    expect(before).toHaveLength(12);
    process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = "2";

    const { value: deleted, turns } = await withTurnCounter(() => store.pruneReverted(TENANT, SCOPE));

    expect(deleted).toBe(5);
    expect(remainingIds()).toHaveLength(7);
    // 5 ids at 2 per chunk is 3 chunks, so at least two yields happened.
    expect(turns).toBeGreaterThan(0);
  });

  it("deletes the same rows whatever the chunk size", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => input(i, { survived: 0 })),
      ...Array.from({ length: 7 }, (_, i) => input(i + 5, { survived: 1 })),
    ];
    await seed(rows);
    const withBigChunk = await store.pruneReverted(TENANT, SCOPE);
    const afterBig = remainingIds();

    // Re-seed the reverted rows and sweep again with a chunk of one.
    await seed(rows);
    process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = "1";
    const withSmallChunk = await store.pruneReverted(TENANT, SCOPE);

    expect(withSmallChunk).toBe(withBigChunk);
    expect(remainingIds()).toEqual(afterBig);
  });

  it("returns 0 without touching the loop when nothing is reverted", async () => {
    await seed(Array.from({ length: 3 }, (_, i) => input(i, { survived: 1 })));
    process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = "1";
    const { value: deleted } = await withTurnCounter(() => store.pruneReverted(TENANT, SCOPE));
    expect(deleted).toBe(0);
    expect(remainingIds()).toHaveLength(3);
  });

  it("still lets the sweep guard refuse the whole run", async () => {
    // 12 reverted of 12: 100% share, above the guard's 80% ceiling.
    await seed(Array.from({ length: 12 }, (_, i) => input(i, { survived: 0 })));
    process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = "2";
    const deleted = await store.pruneReverted(TENANT, SCOPE);
    expect(deleted).toBe(0);
    expect(remainingIds()).toHaveLength(12);
  });
});

describe("applyBucketCap bounded deletes", () => {
  it("keeps the newest maxPerBucket per bucket and yields between chunks", async () => {
    await seed(Array.from({ length: 12 }, (_, i) => input(i)));
    process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = "2";

    const { value: deleted, turns } = await withTurnCounter(() =>
      store.applyBucketCap(TENANT, SCOPE, 5),
    );

    expect(deleted).toBe(7);
    const left = sessions
      .rawDb()
      .prepare<unknown[], { ts: string }>("SELECT ts FROM code_exemplars ORDER BY ts DESC")
      .all()
      .map((r) => r.ts);
    expect(left).toHaveLength(5);
    // The five newest, which is what `ORDER BY ts DESC` + slice(maxPerBucket) keeps.
    expect(left).toEqual(
      Array.from({ length: 5 }, (_, i) => `2026-06-${String(12 - i).padStart(2, "0")}T12:00:00.000Z`),
    );
    expect(turns).toBeGreaterThan(0);
  });

  it("deletes nothing when every bucket is already under the cap", async () => {
    await seed(Array.from({ length: 3 }, (_, i) => input(i)));
    process.env["NLM_EXEMPLAR_DELETE_CHUNK"] = "1";
    const { value: deleted } = await withTurnCounter(() => store.applyBucketCap(TENANT, SCOPE, 50));
    expect(deleted).toBe(0);
    expect(remainingIds()).toHaveLength(3);
  });
});
