import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FactJudge,
  buildJudgePrompt,
  findCandidates,
  judgeFact,
  judgeModeFromEnv,
  parseJudgeReply,
} from "../../../../src/core/facts/write-judge.js";
import { createLimiter } from "../../../../src/core/classifier/inflight-limiter.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { LLMUnreachableError, type LLMClient } from "../../../../src/ports/llm-client.js";
import type { Fact } from "../../../../src/shared/types.js";

const T = "team_local";
const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

function fact(id: string, over: Partial<Fact> = {}): Fact {
  return {
    id,
    kind: "attribute",
    subject: "widget",
    predicate: "owner",
    value: "alice",
    sourceSessionId: "s1",
    sourceQuote: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededBy: null,
    confidence: 0.9,
    ...over,
  };
}

function llm(replies: Array<string | Error>): LLMClient & { calls: number } {
  const c = {
    calls: 0,
    complete: async () => {
      const r = replies[Math.min(c.calls, replies.length - 1)]!;
      c.calls += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return c as unknown as LLMClient & { calls: number };
}

const fast = { limiter: createLimiter(1), sleep: async () => {} };

describe("judgeModeFromEnv", () => {
  it("defaults to off and rejects unknown values", () => {
    expect(judgeModeFromEnv({})).toBe("off");
    expect(judgeModeFromEnv({ NLM_FACT_JUDGE: "bogus" })).toBe("off");
    expect(judgeModeFromEnv({ NLM_FACT_JUDGE: "Shadow" })).toBe("shadow");
    expect(judgeModeFromEnv({ NLM_FACT_JUDGE: "on" })).toBe("on");
  });
});

describe("parseJudgeReply", () => {
  const cands = [fact("a"), fact("b")];
  it("maps labels to candidate ids", () => {
    const d = parseJudgeReply('```json\n{"action":"supersede_old","target":"e2","reason":"newer"}\n```', cands);
    expect(d).toEqual({ action: "SUPERSEDE_OLD", targetId: "b", reason: "newer" });
  });
  it("strips think blocks and surrounding prose", () => {
    const d = parseJudgeReply('<think>hmm</think> Answer: {"action":"KEEP_BOTH","target":null,"reason":"x"}', cands);
    expect(d?.action).toBe("KEEP_BOTH");
  });
  it.each([
    "not json",
    '{"action":"DELETE","target":"e1"}',
    '{"action":"SKIP_NEW"}',
    '{"action":"SKIP_NEW","target":"e9"}',
    '{"action":"SUPERSEDE_OLD","target":"a"}',
    "[1]",
  ])("rejects %s", (raw) => {
    expect(parseJudgeReply(raw, cands)).toBeNull();
  });
});

describe("judgeFact", () => {
  const fresh = fact("n", { value: "bob" });
  it("skips the model when there are no candidates", async () => {
    const m = llm(["x"]);
    const o = await judgeFact({ llm: m, ...fast }, fresh, []);
    expect(o.decision.action).toBe("KEEP_BOTH");
    expect(m.calls).toBe(0);
  });
  it("falls back to KEEP_BOTH on a malformed reply", async () => {
    const o = await judgeFact({ llm: llm(["gibberish"]), ...fast }, fresh, [fact("a")]);
    expect(o.decision.action).toBe("KEEP_BOTH");
    expect(o.fallback).toBe("invalid reply");
  });
  it("retries a transient error with backoff then succeeds", async () => {
    const delays: number[] = [];
    const m = llm([
      new LLMUnreachableError("x", "status 503"),
      '{"action":"SUPERSEDE_OLD","target":"e1","reason":"r"}',
    ]);
    const o = await judgeFact({ llm: m, limiter: createLimiter(1), sleep: async (ms) => void delays.push(ms) }, fresh, [fact("a")]);
    expect(o.decision).toMatchObject({ action: "SUPERSEDE_OLD", targetId: "a" });
    expect(delays).toEqual([500]);
  });
  it("does not retry a non-transient error and returns KEEP_BOTH", async () => {
    const m = llm([new LLMUnreachableError("x", "status 400")]);
    const o = await judgeFact({ llm: m, ...fast }, fresh, [fact("a")]);
    expect(o.decision.action).toBe("KEEP_BOTH");
    expect(m.calls).toBe(1);
    expect(o.fallback).toMatch(/llm error/);
  });
  it("gives up after the attempt cap on persistent transient errors", async () => {
    const m = llm([new LLMUnreachableError("x", "status 503")]);
    const o = await judgeFact({ llm: m, ...fast }, fresh, [fact("a")]);
    expect(o.decision.action).toBe("KEEP_BOTH");
    expect(m.calls).toBe(3);
  });
  it("prompt lists labelled candidates", () => {
    expect(buildJudgePrompt(fresh, [fact("a")])).toContain("e1 (2026-01-01): widget | owner | alice");
  });
});

describe("FactJudge against a real store", () => {
  let dir: string;
  let storage: SqliteStorage;
  let logPath: string;
  let auditPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-judge-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    logPath = join(dir, "judge.jsonl");
    auditPath = join(dir, "audit.jsonl");
    const db = storage.rawDb();
    db.prepare(
      `INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, status, body, transcript_kind)
       VALUES ('s1','claude-code','r1','2026-01-01T00:00:00Z','l','s','closed','b','jsonl')`,
    ).run();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async (...fs: Fact[]) => {
    for (const f of fs) await storage.facts.insert(T, f);
  };
  const activeIds = async () => (await storage.facts.list(T, { subject: "widget", limit: 50 })).map((f) => f.id).sort();
  const logLines = () => readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const supersede = '{"action":"SUPERSEDE_OLD","target":"e1","reason":"newer"}';

  it("off does nothing and writes no log", async () => {
    await seed(fact("old"), fact("new", { value: "bob", createdAt: "2026-02-01T00:00:00.000Z" }));
    const j = new FactJudge({ store: storage.facts, llm: llm([supersede]), mode: "off", logPath, ...fast });
    expect(await j.run(T, [fact("new")])).toEqual([]);
    expect(await activeIds()).toEqual(["new", "old"]);
  });

  it("shadow logs the decision and changes no row", async () => {
    await seed(fact("old"), fact("new", { value: "bob", createdAt: "2026-02-01T00:00:00.000Z" }));
    const j = new FactJudge({ store: storage.facts, llm: llm([supersede]), mode: "shadow", logPath, ...fast });
    const out = await j.run(T, [fact("new", { value: "bob" })]);
    expect(out[0]!.decision).toMatchObject({ action: "SUPERSEDE_OLD", targetId: "old" });
    expect(await activeIds()).toEqual(["new", "old"]);
    expect(logLines()[0]).toMatchObject({ mode: "shadow", newId: "new", action: "SUPERSEDE_OLD", applied: false });
  });

  it("on supersedes the old fact, keeping its row", async () => {
    await seed(fact("old"), fact("new", { value: "bob", createdAt: "2026-02-01T00:00:00.000Z" }));
    const j = new FactJudge({ store: storage.facts, llm: llm([supersede]), mode: "on", logPath, auditPath, ...fast });
    await j.run(T, [fact("new", { value: "bob" })]);
    expect(await activeIds()).toEqual(["new"]);
    expect((await storage.facts.getById(T, "old"))?.supersededBy).toBe("new");
    expect(logLines()[0]).toMatchObject({ applied: true });
  });

  it("on SKIP_NEW marks the new fact superseded by the existing one", async () => {
    await seed(fact("old"), fact("new", { createdAt: "2026-02-01T00:00:00.000Z" }));
    const j = new FactJudge({
      store: storage.facts,
      llm: llm(['{"action":"SKIP_NEW","target":"e1","reason":"dup"}']),
      mode: "on",
      logPath,
      auditPath,
      ...fast,
    });
    await j.run(T, [fact("new")]);
    expect(await activeIds()).toEqual(["old"]);
    expect((await storage.facts.getById(T, "new"))?.supersededBy).toBe("old");
  });

  it("the sweep guard refuses a burst that would supersede too large a share", async () => {
    const olds = Array.from({ length: 10 }, (_, i) => fact(`o${i}`, { subject: `s${i}` }));
    const news = Array.from({ length: 10 }, (_, i) => fact(`n${i}`, { subject: `s${i}`, value: "bob", createdAt: "2026-02-01T00:00:00.000Z" }));
    await seed(...olds, ...news);
    const j = new FactJudge({ store: storage.facts, llm: llm([supersede]), mode: "on", maxShare: 0.5, logPath, auditPath, ...fast });
    await j.run(T, news);
    const all = await storage.facts.list(T, { subject: "s0", limit: 5 });
    expect(all.map((f) => f.id).sort()).toEqual(["n0", "o0"]);
    expect(logLines().every((l) => l.applied === false)).toBe(true);
    expect(logLines()[0].guard).toMatch(/would touch/);
  });

  it("two facts that pick each other cannot both be superseded", async () => {
    await seed(fact("a"), fact("b", { value: "bob" }));
    const j = new FactJudge({ store: storage.facts, llm: llm([supersede]), mode: "on", logPath, auditPath, ...fast });
    await j.run(T, [fact("a"), fact("b", { value: "bob" })]);
    expect((await activeIds()).length).toBe(1);
  });

  it("findCandidates returns active same-key facts only, excluding the fact itself", async () => {
    await seed(
      fact("a"),
      fact("gone", { supersededBy: "a" }),
      fact("other", { predicate: "status" }),
      fact("n", { value: "bob" }),
    );
    const c = await findCandidates(storage.facts, T, fact("n", { value: "bob" }));
    expect(c.map((f) => f.id)).toEqual(["a"]);
  });
});
