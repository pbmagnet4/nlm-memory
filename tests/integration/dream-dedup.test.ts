/**
 * T1610 — dedup dream pass, integration tests against a fixture DB.
 *
 * Drives runDedupPass (and the scheduler registration) over real
 * SqliteStorage rows with the deterministic scoring core
 * (dream/fact-dedup.ts) — no LLM lane anywhere:
 *  - dry-run (the default) reports merge proposals and writes nothing;
 *  - apply supersedes each loser into its winner — row kept, superseded_by
 *    pointing at the winner, supersedence-log reason naming the merge class
 *    and evidence — and leaves unrelated facts alone;
 *  - the pass is disabled by default: registered only behind
 *    NLM_DREAM_DEDUP_PASS, report-only unless NLM_DREAM_DEDUP_APPLY is set.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { IngestRecord, SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import {
  registerDedupPass,
  runDedupPass,
  sampleActiveFactsSqlite,
  type DedupFact,
  type DedupPassSpec,
} from "../../src/core/dream/dedup-pass.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import {
  getDreamSettings,
  lastRuns,
  reseedDreamSettings,
  resetLastRuns,
  updateDreamSettings,
} from "../../src/core/dream/settings.js";
import type { LLMClient } from "../../src/ports/llm-client.js";
import type { Fact } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const SESSION_ID = "cc_dedup_src";

interface FactState {
  present: boolean;
  supersededBy: string | null;
}

function factState(dbPath: string, factId: string): FactState {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare<[string], { superseded_by: string | null }>(
        "SELECT superseded_by FROM facts WHERE id = ?",
      )
      .get(factId);
    if (!row) return { present: false, supersededBy: null };
    return { present: true, supersededBy: row.superseded_by };
  } finally {
    db.close();
  }
}

function makeRecord(): IngestRecord {
  return {
    id: SESSION_ID,
    runtime: "claude-code",
    runtimeSessionId: "dedup-1",
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "Stack discussion",
    summary: "Stack history",
    body: "USER: what does the api run on?\nASSISTANT: Fastify web framework, deployed on the edge runtime.",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

/** One shared source session keeps every corroboration count at 1, so the
 *  scoring core's winner is decided by createdAt — deterministic losers. */
function dedupFact(overrides: Partial<Fact>): Fact {
  return makeFact({
    id: `fact_${Math.random().toString(36).slice(2, 10)}`,
    kind: "attribute",
    subject: "whtnxt-api",
    predicate: "framework",
    value: "Fastify",
    sourceSessionId: SESSION_ID,
    sourceQuote: null,
    createdAt: "2026-05-10T00:00:00Z",
    ...overrides,
  });
}

/** The fixture corpus: an exact-duplicate pair, a restatement pair, one
 *  unrelated active fact, and one already-superseded fact (pointer written
 *  straight to the table) that the sampler must never propose on. */
async function insertCorpus(facts: SqliteFactStore): Promise<void> {
  await facts.insertMany(DEFAULT_TEAM_ID, [
    dedupFact({ id: "d_win", value: "Fastify web framework", createdAt: "2026-05-12T00:00:00Z" }),
    dedupFact({ id: "d_lose", value: "Fastify web framework.", createdAt: "2026-05-11T00:00:00Z" }),
    dedupFact({ id: "r_win", predicate: "deploy-target", value: "Edge runtime deployment", createdAt: "2026-05-14T00:00:00Z" }),
    dedupFact({ id: "r_lose", predicate: "deploy-target", value: "Edge runtime", createdAt: "2026-05-13T00:00:00Z" }),
    dedupFact({ id: "d_other", predicate: "language", value: "TypeScript", createdAt: "2026-05-09T00:00:00Z" }),
    dedupFact({ id: "a_win", predicate: "hosting-region", value: "the northern region", createdAt: "2026-05-08T00:00:00Z" }),
    dedupFact({ id: "a_lost", predicate: "hosting-region", value: "the southern region", createdAt: "2026-05-07T00:00:00Z" }),
  ]);
}

/** a_lost carries a successor already — the pass must leave it out of the
 *  sampled slice entirely. Written straight to the table so no ingest path
 *  gets to re-decide it. */
function markSupersededByHand(sessions: SqliteSessionStore): void {
  sessions.rawDb().prepare("UPDATE facts SET superseded_by = ? WHERE id = ?").run("a_win", "a_lost");
}

function defaultOptions(
  tmp: string,
  deps: { facts: SqliteFactStore; sessions: SqliteSessionStore },
) {
  return {
    facts: deps.facts,
    sampleFacts: (limit: number) =>
      Promise.resolve(sampleActiveFactsSqlite(deps.sessions.rawDb(), DEFAULT_TEAM_ID, limit)),
    supersedenceLogPath: join(tmp, "supersedence-log.jsonl"),
    logger: () => {},
  };
}

function logEntries(path: string): Array<Record<string, string>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, string>);
}

const unusedLlm = { complete: async () => "" } as unknown as LLMClient;

describe("dream dedup pass", () => {
  let tmp: string;
  let dbPath: string;
  let storage: SqliteStorage;
  let sessions: SqliteSessionStore;
  let facts: SqliteFactStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-dedup-pass-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    sessions = storage.sessions;
    facts = storage.facts;
    await sessions.insertSession(DEFAULT_TEAM_ID, makeRecord());
    await insertCorpus(facts);
    markSupersededByHand(sessions);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run (default) reports merge proposals but writes nothing", async () => {
    const options = defaultOptions(tmp, { facts, sessions });

    const report = await runDedupPass(options);

    // a_lost is superseded, so it never enters the sampled slice.
    expect(report).toMatchObject({
      apply: false,
      sampled: 6,
      proposals: 2,
      exact: 1,
      restatement: 1,
      superseded: 0,
      errors: 0,
    });
    const exact = report.findings.find((f) => f.cls === "exact");
    expect(exact).toMatchObject({ winnerId: "d_win", loserId: "d_lose", superseded: false });
    expect(exact!.reason).toContain("dream-dedup");
    expect(exact!.proposalReason).toContain("fact-dedup exact");
    expect(report.findings.find((f) => f.cls === "restatement")).toMatchObject({
      winnerId: "r_win",
      loserId: "r_lose",
      superseded: false,
    });
    // Nothing written anywhere: every fact still active, no audit entry.
    for (const id of ["d_win", "d_lose", "r_win", "r_lose", "d_other", "a_win"]) {
      expect(factState(dbPath, id)).toEqual({ present: true, supersededBy: null });
    }
    expect(existsSync(options.supersedenceLogPath)).toBe(false);
  });

  it("apply supersedes each loser into its winner with a reason, never deleting rows", async () => {
    const options = { ...defaultOptions(tmp, { facts, sessions }), apply: true };

    const report = await runDedupPass(options);

    expect(report).toMatchObject({ apply: true, proposals: 2, superseded: 2, errors: 0 });

    // Explicit mark, never a hard merge: both rows survive, the loser points
    // at the winner, unrelated facts are untouched.
    expect(factState(dbPath, "d_lose")).toEqual({ present: true, supersededBy: "d_win" });
    expect(factState(dbPath, "r_lose")).toEqual({ present: true, supersededBy: "r_win" });
    for (const id of ["d_win", "r_win", "d_other", "a_win"]) {
      expect(factState(dbPath, id)).toEqual({ present: true, supersededBy: null });
    }

    // Audit trail: one entry per merged loser, reason explaining the merge.
    const entries = logEntries(options.supersedenceLogPath);
    expect(entries).toHaveLength(2);
    const byLoser = new Map(entries.map((e) => [e.fact_id, e]));
    expect(byLoser.get("d_lose")).toMatchObject({
      kind: "fact",
      fact_id: "d_lose",
      source: "dream-dedup-pass",
    });
    expect(byLoser.get("d_lose")!.reason).toContain("dream-dedup");
    expect(byLoser.get("d_lose")!.reason).toContain("fact-dedup exact");
    expect(byLoser.get("d_lose")!.reason).toContain("superseded fact d_lose into d_win");
    expect(byLoser.get("r_lose")!.reason).toContain("fact-dedup restatement");
    expect(report.findings.find((f) => f.loserId === "d_lose")?.reason).toBe(
      byLoser.get("d_lose")!.reason,
    );
  });

  it("merges only inside one assertion context, never across property slugs", async () => {
    const scoped = (id: string, slug: string, value: string, createdAt: string): DedupFact => ({
      id,
      subject: "whtnxt-api",
      predicate: "framework",
      value,
      createdAt,
      propertySlug: slug,
    });

    const report = await runDedupPass({
      facts,
      sampleFacts: () =>
        Promise.resolve([
          scoped("p_other", "app-one", "Fastify web framework", "2026-05-12T00:00:00Z"),
          scoped("p_new", "app-two", "Fastify web framework.", "2026-05-11T00:00:00Z"),
          scoped("p_old", "app-two", "Fastify web framework", "2026-05-10T00:00:00Z"),
        ]),
    });

    // The cross-context lookalike stays out of every proposal; only the
    // same-context pair merges.
    expect(report.proposals).toBe(1);
    expect(report.findings[0]).toMatchObject({
      propertySlug: "app-two",
      winnerId: "p_new",
      loserId: "p_old",
      superseded: false,
    });
  });

  it("registerDedupPass registers a live pass: disabled it runs nothing, edits apply with no re-registration", async () => {
    const settingsBefore = getDreamSettings();
    try {
      reseedDreamSettings({});
      resetLastRuns();
      const passes: DedupPassSpec[] = [];
      const host = { registerDreamPass: (p: DedupPassSpec) => passes.push(p) };
      registerDedupPass({
        host,
        sqliteDb: sessions.rawDb(),
        factStore: facts,
      });
      expect(passes).toHaveLength(1);
      expect(passes[0]!.name).toBe("dream-dedup");

      // Disabled: the run returns early — no proposals applied, no registry entry.
      await passes[0]!.run();
      expect(lastRuns()).toEqual({ contradiction: null, dedup: null, promotion: null });
      expect(factState(dbPath, "d_lose")).toEqual({ present: true, supersededBy: null });

      // Enabled after registration (the POST path): the same spec runs live,
      // the cadence getter reschedules, and apply mode supersedes.
      updateDreamSettings({ dedup: { enabled: true, applyMode: "apply", cadenceMs: 54321 } });
      expect(passes[0]!.intervalMs).toBe(54321);
      await passes[0]!.run();
      expect(factState(dbPath, "d_lose")).toEqual({ present: true, supersededBy: "d_win" });
      expect(lastRuns().dedup).not.toBeNull();
    } finally {
      updateDreamSettings(settingsBefore);
      resetLastRuns();
    }
  });

  it("scheduler wiring: off by default writes nothing; enabled runs dry-run by default, apply on request", async () => {
    const envKeys = [
      "NLM_INTEGRITY_CACHE",
      "NLM_SUPERSEDENCE_LOG",
    ] as const;
    const envBackup: Record<string, string | undefined> = {};
    for (const k of envKeys) envBackup[k] = process.env[k];
    const settingsBefore = getDreamSettings();
    try {
      // Default: no flags, the tick touches no facts.
      process.env["NLM_INTEGRITY_CACHE"] = join(tmp, "integrity-check.json");
      process.env["NLM_SUPERSEDENCE_LOG"] = join(tmp, "sched-supersedence-log.jsonl");
      reseedDreamSettings({});
      const quiet = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: unusedLlm,
        factStore: facts,
        logger: () => {},
      });
      await quiet.tick();
      expect(factState(dbPath, "d_lose")).toEqual({ present: true, supersededBy: null });

      // Enabled for scheduling, apply still off: the pass reports, writes nothing.
      updateDreamSettings({ dedup: { enabled: true } });
      const lines: string[] = [];
      const scheduler = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: unusedLlm,
        factStore: facts,
        logger: (m) => lines.push(m),
      });
      await scheduler.tick();

      const summary = lines.find((l) => l.includes("[dream] dedup pass (dry-run)"));
      expect(summary).toContain("proposals=2");
      expect(summary).toContain("superseded=0");
      expect(factState(dbPath, "d_lose")).toEqual({ present: true, supersededBy: null });
      expect(existsSync(process.env["NLM_SUPERSEDENCE_LOG"]!)).toBe(false);

      // Apply flagged on top of the pass flag: the scheduled run supersedes,
      // with the reason in the audit log.
      updateDreamSettings({ dedup: { applyMode: "apply" } });
      const applyLines: string[] = [];
      const applying = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: unusedLlm,
        factStore: facts,
        logger: (m) => applyLines.push(m),
      });
      await applying.tick();

      expect(applyLines.some((l) => l.includes("[dream] dedup pass (apply)"))).toBe(true);
      expect(factState(dbPath, "d_lose")).toEqual({ present: true, supersededBy: "d_win" });
      const entries = logEntries(process.env["NLM_SUPERSEDENCE_LOG"]!);
      expect(entries.map((e) => e.fact_id).sort()).toEqual(["d_lose", "r_lose"]);
      expect(entries.every((e) => e.source === "dream-dedup-pass")).toBe(true);
      expect(entries.every((e) => (e.reason ?? "").includes("dream-dedup"))).toBe(true);
    } finally {
      for (const k of envKeys) {
        if (envBackup[k] === undefined) delete process.env[k];
        else process.env[k] = envBackup[k]!;
      }
      updateDreamSettings(settingsBefore);
      resetLastRuns();
    }
  });
});
