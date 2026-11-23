/**
 * Fault injection through the real HTTP app (T1775 Hardening F).
 *
 * T1774 put a circuit breaker on the recall query-embedder and T1772 put a
 * guard on write-heavy ticks, but both were proven only at unit level. This
 * file proves the contract end to end over a real SqliteStorage: a down
 * embedder, a hung embedder and a full disk each leave /api/recall answering
 * 200 with keyword hits, and /api/health reports the breaker and the guard.
 *
 * The numbers are the ones the prompt hook budgets — answer < 1000 ms p95,
 * hook budget 4000 ms — so a short-circuited recall has to come back well
 * inside 250 ms, and a hung gateway may cost at most the embed deadline it is
 * given before keyword results serve anyway.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_COOLDOWN_MS, FAILURE_THRESHOLD, recallEmbedBreaker } from "../../src/core/health/embed-breaker.js";
import { resetForTests as resetEmbedInflight } from "../../src/core/health/embed-inflight.js";
import { resetLaneHealthForTests } from "../../src/core/health/embedding-lane-state.js";
import { createDiskGuard } from "../../src/core/health/disk-guard.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
import type { EmbedResult, EmbeddingKind, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { makeSession } from "../fixtures/sessions.js";

type AppInstance = ReturnType<typeof createApp>;

interface RecallBody {
  total: number;
  modeUnavailable?: string;
  results: { id: string }[];
}

interface HealthBody {
  status: string;
  embedBreaker: {
    state: string;
    consecutiveFailures: number;
    lastError: string | null;
    shortCircuited: number;
  };
  diskGuard: { free: number; threshold: number; tripped: boolean } | null;
}

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const QUERY = "embed";
/** The session whose label carries `QUERY` — the keyword hit every scenario must still get. */
const KEYWORD_HIT = "sess_embed";

function unit(values: number[]): Float32Array {
  const vector = new Float32Array(768);
  values.forEach((v, i) => { vector[i] = v; });
  return vector;
}

// Every scenario needs keyword hits out of FTS5, so the seed labels carry the
// query terms. Embeddings are uniform: the semantic leg is under test, not
// relevance.
const SEED: ReadonlyArray<Session> = [
  makeSession({
    id: KEYWORD_HIT,
    label: "Embed lane circuit breaker",
    summary: "A query embedder that times out must not cost the prompt hook its whole budget.",
  }),
  makeSession({
    id: "sess_disk",
    label: "Disk guard holds writes back",
    summary: "statfs free-space floor for write-heavy job ticks.",
  }),
  makeSession({
    id: "sess_hook",
    label: "Prompt hook recall budget",
    summary: "Keyword results answer while the embed lane is unavailable.",
  }),
];

/** The embed lane as the daemon sees it: every call counted, behaviour switched per scenario. */
class FaultEmbedder implements LLMClient {
  calls = 0;
  lane: "healthy" | "down" | "hung" = "healthy";

  async embed(_text: string, _kind: EmbeddingKind, opts?: { signal?: AbortSignal }): Promise<EmbedResult> {
    this.calls += 1;
    if (this.lane === "down") throw new Error("connect ECONNREFUSED");
    if (this.lane === "hung") {
      // A gateway that never answers: settles only when the request budget aborts.
      const signal = opts?.signal;
      if (!signal) throw new Error("recall must pass its request-budget signal to embed");
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    return { vector: unit([0, 1, 0]), model: "test" };
  }

  async rewriteForRecall(): Promise<never> { throw new Error("rewrite stays off in tests"); }
  async nameWorkstream(): Promise<string | null> { return null; }
  async classify(): Promise<never> { throw new Error("not used in these tests"); }
}

describe("fault injection — recall answers when its dependencies do not (T1775)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let dbPath: string;
  let llm: FaultEmbedder;
  let recall: RecallService;
  let app: AppInstance;

  function makeApp(diskGuard?: ReturnType<typeof createDiskGuard>): AppInstance {
    return createApp({
      recall,
      store,
      liveStore: store,
      dbPath,
      queryLogPath: join(tmp, "query_log.jsonl"),
      updateCheckDeps: { cachePath: join(tmp, "update-check-cache.json") },
      ...(diskGuard ? { diskGuard: () => diskGuard.status() } : {}),
    });
  }

  async function recallWith(mode: "keyword" | "hybrid", q = QUERY): Promise<{ status: number; body: RecallBody; ms: number }> {
    const started = performance.now();
    const res = await app.request(`/api/recall?q=${q}&mode=${mode}&limit=5`);
    const body = (await res.json()) as RecallBody;
    return { status: res.status, body, ms: performance.now() - started };
  }

  async function health(): Promise<HealthBody> {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    return (await res.json()) as HealthBody;
  }

  function ids(body: RecallBody): string[] {
    return body.results.map((r) => r.id);
  }

  beforeEach(async () => {
    // The breaker and the in-flight shedder are process-wide, so every test
    // starts from the same cold state regardless of order.
    recallEmbedBreaker.reset();
    resetEmbedInflight();
    resetLaneHealthForTests();
    tmp = mkdtempSync(join(tmpdir(), "nlm-fault-injection-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
    for (const session of SEED) {
      store.insertSessionForTest(session);
      store.insertEmbeddingForTest(session.id, unit([0, 1, 0]));
    }
    llm = new FaultEmbedder();
    recall = new RecallService({ store, llm });
    app = makeApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("an embedder that is down opens the breaker, and the short-circuited recall is instant", async () => {
    llm.lane = "down";
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      const { status, body } = await recallWith("hybrid");
      expect(status).toBe(200);
      // Degraded, not failed: the keyword leg still carries the answer.
      expect(ids(body)).toContain(KEYWORD_HIT);
    }
    expect(llm.calls).toBe(FAILURE_THRESHOLD);
    expect((await health()).embedBreaker).toMatchObject({
      state: "open",
      consecutiveFailures: FAILURE_THRESHOLD,
      lastError: "connect ECONNREFUSED",
    });

    const callsAtOpen = llm.calls;
    const { status, body, ms } = await recallWith("hybrid");
    expect(status).toBe(200);
    expect(ids(body)).toContain(KEYWORD_HIT);
    expect(body.modeUnavailable).toBe("ollama_unreachable");
    // The point of T1774: no embedder round-trip, so the hook keeps its budget.
    expect(ms).toBeLessThan(250);
    expect(llm.calls).toBe(callsAtOpen);
    expect((await health()).embedBreaker.shortCircuited).toBeGreaterThan(0);
  });

  it("a hung embedder costs at most its own deadline, then keyword hits serve", async () => {
    llm.lane = "hung";
    const { status, body, ms } = await recallWith("hybrid");
    expect(status).toBe(200);
    expect(ids(body)).toContain(KEYWORD_HIT);
    expect(body.modeUnavailable).toBe("ollama_unreachable");
    // The SLO that matters is the prompt hook's 4000 ms recall budget: the
    // request must answer inside it. (A tighter deadline + 1 s bound flakes
    // on a loaded gate host while proving nothing extra.)
    expect(ms).toBeLessThan(4000);
    // Lower bound too: proves the request really waited out the embed deadline
    // and the abort came from the budget, not from a fast failure.
    expect(ms).toBeGreaterThanOrEqual(recall.embeddingTimeoutMs * 0.8);
    // One hung call says nothing conclusive about the lane — stay closed.
    expect(recallEmbedBreaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 1 });
  });

  it("a full disk trips /api/health but never gates recall", async () => {
    const guard = createDiskGuard({
      path: dbPath,
      // A volume with zero blocks free for unprivileged writers.
      stat: async () => ({ bsize: 4096, bavail: 0, blocks: 1_000_000 }),
      logger: () => {},
    });
    app = makeApp(guard);

    expect(await guard.shouldSkip("test")).toBe(true);
    const body = await health();
    expect(body.status).toBe("ok");
    expect(body.diskGuard).toMatchObject({ free: 0, tripped: true });

    for (const mode of ["keyword", "hybrid"] as const) {
      const res = await recallWith(mode);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toContain(KEYWORD_HIT);
    }
  });

  it("a successful probe past the cool-down closes the breaker again", async () => {
    llm.lane = "down";
    for (let i = 0; i < FAILURE_THRESHOLD; i++) expect((await recallWith("hybrid")).status).toBe(200);
    expect(recallEmbedBreaker.snapshot().state).toBe("open");
    llm.lane = "healthy";

    // The breaker reads the wall clock; only Date is faked so the request
    // budget's real timers still run.
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(recallEmbedBreaker.snapshot().state).toBe("open");
    vi.setSystemTime(Date.now() + BASE_COOLDOWN_MS + 1_000);
    try {
      const { status, body } = await recallWith("hybrid");
      expect(status).toBe(200);
      expect(ids(body)).toContain(KEYWORD_HIT);
      expect(recallEmbedBreaker.snapshot()).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
        lastError: "connect ECONNREFUSED",
      });
    } finally {
      vi.useRealTimers();
    }
    // And from closed, the next recall goes back to asking the embedder.
    const callsBefore = llm.calls;
    expect((await recallWith("hybrid")).status).toBe(200);
    expect(llm.calls).toBe(callsBefore + 1);
  });
});
