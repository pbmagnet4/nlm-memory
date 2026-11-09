/**
 * T1609 — contradiction dream pass, integration tests against a fixture DB.
 *
 * Drives runContradictionPass (and the scheduler registration) over real
 * SqliteStorage rows with a stubbed judge lane:
 *  - dry-run (the default) reports and writes nothing;
 *  - apply supersedes contradicted facts — retire + supersedence-log reason
 *    citing the transcript evidence — and leaves everything else alone;
 *  - judge concurrency stays capped (the dream lane is served at 4-way
 *    concurrency by oMLX);
 *  - unverifiable / no-transcript / judge-error facts are flagged, never
 *    touched.
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
  DEFAULT_MAX_IN_FLIGHT,
  registerContradictionPass,
  runContradictionPass,
  sampleActiveFactsSqlite,
  type DreamPassSpec,
} from "../../src/core/dream/contradiction-pass.js";
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

const SESSION_ID = "cc_dream_src";
const SESSION_BODY = [
  "USER: which framework does the api use?",
  "ASSISTANT: we run Fastify in production today.",
  "ASSISTANT: update — we migrated off Fastify to Hono in June, Fastify is gone.",
].join("\n");

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id: SESSION_ID,
    runtime: "claude-code",
    runtimeSessionId: "dream-1",
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "Framework discussion",
    summary: "Framework history",
    body: SESSION_BODY,
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
    ...overrides,
  };
}

interface JudgeCall {
  readonly user: string;
  readonly concurrentAtCall: number;
}

/** Stubbed chat lane: handler maps the user turn to a raw reply; records
 *  each call plus the peak concurrency observed from inside the stub. */
function stubJudge(
  handler: (user: string) => string,
  delayMs = 0,
): { llm: LLMClient; calls: JudgeCall[]; peak: () => number } {
  const calls: JudgeCall[] = [];
  let inFlight = 0;
  let peakSeen = 0;
  const llm = {
    complete: async (_system: string, user: string) => {
      inFlight += 1;
      peakSeen = Math.max(peakSeen, inFlight);
      calls.push({ user, concurrentAtCall: inFlight });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        return handler(user);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { llm: llm as unknown as LLMClient, calls, peak: () => peakSeen };
}

const verdict = (v: string, evidence = "") => JSON.stringify({ verdict: v, evidence });

function retiredAt(dbPath: string, factId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare<[string], { retired_at: string | null }>("SELECT retired_at FROM facts WHERE id = ?")
      .get(factId);
    if (!row) throw new Error(`fact ${factId} missing`);
    return row.retired_at;
  } finally {
    db.close();
  }
}

function factText(overrides: Partial<Fact>): Fact {
  return makeFact({
    id: `fact_${Math.random().toString(36).slice(2, 10)}`,
    kind: "attribute",
    subject: "whtnxt-api",
    predicate: "framework",
    value: "Fastify",
    sourceSessionId: SESSION_ID,
    sourceQuote: "we run Fastify in production today.",
    ...overrides,
  });
}

function defaultOptions(tmp: string, llm: LLMClient, storage: { facts: SqliteFactStore; sessions: SqliteSessionStore }) {
  return {
    facts: storage.facts,
    transcripts: storage.sessions,
    llm,
    sampleFacts: (limit: number) =>
      Promise.resolve(sampleActiveFactsSqlite(storage.sessions.rawDb(), DEFAULT_TEAM_ID, limit)),
    supersedenceLogPath: join(tmp, "supersedence-log.jsonl"),
    model: "dream-test-model",
    logger: () => {},
  };
}

describe("dream contradiction pass", () => {
  let tmp: string;
  let dbPath: string;
  let storage: SqliteStorage;
  let sessions: SqliteSessionStore;
  let facts: SqliteFactStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-dream-pass-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    sessions = storage.sessions;
    facts = storage.facts;
    await sessions.insertSession(DEFAULT_TEAM_ID, makeRecord());
    // A real session whose transcript body is gone (the FK on
    // facts.source_session_id rules up, so "no transcript" = null body).
    await sessions.insertSession(DEFAULT_TEAM_ID, makeRecord({ id: "sess_no_body", body: null }));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run (default) reports contradictions but writes nothing", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [factText({ id: "f_dry" })]);
    const { llm } = stubJudge(() => verdict("contradicted", "we migrated off Fastify to Hono in June"));
    const opts = defaultOptions(tmp, llm, { facts, sessions });

    const report = await runContradictionPass(opts);

    expect(report.apply).toBe(false);
    expect(report).toMatchObject({ sampled: 1, contradicted: 1, superseded: 0, errors: 0 });
    expect(report.findings[0]).toMatchObject({
      factId: "f_dry",
      outcome: "contradicted",
      superseded: false,
      evidenceQuote: "we migrated off Fastify to Hono in June",
    });
    // Nothing written: fact still active, no supersedence audit entry.
    expect(retiredAt(dbPath, "f_dry")).toBeNull();
    expect(existsSync(opts.supersedenceLogPath)).toBe(false);
  });

  it("apply supersedes contradicted facts with a reason citing the transcript evidence", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [
      factText({ id: "f_bad" }),
      factText({ id: "f_good", predicate: "language", value: "TypeScript", sourceQuote: null }),
    ]);
    const { llm } = stubJudge((user) =>
      user.includes("framework: Fastify")
        ? verdict("contradicted", "we migrated off Fastify to Hono in June, Fastify is gone.")
        : verdict("still-true", "we run TypeScript throughout"),
    );

    const logPath = join(tmp, "supersedence-log.jsonl");
    const report = await runContradictionPass({
      ...defaultOptions(tmp, llm, { facts, sessions }),
      apply: true,
    });

    expect(report).toMatchObject({ apply: true, sampled: 2, contradicted: 1, superseded: 1, stillTrue: 1, errors: 0 });

    // The contradicted fact is marked (never deleted); the clean one is untouched.
    expect(retiredAt(dbPath, "f_bad")).not.toBeNull(); // row still present — never deleted
    expect(retiredAt(dbPath, "f_good")).toBeNull();
    // Audit trail: reason cites the transcript evidence, per supersedence.md.
    const entries = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "fact", fact_id: "f_bad", source: "dream-contradiction-pass" });
    expect(entries[0]!.reason).toContain("we migrated off Fastify to Hono in June, Fastify is gone.");
    expect(entries[0]!.reason).toContain("dream-contradiction");
    expect(report.findings.find((f) => f.factId === "f_bad")?.reason).toBe(entries[0]!.reason);
  });

  it("flags unverifiable, no-transcript and judge-error facts without touching them", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [
      factText({ id: "f_unverif", subject: "unrelated-app" }),
      factText({ id: "f_no_transcript", sourceSessionId: "sess_no_body", sourceQuote: null }),
      factText({ id: "f_bad_reply", subject: "gibberish-app" }),
    ]);
    const { llm, calls } = stubJudge((user) =>
      user.includes("unrelated-app") ? verdict("unverifiable") : "not a json object at all",
    );
    const opts = defaultOptions(tmp, llm, { facts, sessions });

    const report = await runContradictionPass(opts);

    expect(report).toMatchObject({
      sampled: 3, contradicted: 0, superseded: 0,
      unverifiable: 1, noTranscript: 1, errors: 1,
    });
    // The no-transcript fact never reaches the judge.
    expect(calls).toHaveLength(2);
    for (const id of ["f_unverif", "f_no_transcript", "f_bad_reply"]) {
      expect(retiredAt(dbPath, id)).toBeNull();
    }
    expect(existsSync(opts.supersedenceLogPath)).toBe(false);
  });

  it("downgrades contradicted verdicts with empty or off-excerpt evidence, never retiring", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [
      factText({ id: "f_empty_evidence" }),
      factText({ id: "f_hallucinated", subject: "other-app" }),
    ]);
    const { llm, calls } = stubJudge((user) =>
      user.includes("other-app")
        ? verdict("contradicted", "the model invented this sentence")
        : verdict("contradicted", ""),
    );

    const report = await runContradictionPass({
      ...defaultOptions(tmp, llm, { facts, sessions }),
      apply: true,
    });

    expect(report).toMatchObject({ sampled: 2, contradicted: 0, superseded: 0, unverifiable: 2, errors: 2 });
    expect(calls).toHaveLength(2);
    for (const id of ["f_empty_evidence", "f_hallucinated"]) {
      expect(retiredAt(dbPath, id)).toBeNull();
      const finding = report.findings.find((f) => f.factId === id);
      expect(finding).toMatchObject({ outcome: "unverifiable", verdict: "unverifiable", superseded: false });
      expect(finding!.error).toContain("downgraded to unverifiable");
    }
    expect(report.findings.find((f) => f.factId === "f_empty_evidence")!.error).toContain("no evidence quote");
    expect(report.findings.find((f) => f.factId === "f_hallucinated")!.error).toContain("not found in the judged excerpt");
  });

  it("records a thrown transcript-store fetch as a judge-error, not no-transcript", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [factText({ id: "f_store_down" })]);
    const { llm, calls } = stubJudge(() => verdict("contradicted", "we migrated off Fastify to Hono in June"));
    const throwingTranscripts = {
      getById: async () => { throw new Error("store down"); },
    };

    const report = await runContradictionPass({
      ...defaultOptions(tmp, llm, { facts, sessions }),
      transcripts: throwingTranscripts,
    });

    expect(report).toMatchObject({ sampled: 1, noTranscript: 0, errors: 1 });
    expect(calls).toHaveLength(0); // the judge is never reached
    expect(report.findings[0]).toMatchObject({
      factId: "f_store_down",
      outcome: "judge-error",
      verdict: null,
      superseded: false,
    });
    expect(report.findings[0]!.error).toContain("transcript store fetch failed");
    expect(retiredAt(dbPath, "f_store_down")).toBeNull();
  });

  it("reports a failed audit write after retire as an error, not superseded", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [factText({ id: "f_audit_fail" })]);
    const { llm } = stubJudge(() => verdict("contradicted", "we migrated off Fastify to Hono in June"));

    const report = await runContradictionPass({
      ...defaultOptions(tmp, llm, { facts, sessions }),
      apply: true,
      supersedenceLogPath: tmp, // a directory: the audit append cannot succeed
    });

    expect(report).toMatchObject({ sampled: 1, contradicted: 1, superseded: 0, errors: 1 });
    expect(report.findings[0]).toMatchObject({ factId: "f_audit_fail", superseded: false });
    expect(report.findings[0]!.error).toContain("audit write failed");
    // The retire itself happened — the error text says so explicitly.
    expect(retiredAt(dbPath, "f_audit_fail")).not.toBeNull();
  });

  it("a throwing dream pass retries on the next tick instead of consuming its slot", async () => {
    const { llm } = stubJudge(() => verdict("still-true", "supports"));
    const lines: string[] = [];
    const scheduler = new ScanScheduler({
      store: sessions,
      adapters: [],
      classifier: llm,
      factStore: facts,
      logger: (m) => lines.push(m),
    });
    let runs = 0;
    scheduler.registerDreamPass({
      name: "flaky-pass",
      intervalMs: 60 * 60 * 1000,
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error("gateway down");
      },
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runs).toBe(2);
    expect(lines.some((l) => l.includes("[scheduler] dream pass flaky-pass failed"))).toBe(true);
  });

  it("caps in-flight judge calls at maxInFlight (oMLX lane serves 4)", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      factText({ id: `f_cap_${i}`, subject: `app-${i}` }),
    );
    await facts.insertMany(DEFAULT_TEAM_ID, many);
    const { llm, calls, peak } = stubJudge(() => verdict("still-true", "supports"), 10);

    const report = await runContradictionPass({
      ...defaultOptions(tmp, llm, { facts, sessions }),
      sampleSize: 12,
      maxInFlight: 3,
    });

    expect(report.sampled).toBe(12);
    expect(calls).toHaveLength(12);
    expect(peak()).toBeLessThanOrEqual(3);
    expect(report.peakInFlight).toBeLessThanOrEqual(3);
    expect(report.peakInFlight).toBeGreaterThan(1); // actually ran concurrently
    expect(DEFAULT_MAX_IN_FLIGHT).toBe(4); // the wired default matches oMLX concurrency
  });

  it("scheduler wiring: enabled via the settings module, the tick runs the pass; disabled it writes nothing", async () => {
    await facts.insertMany(DEFAULT_TEAM_ID, [factText({ id: "f_sched" })]);
    const envKeys = [
      "NLM_INTEGRITY_CACHE",
      "NLM_SUPERSEDENCE_LOG",
    ] as const;
    const envBackup: Record<string, string | undefined> = {};
    for (const k of envKeys) envBackup[k] = process.env[k];
    process.env["NLM_INTEGRITY_CACHE"] = join(tmp, "integrity-check.json");
    const logPath = join(tmp, "supersedence-log.jsonl");
    process.env["NLM_SUPERSEDENCE_LOG"] = logPath;
    const settingsBefore = getDreamSettings();
    reseedDreamSettings({ NLM_DREAM_CONTRADICTION_PASS: "1", NLM_DREAM_CONTRADICTION_APPLY: "1" });
    try {
      const { llm } = stubJudge(() => verdict("contradicted", "we migrated off Fastify to Hono in June"));
      const lines: string[] = [];
      const scheduler = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: llm,
        factStore: facts,
        logger: (m) => lines.push(m),
      });
      await scheduler.tick();

      expect(reportFromLines(lines)).toMatchObject({ sampled: 1 });
      expect(retiredAt(dbPath, "f_sched")).not.toBeNull();
      expect(existsSync(logPath)).toBe(true);
    } finally {
      for (const k of envKeys) {
        if (envBackup[k] === undefined) delete process.env[k];
        else process.env[k] = envBackup[k]!;
      }
      updateDreamSettings(settingsBefore);
      resetLastRuns();
    }

    // Disabled via the settings module (the POST path): the registered pass
    // runs but returns early and retires nothing.
    await facts.insertMany(DEFAULT_TEAM_ID, [factText({ id: "f_sched2" })]);
    updateDreamSettings({ contradiction: { enabled: false } });
    try {
      const { llm } = stubJudge(() => verdict("contradicted", "evidence"));
      const scheduler = new ScanScheduler({
        store: sessions,
        adapters: [],
        classifier: llm,
        factStore: facts,
        logger: () => {},
      });
      await scheduler.tick();
      expect(retiredAt(dbPath, "f_sched2")).toBeNull();
    } finally {
      updateDreamSettings(settingsBefore);
      resetLastRuns();
    }
  });

  it("registerContradictionPass registers a live pass: disabled it runs nothing, edits apply with no re-registration", async () => {
    const settingsBefore = getDreamSettings();
    try {
      reseedDreamSettings({});
      resetLastRuns();
      const passes: DreamPassSpec[] = [];
      const host = { registerDreamPass: (p: DreamPassSpec) => passes.push(p) };
      const { llm, calls } = stubJudge(() => verdict("contradicted", "we migrated off Fastify to Hono in June"));
      registerContradictionPass({
        host,
        sqliteDb: sessions.rawDb(),
        factStore: facts,
        transcripts: sessions,
        llm,
      });
      expect(passes).toHaveLength(1);
      expect(passes[0]!.name).toBe("dream-contradiction");

      // Disabled: the run returns early — no judge call, no registry entry.
      await passes[0]!.run();
      expect(calls).toHaveLength(0);
      expect(lastRuns()).toEqual({ contradiction: null, dedup: null });

      // Enabled after registration (the POST path): the same spec runs live,
      // the cadence getter reschedules, and apply mode retires.
      await facts.insertMany(DEFAULT_TEAM_ID, [factText({ id: "f_live" })]);
      updateDreamSettings({ contradiction: { enabled: true, applyMode: "apply", cadenceMs: 12345 } });
      expect(passes[0]!.intervalMs).toBe(12345);
      await passes[0]!.run();
      expect(calls).toHaveLength(1);
      expect(retiredAt(dbPath, "f_live")).not.toBeNull();
      expect(lastRuns().contradiction).not.toBeNull();
    } finally {
      updateDreamSettings(settingsBefore);
      resetLastRuns();
    }
  });
});

/** Pulls the "[dream] contradiction pass … sampled=1 …" summary off the tick log. */
function reportFromLines(lines: ReadonlyArray<string>): { sampled: number } | null {
  for (const line of lines) {
    const m = /\[dream\] contradiction pass \(apply\).*sampled=(\d+)/.exec(line);
    if (m) return { sampled: Number(m[1]) };
  }
  throw new Error(`no dream summary in scheduler log: ${JSON.stringify(lines)}`);
}
