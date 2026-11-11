/**
 * T679 Part 3 — the two bulk exemplar sweeps (`pruneReverted`, `applyBucketCap`)
 * used to run their whole backlog through one `db.transaction`. better-sqlite3 is
 * synchronous, so that was one slice no HTTP request could interrupt, and it runs
 * on every scheduler tick whenever `NLM_CODE_EXEMPLARS_ENABLED=1`. The deletes are
 * now chunked with a yield between chunks; these tests pin the two things that must
 * survive that change: *which rows get deleted* (identical at any chunk size, and
 * the sweep guard still gets to refuse) and *that the chunk boundary is reached*
 * (counted through the injected yield function — a timer would be a race, since a
 * sweep this small finishes inside one millisecond).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../../../src/core/storage/sqlite-session-store.js";
import {
  DEFAULT_EXEMPLAR_DELETE_CHUNK,
  SqliteCodeExemplarStore,
} from "../../../../src/core/storage/sqlite-code-exemplar-store.js";
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nlm-exemplar-sweep-"));
  sessions = new SqliteSessionStore({ dbPath: join(dir, "t.sqlite"), migrationsDir: MIGRATIONS });
});

afterEach(async () => {
  await sessions.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Store wired with the given chunk size and a counter for the between-chunk yield. */
function storeWith(opts: { chunk: number }): { store: SqliteCodeExemplarStore; yields: () => number } {
  let yields = 0;
  const store = new SqliteCodeExemplarStore(sessions.rawDb(), {
    deleteChunkRows: opts.chunk,
    yieldFn: () => {
      yields += 1;
      return Promise.resolve();
    },
  });
  return { store, yields: () => yields };
}

function rows(n: number, overrides: Partial<CodeExemplarInput> = {}): CodeExemplarInput[] {
  return Array.from({ length: n }, (_, i) => input(i, overrides));
}

function remainingCount(): number {
  return (
    sessions.rawDb().prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM code_exemplars").get()?.n ?? 0
  );
}

describe("pruneReverted bounded deletes", () => {
  // 12 rows total: the sweep guard only binds at >= 10 rows, and touching 5 of 12
  // stays under its refusal share, so this exercises the allowed path.
  const seedMixed = async (store: SqliteCodeExemplarStore) => {
    await store.insertMany(
      TENANT,
      Array.from({ length: 5 }, (_, i) => input(i, { survived: 0 })).concat(
        Array.from({ length: 7 }, (_, i) => input(i + 5, { survived: 1 })),
      ),
    );
  };

  it("deletes every reverted row across chunk boundaries, yielding between chunks", async () => {
    const { store, yields } = storeWith({ chunk: 2 });
    await seedMixed(store);
    expect(remainingCount()).toBe(12);

    const deleted = await store.pruneReverted(TENANT, SCOPE);

    expect(deleted).toBe(5);
    expect(remainingCount()).toBe(7);
    // 5 ids at 2 per chunk is 3 chunks, so 2 between-chunk yields.
    expect(yields()).toBe(2);
  });

  it("deletes the same rows whatever the chunk size", async () => {
    const big = storeWith({ chunk: DEFAULT_EXEMPLAR_DELETE_CHUNK });
    await seedMixed(big.store);
    const deletedBig = await big.store.pruneReverted(TENANT, SCOPE);
    const leftBig = remainingCount();

    const small = storeWith({ chunk: 1 });
    await seedMixed(small.store);
    const deletedSmall = await small.store.pruneReverted(TENANT, SCOPE);

    expect(deletedSmall).toBe(deletedBig);
    expect(remainingCount()).toBe(leftBig);
    // One yield per extra chunk: 5 ids, 1 per chunk.
    expect(small.yields()).toBe(4);
    // A chunk size that covers the backlog never yields.
    expect(big.yields()).toBe(0);
  });

  it("returns 0 without yielding when nothing is reverted", async () => {
    const { store, yields } = storeWith({ chunk: 1 });
    await store.insertMany(TENANT, rows(3, { survived: 1 }));
    expect(await store.pruneReverted(TENANT, SCOPE)).toBe(0);
    expect(yields()).toBe(0);
    expect(remainingCount()).toBe(3);
  });

  it("still lets the sweep guard refuse the whole run", async () => {
    // 12 reverted of 12: 100% share, above the guard's 80% ceiling.
    const { store, yields } = storeWith({ chunk: 2 });
    await store.insertMany(TENANT, rows(12, { survived: 0 }));
    expect(await store.pruneReverted(TENANT, SCOPE)).toBe(0);
    expect(yields()).toBe(0);
    expect(remainingCount()).toBe(12);
  });

  it("ignores a nonsense chunk size instead of looping forever", async () => {
    const zero = new SqliteCodeExemplarStore(sessions.rawDb(), { deleteChunkRows: 0 });
    await seedMixed(zero);
    expect(await zero.pruneReverted(TENANT, SCOPE)).toBe(5);
  });
});

describe("applyBucketCap bounded deletes", () => {
  it("keeps the newest maxPerBucket per bucket and yields between chunks", async () => {
    const { store, yields } = storeWith({ chunk: 2 });
    await store.insertMany(TENANT, rows(12));

    const deleted = await store.applyBucketCap(TENANT, SCOPE, 5);

    expect(deleted).toBe(7);
    // 7 doomed ids at 2 per chunk is 4 chunks, so 3 yields.
    expect(yields()).toBe(3);
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
  });

  it("deletes nothing when every bucket is already under the cap", async () => {
    const { store, yields } = storeWith({ chunk: 1 });
    await store.insertMany(TENANT, rows(3));
    expect(await store.applyBucketCap(TENANT, SCOPE, 50)).toBe(0);
    expect(yields()).toBe(0);
    expect(remainingCount()).toBe(3);
  });
});
