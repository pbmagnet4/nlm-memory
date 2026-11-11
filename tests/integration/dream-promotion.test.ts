/**
 * T1611 — promotion dream pass, integration tests against a fixture DB.
 *
 * Drives runPromotionPass (and the scheduler registration) over real
 * SqliteStorage rows with the deterministic scoring core
 * (dream/promotion.ts) — no LLM lane anywhere:
 *  - dry-run (the default) nominates capped candidates and writes nothing;
 *  - apply records nominees in fact_promotions and demotes whatever fell
 *    out — rows kept with demoted_at + demote_reason, never deleted;
 *  - the injection ledger (injectionCostPerUsefulHit over the telemetry
 *    window) is measured on every run for run-over-run before/after;
 *  - the pass is disabled by default but always registered: the enable flag
 *    and the dry-run/apply switch are dream settings (POST /api/dreaming),
 *    read live on every run (T1729).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { lastRuns, reseedDreamSettings, resetLastRuns, updateDreamSettings } from "../../src/core/dream/settings.js";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { IngestRecord, SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import {
  listActiveFactIdsSqlite,
  loadFactCandidatesSqlite,
  loadPromotionTelemetry,
  registerPromotionPass,
  runPromotionPass,
  samplePromotionCandidatesSqlite,
  SqlitePromotionStore,
  type PromotionPassSpec,
} from "../../src/core/dream/promotion-pass.js";
import { renderPromotionLine } from "../../src/core/dream/promotion.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import type { LLMClient } from "../../src/ports/llm-client.js";
import type { Fact } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const S1 = "cc_promo_src_1";
const S2 = "cc_promo_src_2";

function makeRecord(id: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
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

/** One corroborated triple (T_KEEP) asserted by both sessions; one loner;
 *  one second corroborated triple (T_OTHER) for cap tests. */
async function insertCorpus(facts: SqliteFactStore): Promise<void> {
  await facts.insertMany(DEFAULT_TEAM_ID, [
    makeFact({ id: "f_keep_1", subject: "whtnxt-api", predicate: "framework", value: "Fastify web framework", sourceSessionId: S1 }),
    makeFact({ id: "f_keep_2", subject: "whtnxt-api", predicate: "framework", value: "Fastify web framework", sourceSessionId: S2 }),
    makeFact({ id: "f_other_1", subject: "whtnxt-api", predicate: "deploy-target", value: "Edge runtime", sourceSessionId: S1 }),
    makeFact({ id: "f_other_2", subject: "whtnxt-api", predicate: "deploy-target", value: "Edge runtime", sourceSessionId: S2 }),
    makeFact({ id: "f_loner", subject: "whtnxt-api", predicate: "language", value: "TypeScript", sourceSessionId: S1 }),
  ]);
}

interface TelemetryPaths {
  hookLogPath: string;
  citationLogPath: string;
}

/** Hook fire surfacing S1 (attributed to its facts) + a direct fact hit;
 *  one citation of S1. estTokens chosen so the ledger is exact. */
function writeTelemetry(tmp: string): TelemetryPaths {
  const hookLogPath = join(tmp, "hook-log.jsonl");
  const citationLogPath = join(tmp, "citation-log.jsonl");
  writeFileSync(
    hookLogPath,
    [
      JSON.stringify({ ts: "2026-05-20T10:00:00Z", conversationId: "c1", hits: [{ id: S1, score: 0.9 }], estTokens: 1000, mode: "live" }),
      JSON.stringify({ ts: "2026-05-20T11:00:00Z", conversationId: "c2", hits: [{ id: "f_other_1", score: 0.8 }], estTokens: 500, mode: "live" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    citationLogPath,
    JSON.stringify({ ts: "2026-05-20T10:05:00Z", conversation_id: "c1", cited_id: S1 }) + "\n",
  );
  return { hookLogPath, citationLogPath };
}

function promotionRows(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT fact_id, demoted_at, demote_reason, reason FROM fact_promotions ORDER BY fact_id").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

const unusedLlm = { complete: async () => "" } as unknown as LLMClient;

describe("dream promotion pass", () => {
  let tmp: string;
  let dbPath: string;
  let storage: SqliteStorage;
  let sessions: SqliteSessionStore;
  let facts: SqliteFactStore;
  let promotions: SqlitePromotionStore;
  let telemetry: TelemetryPaths;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-promote-pass-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    sessions = storage.sessions;
    facts = storage.facts;
    promotions = new SqlitePromotionStore(sessions.rawDb());
    await sessions.insertSession(DEFAULT_TEAM_ID, makeRecord(S1));
    await sessions.insertSession(DEFAULT_TEAM_ID, makeRecord(S2));
    await insertCorpus(facts);
    telemetry = writeTelemetry(tmp);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function runOpts(extra: Record<string, unknown> = {}) {
    const db = sessions.rawDb();
    return {
      store: promotions,
      sampleCandidates: (limit: number) =>
        Promise.resolve(samplePromotionCandidatesSqlite(db, DEFAULT_TEAM_ID, limit)),
      loadTelemetry: (candidates: Parameters<typeof loadPromotionTelemetry>[0]) =>
        Promise.resolve(loadPromotionTelemetry(candidates, { ...telemetry, windowDays: 30, now: Date.parse("2026-05-21T00:00:00Z") })),
      logger: () => {},
      ...extra,
    };
  }

  it("dry-run (default) nominates under the cap and writes nothing", async () => {
    const report = await runPromotionPass(runOpts({ maxLines: 1 }));

    // f_other_1 (corroborated + retrieved twice + cited) outscores
    // f_keep_1 (corroborated + retrieved + cited once); the 1-line cap
    // admits exactly the top scorer.
    expect(report).toMatchObject({ apply: false, sampled: 5, nominated: 1, promoted: 0, demoted: 0 });
    expect(report.findings.filter((f) => f.action === "promote")).toHaveLength(1);
    expect(report.findings[0]!.written).toBe(false);
    expect(report.findings[0]!.reason).toContain("dream-promotion");
    // The loner (corroboration 1, never retrieved) is ineligible, never nominated.
    expect(report.findings.some((f) => f.factId === "f_loner" && f.action === "promote")).toBe(false);
    // Nothing written anywhere: the promotions table stays empty.
    expect(promotionRows(dbPath)).toEqual([]);
    // Injection ledger measured even in dry-run: 1500 tokens, 1 useful hit.
    expect(report.injection).toMatchObject({ fires: 2, injectedTokens: 1500, usefulHits: 1, tokensPerUsefulHit: 1500 });
  });

  it("apply promotes nominees with reasons and leaves the rest alone", async () => {
    const report = await runPromotionPass(runOpts({ apply: true, maxLines: 10 }));

    // Only the S1-sourced facts earned a signal: S1 was surfaced and cited,
    // the direct hit named f_other_1. Their S2 twins carry no signal, so
    // they stay out; the loner fails the corroboration floor.
    expect(report).toMatchObject({ apply: true, nominated: 2, promoted: 2, demoted: 0 });
    const rows = promotionRows(dbPath);
    expect(rows.map((r) => r.fact_id)).toEqual(["f_keep_1", "f_other_1"]);
    for (const row of rows) {
      expect(row.demoted_at).toBeNull();
      expect(String(row.reason)).toContain("dream-promotion");
    }
  });

  it("minCorroboration from the settings widens the eligibility floor for the run (T1729)", async () => {
    // The S1-sourced loner (corroboration 1) carries a live signal through its
    // source session, so a floor of 1 admits it beside the two corroborated
    // facts the default floor (2) already allows. The S2 twins stay out:
    // corroboration alone is not a signal.
    const report = await runPromotionPass(runOpts({ apply: true, maxLines: 10, minCorroboration: 1 }));
    expect(report).toMatchObject({ apply: true, nominated: 3, promoted: 3 });
    expect(promotionRows(dbPath).map((r) => r.fact_id)).toEqual(["f_keep_1", "f_loner", "f_other_1"]);
  });

  it("demotion keeps the row as a link, never deletes it", async () => {
    // Promote a stale fact, then backdate it past the stale horizon with no signals.
    const stale = (await runOpts().sampleCandidates(10)).find((c) => c.id === "f_other_1")!;
    promotions.promote(DEFAULT_TEAM_ID, {
      ...stale,
      score: 1,
      retrievals: 0,
      citations: 0,
      reason: "seed",
    });
    sessions.rawDb().prepare("UPDATE fact_promotions SET promoted_at = '2026-01-01T00:00:00Z' WHERE fact_id = 'f_other_1'").run();
    // The loner goes inactive: supersede it so the sampler drops it.
    await facts.markSuperseded(DEFAULT_TEAM_ID, "f_loner", "f_keep_1");
    promotions.promote(DEFAULT_TEAM_ID, {
      ...stale, id: "f_loner", subject: "whtnxt-api", predicate: "language", value: "TypeScript",
      score: 1, retrievals: 0, citations: 0, reason: "seed",
    });

    const report = await runPromotionPass(
      runOpts({
        apply: true,
        maxLines: 10,
        loadTelemetry: (candidates: Parameters<typeof loadPromotionTelemetry>[0]) =>
          Promise.resolve(
            loadPromotionTelemetry(candidates, {
              hookLogPath: join(tmp, "missing.jsonl"),
              citationLogPath: join(tmp, "missing.jsonl"),
              windowDays: 30,
              now: Date.parse("2026-05-21T00:00:00Z"),
            }),
          ),
      }),
    );

    expect(report.demoted).toBe(2);
    const rows = promotionRows(dbPath);
    const byId = new Map(rows.map((r) => [r.fact_id, r]));
    // Both rows survive — demoted, with reasons, never deleted.
    expect(byId.get("f_other_1")!.demoted_at).not.toBeNull();
    expect(String(byId.get("f_other_1")!.demote_reason)).toContain("stale");
    expect(byId.get("f_loner")!.demoted_at).not.toBeNull();
    expect(String(byId.get("f_loner")!.demote_reason)).toContain("left the active set");
  });

  it("missing telemetry logs degrade to empty signals, never a failed run", async () => {
    const report = await runPromotionPass(
      runOpts({
        loadTelemetry: (candidates: Parameters<typeof loadPromotionTelemetry>[0]) =>
          Promise.resolve(
            loadPromotionTelemetry(candidates, {
              hookLogPath: join(tmp, "missing.jsonl"),
              citationLogPath: join(tmp, "missing.jsonl"),
            }),
          ),
      }),
    );
    expect(report.nominated).toBe(0);
    expect(report.injection).toMatchObject({ fires: 0, injectedTokens: 0, usefulHits: 0, tokensPerUsefulHit: null });
    expect(promotionRows(dbPath)).toEqual([]);
  });

  it("registerPromotionPass always registers the pass; a disabled run is a no-op", async () => {
    const passes: PromotionPassSpec[] = [];
    const host = { registerDreamPass: (p: PromotionPassSpec) => passes.push(p) };
    registerPromotionPass({ host, sqliteDb: sessions.rawDb(), logger: () => {} });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.name).toBe("dream-promotion");

    // Disabled (the default): the run returns before it samples anything —
    // no rows written, no run recorded.
    reseedDreamSettings({});
    resetLastRuns();
    await passes[0]!.run();
    expect(promotionRows(dbPath)).toEqual([]);
    expect(lastRuns().promotion).toBeNull();

    // The PG backend passes no handle, so nothing registers there either.
    const pgPasses: PromotionPassSpec[] = [];
    registerPromotionPass({ host: { registerDreamPass: (p: PromotionPassSpec) => pgPasses.push(p) }, sqliteDb: null, logger: () => {} });
    expect(pgPasses).toHaveLength(0);
  });

  it("the settings switch takes effect on the next run without a restart (T1729)", async () => {
    const passes: PromotionPassSpec[] = [];
    const host = { registerDreamPass: (p: PromotionPassSpec) => passes.push(p) };
    registerPromotionPass({ host, sqliteDb: sessions.rawDb(), logger: () => {} });
    const run = () => passes[0]!.run();
    const hookLog = process.env["NLM_HOOK_LOG"];
    const citationLog = process.env["NLM_CITATION_LOG"];
    try {
      // Fixture telemetry predates the default 30-day window relative to
      // wall-clock now, so widen it; enabling goes through the settings the
      // run closure reads.
      process.env["NLM_HOOK_LOG"] = telemetry.hookLogPath;
      process.env["NLM_CITATION_LOG"] = telemetry.citationLogPath;
      reseedDreamSettings({ NLM_DREAM_PROMOTE_PASS: "1", NLM_DREAM_PROMOTE_WINDOW_DAYS: "10000" });
      resetLastRuns();

      await run();
      expect(promotionRows(dbPath)).toEqual([]);
      expect(lastRuns().promotion).toMatchObject({ name: "promotion", summary: { mode: "dry-run" } });

      // Flip the switch on the live settings — the already-registered run
      // closure picks it up on its next run.
      updateDreamSettings({ promotion: { mode: "apply" } });
      await run();
      expect(promotionRows(dbPath).length).toBeGreaterThan(0);
      expect(lastRuns().promotion).toMatchObject({ summary: { mode: "apply" } });
    } finally {
      if (hookLog === undefined) delete process.env["NLM_HOOK_LOG"]; else process.env["NLM_HOOK_LOG"] = hookLog;
      if (citationLog === undefined) delete process.env["NLM_CITATION_LOG"]; else process.env["NLM_CITATION_LOG"] = citationLog;
      reseedDreamSettings({});
      resetLastRuns();
    }
  });

  it("scheduler wiring: off by default writes nothing; the live settings drive dry-run and apply", async () => {
    const envKeys = ["NLM_INTEGRITY_CACHE", "NLM_SUPERSEDENCE_LOG"] as const;
    const envBackup: Record<string, string | undefined> = {};
    for (const k of envKeys) envBackup[k] = process.env[k];
    const telemetryKeys = ["NLM_HOOK_LOG", "NLM_CITATION_LOG"] as const;
    const telemetryBackup: Record<string, string | undefined> = {};
    for (const k of telemetryKeys) telemetryBackup[k] = process.env[k];
    try {
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
      expect(promotionRows(dbPath)).toEqual([]);

      // Enabled without apply: dry-run only, still nothing written.
      updateDreamSettings({ promotion: { enabled: true, windowDays: 10000 } });
      process.env["NLM_HOOK_LOG"] = telemetry.hookLogPath;
      process.env["NLM_CITATION_LOG"] = telemetry.citationLogPath;
      const dry = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: unusedLlm,
        factStore: facts,
        logger: () => {},
      });
      await dry.tick();
      expect(promotionRows(dbPath)).toEqual([]);

      // Apply mode writes through the scheduler path.
      updateDreamSettings({ promotion: { mode: "apply" } });
      const applied = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: unusedLlm,
        factStore: facts,
        logger: () => {},
      });
      await applied.tick();
      expect(promotionRows(dbPath).length).toBeGreaterThan(0);
    } finally {
      for (const k of envKeys) {
        if (envBackup[k] === undefined) delete process.env[k];
        else process.env[k] = envBackup[k];
      }
      for (const k of telemetryKeys) {
        if (telemetryBackup[k] === undefined) delete process.env[k];
        else process.env[k] = telemetryBackup[k];
      }
      reseedDreamSettings({});
    }
  });

  describe("landing-review regressions", () => {
    /** Production-shaped options: demotion from the full active set and
     *  real candidates for sample-missing actives (both SQLite-backed). */
    function wiredOpts(extra: Record<string, unknown> = {}) {
      const db = sessions.rawDb();
      return runOpts({
        listActiveFactIds: () => Promise.resolve(listActiveFactIdsSqlite(db, DEFAULT_TEAM_ID)),
        loadFactCandidates: (ids: ReadonlyArray<string>) =>
          Promise.resolve(loadFactCandidatesSqlite(db, DEFAULT_TEAM_ID, ids)),
        ...extra,
      });
    }

    function emptyTelemetry(candidates: Parameters<typeof loadPromotionTelemetry>[0]) {
      return Promise.resolve(
        loadPromotionTelemetry(candidates, {
          hookLogPath: join(tmp, "missing.jsonl"),
          citationLogPath: join(tmp, "missing.jsonl"),
          windowDays: 30,
          now: Date.parse("2026-05-21T00:00:00Z"),
        }),
      );
    }

    it("does not demote promoted facts the sample did not draw", async () => {
      const all = await runOpts().sampleCandidates(10);
      const keep1 = all.find((c) => c.id === "f_keep_1")!;
      const keep2 = all.find((c) => c.id === "f_keep_2")!;
      for (const c of [keep1, keep2]) {
        promotions.promote(DEFAULT_TEAM_ID, { ...c, score: 4, retrievals: 0, citations: 0, reason: "seed" });
      }
      // The sample draws only one of the two promoted facts; the other is
      // still active, so it must be kept — never "left the active set".
      const report = await runPromotionPass(
        wiredOpts({
          apply: true,
          maxLines: 10,
          sampleCandidates: () => Promise.resolve([keep1]),
          loadTelemetry: emptyTelemetry,
        }),
      );
      expect(report.findings.filter((f) => f.action === "demote")).toEqual([]);
      expect(report.findings.some((f) => f.factId === "f_keep_2" && f.action === "keep")).toBe(true);
      const rows = promotionRows(dbPath);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.demoted_at).toBeNull();
    });

    it("lifetime citations shield a promotion from the never-cited grace rule", async () => {
      const all = await runOpts().sampleCandidates(10);
      const keep1 = all.find((c) => c.id === "f_keep_1")!;
      promotions.promote(DEFAULT_TEAM_ID, { ...keep1, score: 4, retrievals: 0, citations: 0, reason: "seed" });
      // Promoted 20 days ago; cited 60 days ago — outside the 30-day window.
      sessions.rawDb().prepare("UPDATE fact_promotions SET promoted_at = '2026-05-01T00:00:00Z' WHERE fact_id = 'f_keep_1'").run();
      const oldCite = join(tmp, "old-citation-log.jsonl");
      writeFileSync(oldCite, JSON.stringify({ ts: "2026-03-22T00:00:00Z", conversation_id: "c0", cited_id: "f_keep_1" }) + "\n");
      const report = await runPromotionPass(
        wiredOpts({
          now: Date.parse("2026-05-21T00:00:00Z"),
          loadTelemetry: (candidates: Parameters<typeof loadPromotionTelemetry>[0]) =>
            Promise.resolve(
              loadPromotionTelemetry(candidates, {
                hookLogPath: join(tmp, "missing.jsonl"),
                citationLogPath: oldCite,
                windowDays: 30,
                now: Date.parse("2026-05-21T00:00:00Z"),
              }),
            ),
        }),
      );
      expect(report.findings.filter((f) => f.factId === "f_keep_1" && f.action === "demote")).toEqual([]);
    });

    it("writes promoted_at/demoted_at as ISO UTC so aging agrees on any host TZ", async () => {
      const all = await runOpts().sampleCandidates(10);
      const one = all[0]!;
      promotions.promote(DEFAULT_TEAM_ID, { ...one, score: 4, retrievals: 0, citations: 0, reason: "seed" });
      const db = sessions.rawDb();
      const stamped = db.prepare("SELECT promoted_at FROM fact_promotions WHERE fact_id = ?").get(one.id) as { promoted_at: string };
      expect(stamped.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      promotions.demote(DEFAULT_TEAM_ID, one.id, "test reason");
      const destamped = db.prepare("SELECT demoted_at FROM fact_promotions WHERE fact_id = ?").get(one.id) as { demoted_at: string };
      expect(destamped.demoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("measures the cap on real rendered lines for sample-missing actives", async () => {
      const bigValue = "x".repeat(2000);
      await facts.insertMany(DEFAULT_TEAM_ID, [
        makeFact({ id: "f_big_1", subject: "whtnxt-api", predicate: "notes", value: bigValue, sourceSessionId: S1 }),
        makeFact({ id: "f_big_2", subject: "whtnxt-api", predicate: "notes", value: bigValue, sourceSessionId: S2 }),
      ]);
      const loaded = loadFactCandidatesSqlite(sessions.rawDb(), DEFAULT_TEAM_ID, ["f_big_1"]);
      expect(loaded).toHaveLength(1);
      promotions.promote(DEFAULT_TEAM_ID, { ...loaded[0]!, score: 1, retrievals: 0, citations: 0, reason: "seed" });
      // Empty sample: the only active promotion is sample-missing, so the
      // cap must still account its full rendered line.
      const report = await runPromotionPass(
        wiredOpts({
          maxBytes: 100_000,
          sampleCandidates: () => Promise.resolve([]),
          loadTelemetry: emptyTelemetry,
        }),
      );
      const expected = Buffer.byteLength(renderPromotionLine(loaded[0]!), "utf8");
      expect(expected).toBeGreaterThan(2000);
      expect(report.usedBytes).toBe(expected);
    });
  });
});
