# Ingest Embed-Failure Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the currently-silent ingest embed failures observable — log every tolerated failure and expose an aggregate counter via `/api/health` — without changing the tolerate-and-continue behavior itself.

**Architecture:** Add a small in-memory counter module in `src/core/health/` mirroring the existing `embedding-lane-state.ts` gauge. Increment it (and emit a `[nlm]` stderr line) at each of the four best-effort embed `catch` blocks in the two session stores. Surface the counter in the daemon's `GET /api/health` payload, which already assembles the sibling gauges.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, better-sqlite3 (SQLite store), node-postgres (PG store), Hono (HTTP).

## Global Constraints

- **No behavior change to the fallback.** The session/fact row still commits, subsequent chunks/facts still embed, nothing rolls back. This plan only adds observation.
- **Match the existing convention:** store-level best-effort failures use `process.stderr.write("[nlm] ...")` directly — no dependency-injected logger, no new constructor parameters.
- **The counter increments at all four sites**, including the PG chunk-embed catch that already logs, so the aggregate is complete.
- **Fact log format is identical across both stores:** `[nlm] embedding fact failed fact=<id>: <err>` (fact id only, no session id — the SQLite `embedFacts` method has no session id in scope, and fact id is globally unique).
- **The counter is a per-process in-memory gauge** (mirrors `embedding-lane-state.ts`); it resets on daemon restart and is read only by the daemon serving `/api/health`. Durable history and any CLI readout are out of scope.
- **`nlm-memory` is a PUBLIC repo.** No secrets or private data in code or commit messages.
- **Branch:** land on a branch cut from the intended base, not the currently-checked-out `fix/hook-env-lazy-reads-and-http-mcp-default`.

---

### Task 1: Embed-failure counter module

**Files:**
- Create: `src/core/health/embed-failure-state.ts`
- Test: `tests/unit/core/health/embed-failure-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type EmbedFailureKind = "chunk" | "fact"`
  - `recordEmbedFailure(kind: EmbedFailureKind): void`
  - `embedFailureSnapshot(): Readonly<Record<EmbedFailureKind, number>>`
  - `resetEmbedFailureForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/health/embed-failure-state.test.ts` (mirrors `embedding-lane-state.test.ts`):

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  embedFailureSnapshot,
  recordEmbedFailure,
  resetEmbedFailureForTests,
} from "../../../../src/core/health/embed-failure-state.js";

describe("embed failure state", () => {
  beforeEach(() => resetEmbedFailureForTests());

  it("both kinds default to zero", () => {
    const snap = embedFailureSnapshot();
    expect(snap.chunk).toBe(0);
    expect(snap.fact).toBe(0);
  });

  it("recordEmbedFailure increments the named kind only", () => {
    recordEmbedFailure("chunk");
    recordEmbedFailure("chunk");
    recordEmbedFailure("fact");
    const snap = embedFailureSnapshot();
    expect(snap.chunk).toBe(2);
    expect(snap.fact).toBe(1);
  });

  it("embedFailureSnapshot is frozen", () => {
    expect(Object.isFrozen(embedFailureSnapshot())).toBe(true);
  });

  it("resetEmbedFailureForTests zeroes all counts", () => {
    recordEmbedFailure("chunk");
    recordEmbedFailure("fact");
    resetEmbedFailureForTests();
    const snap = embedFailureSnapshot();
    expect(snap.chunk).toBe(0);
    expect(snap.fact).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/health/embed-failure-state.test.ts`
Expected: FAIL — cannot resolve `../../../../src/core/health/embed-failure-state.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/health/embed-failure-state.ts`:

```typescript
export type EmbedFailureKind = "chunk" | "fact";

const state: Record<EmbedFailureKind, number> = { chunk: 0, fact: 0 };

export function recordEmbedFailure(kind: EmbedFailureKind): void {
  state[kind] += 1;
}

export function embedFailureSnapshot(): Readonly<Record<EmbedFailureKind, number>> {
  return Object.freeze({ ...state });
}

export function resetEmbedFailureForTests(): void {
  state.chunk = 0;
  state.fact = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/health/embed-failure-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/health/embed-failure-state.ts tests/unit/core/health/embed-failure-state.test.ts
git commit -m "feat(health): add embed-failure counter gauge"
```

---

### Task 2: Instrument the SQLite store's two embed catches

**Files:**
- Modify: `src/core/storage/sqlite-session-store.ts` (chunk-embed catch ~:549; `embedFacts` catch inside the method at ~:671)
- Test: `tests/integration/embed-failure-sqlite.test.ts` (new)

**Interfaces:**
- Consumes: `recordEmbedFailure` from Task 1; `StubEmbedder`, `FixedEmbedder` from `tests/fixtures/llm-stubs.ts`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/embed-failure-sqlite.test.ts`. `makeRecord` is inlined so the test is self-contained (the `IngestRecord` shape is at `sqlite-session-store.ts:59`):

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import {
  embedFailureSnapshot,
  resetEmbedFailureForTests,
} from "../../src/core/health/embed-failure-state.js";
import { StubEmbedder, FixedEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const TENANT = "team_local";

function makeRecord(id: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: null,
    startedAt: "2026-08-08T00:00:00Z",
    endedAt: "2026-08-08T00:05:00Z",
    durationMin: 5,
    label: "embed failure fixture",
    summary: "a session whose chunks fail to embed",
    body: "chunk one body text. chunk two body text. enough content to chunk.",
    status: "idle",
    transcriptKind: null,
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: ["NLM"],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

describe("SQLite ingest embed-failure visibility", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    resetEmbedFailureForTests();
    tmp = mkdtempSync(join(tmpdir(), "nlm-embfail-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("counts chunk-embed failures, still commits the session", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("sess_fail"), new StubEmbedder({ fail: true }));
    expect(embedFailureSnapshot().chunk).toBeGreaterThanOrEqual(1);
    const row = await storage.sessions.getById(TENANT, "sess_fail");
    expect(row).not.toBeNull();
  });

  it("records zero failures on the success path", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("sess_ok"), new FixedEmbedder());
    expect(embedFailureSnapshot().chunk).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/embed-failure-sqlite.test.ts`
Expected: FAIL — first test asserts `chunk >= 1` but the counter stays 0 (the catch is currently silent).

- [ ] **Step 3: Implement — wire the two catches**

In `src/core/storage/sqlite-session-store.ts`, add the import near the other `@core` imports:

```typescript
import { recordEmbedFailure } from "@core/health/embed-failure-state.js";
```

Replace the chunk-embed catch (~:549) so it records and logs instead of swallowing:

```typescript
        } catch (err) {
          // Per-chunk embedder failure must not roll the ingest back or
          // abort subsequent chunks.
          recordEmbedFailure("chunk");
          process.stderr.write(`[nlm] embedding chunk failed session=${record.id} chunk=${chunkIdx}: ${String(err)}\n`);
        }
```

Replace the `embedFacts` catch (inside the method at ~:671):

```typescript
      } catch (err) {
        // Per-fact embedding failure must not abort embedding of subsequent
        // facts. The fact row stays current; semantic recall just misses it
        // until a future re-ingest.
        recordEmbedFailure("fact");
        process.stderr.write(`[nlm] embedding fact failed fact=${fact.id}: ${String(err)}\n`);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/embed-failure-sqlite.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/storage/sqlite-session-store.ts tests/integration/embed-failure-sqlite.test.ts
git commit -m "feat(ingest): surface SQLite embed failures via counter + stderr"
```

---

### Task 3: Instrument the Postgres store's two embed catches

**Files:**
- Modify: `src/core/storage/pg-session-store.ts` (chunk-embed catch ~:666 already logs — add the counter; fact-embed catch ~:681 is silent — add both)
- Test: `tests/integration/embed-failure-pg.pg.test.ts` (new; `.pg.test.ts` suffix so it runs only when a Postgres test DB is configured, matching the existing PG integration suite)

**Interfaces:**
- Consumes: `recordEmbedFailure` from Task 1; the existing PG test harness for standing up a store against a test database.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/embed-failure-pg.pg.test.ts`. Follow the setup of an existing `*.pg.test.ts` (e.g. `tests/integration/pg-fact-ingest.pg.test.ts`) for connecting to the test database and building the store; reuse that file's guard/skip pattern for when no PG DB is available. The new assertions:

```typescript
// ...standard PG test harness setup (mirror pg-fact-ingest.pg.test.ts):
//   resetEmbedFailureForTests() in beforeEach,
//   build a PgSessionStore `store` against the test DB,
//   define makeRecord() as in Task 2 (IngestRecord with a non-null body).

it("counts chunk-embed failures, still commits the session", async () => {
  await store.insertSession(TENANT, makeRecord("sess_pg_fail"), new StubEmbedder({ fail: true }));
  expect(embedFailureSnapshot().chunk).toBeGreaterThanOrEqual(1);
  const row = await store.getById(TENANT, "sess_pg_fail");
  expect(row).not.toBeNull();
});

it("records zero failures on the success path", async () => {
  await store.insertSession(TENANT, makeRecord("sess_pg_ok"), new FixedEmbedder());
  expect(embedFailureSnapshot().chunk).toBe(0);
});
```

Imports: `recordEmbedFailure`/`embedFailureSnapshot`/`resetEmbedFailureForTests` from `../../src/core/health/embed-failure-state.js`; `StubEmbedder`/`FixedEmbedder` from `../fixtures/llm-stubs.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/embed-failure-pg.pg.test.ts`
Expected: FAIL — `chunk` counter stays 0 (the PG chunk catch logs but does not record). If no PG DB is configured, the suite skips; provision the test DB the existing PG suite uses before running.

- [ ] **Step 3: Implement — wire the two catches**

In `src/core/storage/pg-session-store.ts`, add the import:

```typescript
import { recordEmbedFailure } from "@core/health/embed-failure-state.js";
```

Update the chunk-embed catch (~:666) to record alongside its existing log line:

```typescript
        } catch (err) {
          recordEmbedFailure("chunk");
          process.stderr.write(`[nlm] embedding chunk failed session=${record.id} chunk=${chunkIdx}: ${String(err)}\n`);
        }
```

Replace the silent fact-embed catch (~:681):

```typescript
          } catch (err) {
            // Tolerated; the fact row stays current, semantic recall misses
            // it until a future re-ingest.
            recordEmbedFailure("fact");
            process.stderr.write(`[nlm] embedding fact failed fact=${fact.id}: ${String(err)}\n`);
          }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/embed-failure-pg.pg.test.ts`
Expected: PASS (2 tests) against the configured PG test DB.

- [ ] **Step 5: Commit**

```bash
git add src/core/storage/pg-session-store.ts tests/integration/embed-failure-pg.pg.test.ts
git commit -m "feat(ingest): surface Postgres embed failures via counter, at store parity"
```

---

### Task 4: Surface the counter in `/api/health`

**Files:**
- Modify: `src/http/app.ts` (import at ~:112 alongside the sibling gauge imports; payload at ~:715)
- Test: `tests/integration/http.test.ts` — add a case in the existing `describe("HTTP adapter")` block, reusing its `app` (built via `createApp(...)` in `beforeEach` at ~:103; sibling health test at ~:117).

**Interfaces:**
- Consumes: `embedFailureSnapshot` from Task 1.
- Produces: an `embedFailures: { chunk: number; fact: number }` field on the `/api/health` JSON.

- [ ] **Step 1: Write the failing test**

Add the import at the top of `tests/integration/http.test.ts`:

```typescript
import { resetEmbedFailureForTests } from "../../src/core/health/embed-failure-state.js";
```

Add this case inside the `describe("HTTP adapter")` block (reuses the block's `app`):

```typescript
it("GET /api/health includes embedFailures counts", async () => {
  resetEmbedFailureForTests();
  const res = await app.request("/api/health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { embedFailures?: { chunk: number; fact: number } };
  expect(body.embedFailures).toEqual({ chunk: 0, fact: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/http.test.ts`
Expected: FAIL — `body.embedFailures` is `undefined`.

- [ ] **Step 3: Implement — add the import and payload field**

In `src/http/app.ts`, add alongside the sibling gauge imports (~:112):

```typescript
import { embedFailureSnapshot } from "@core/health/embed-failure-state.js";
```

Add the field to the `/api/health` response object (~:715), next to `embedInflight`:

```typescript
    return c.json({ status: "ok", service: "nlm-memory", version: pkg.version, warmup: warmupSnapshot(), embedding: laneHealthSnapshot(), embedInflight: inflightSnapshot(), embedFailures: embedFailureSnapshot(), corpus, update, job });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/app.ts tests/integration/http.test.ts
git commit -m "feat(health): expose embed-failure counts on /api/health"
```

---

## Final verification

- [ ] Run the full suite: `npx vitest run` (PG-suffixed tests require the configured PG test DB; skip is acceptable if that DB is intentionally absent, but Task 3's file must pass wherever the rest of the PG suite runs).
- [ ] Typecheck: `npx tsc --noEmit`.
- [ ] Confirm no behavior regression: an ingest with a failing embedder still commits the session and continues past the failed chunk/fact (asserted by Tasks 2 and 3).
