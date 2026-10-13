/**
 * Scheduler + Clef ingest gate: a gated session is stored without a classifier
 * call or workstream binding; every other path still classifies.
 */

import { mkdtempSync, readFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateVerdict, IngestGateMode } from "../../../../src/core/classifier/ingest-gate.js";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import type { LLMClient } from "../../../../src/ports/llm-client.js";
import type { SessionChunk, TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-gate-"));
  const storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  const path = join(tmp, "session.jsonl");
  writeFileSync(path, '{"type":"user","message":{"content":"hi"}}\n');
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(path, old, old);
  const chunk: SessionChunk = {
    id: "pi_gate", runtime: "pi/1.0", runtimeSessionId: "pi_gate", sourcePath: path,
    startedAt: "2026-10-13T10:00:00Z", endedAt: "2026-10-13T10:01:00Z", durationMin: 1, turnCount: 2,
    byteRange: [0, 40], projectDir: "/repo/x", gitBranch: "", text: "[user] what time is it\n[assistant] noon", label: "what time is it",
  };
  const adapter: TranscriptAdapter = {
    name: "pi", runtimeVersion: "pi/1.0", transcriptKind: "pi-jsonl",
    detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
    discover: async () => [path],
    parseSession: async () => chunk,
  };
  const calls = { classify: 0, name: 0 };
  const classifier: LLMClient = {
    embed: async () => { throw new Error("no embed"); },
    classify: async () => {
      calls.classify += 1;
      return { label: "classified label", summary: "classified summary", entities: ["x"], decisions: ["d"], open: [], confidence: 0.9, facts: [] };
    },
    rewriteForRecall: async () => { throw new Error("no"); },
    nameWorkstream: async () => { calls.name += 1; return null; },
  };
  return { tmp, storage, adapter, classifier, calls };
}

function gate(mode: IngestGateMode, verdict: GateVerdict, shadowLogPath: string) {
  let judged = 0;
  return {
    judged: () => judged,
    opt: { mode, threshold: 1.5, shadowLogPath, judge: async () => { judged += 1; return verdict; } },
  };
}

const SKIP: GateVerdict = { score: 0.5, kind: "trivial", skip: true, ms: 3 };
const KEEP: GateVerdict = { score: 2.4, kind: "coding", skip: false, ms: 3 };
const ERROR: GateVerdict = { score: null, kind: null, skip: false, ms: 3, error: "clef HTTP 502" };

describe("ScanScheduler ingest gate", () => {
  beforeEach(() => { process.env["NLM_WORKSTREAM_BIND"] = "true"; });
  afterEach(() => { delete process.env["NLM_WORKSTREAM_BIND"]; });

  it("live + skip: stores the session without classifying or binding", async () => {
    const s = await setup();
    const g = gate("live", SKIP, join(s.tmp, "shadow.jsonl"));
    const scheduler = new ScanScheduler({
      store: s.storage.sessions, adapters: [s.adapter], classifier: s.classifier, embedder: null,
      workstreams: s.storage.workstreams, idleMinutes: 0, logger: () => {}, ingestGate: g.opt,
      classifierDescriptor: { provider: "openai", model: "litellm-classifier" },
    });
    const report = await scheduler.tick();
    expect(report).toMatchObject({ inserted: 1, gatedSkips: 1, skippedLowConfidence: 0 });
    expect(s.calls).toEqual({ classify: 0, name: 0 });
    const row = s.storage.sessions.rawDb()
      .prepare("SELECT label, summary, body, classifier_provider, classifier_model, classifier_confidence FROM sessions WHERE id = ?")
      .get("pi_gate") as Record<string, unknown>;
    expect(row).toMatchObject({ label: "what time is it", summary: "", classifier_provider: "clef-gate", classifier_model: "clef-oQ4e" });
    expect(row["classifier_confidence"]).toBeCloseTo(0.5 / 3);
    expect(String(row["body"])).toContain("what time is it");
    expect(existsSync(join(s.tmp, "shadow.jsonl"))).toBe(false);
    await s.storage.close();
  });

  it("live + keep: classifies and binds as usual", async () => {
    const s = await setup();
    const g = gate("live", KEEP, join(s.tmp, "shadow.jsonl"));
    const report = await new ScanScheduler({
      store: s.storage.sessions, adapters: [s.adapter], classifier: s.classifier, embedder: null,
      workstreams: s.storage.workstreams, idleMinutes: 0, logger: () => {}, ingestGate: g.opt,
    }).tick();
    expect(report).toMatchObject({ inserted: 1, gatedSkips: 0 });
    expect(s.calls).toEqual({ classify: 1, name: 1 });
    await s.storage.close();
  });

  it("live + Clef error: fails open to the classifier", async () => {
    const s = await setup();
    const g = gate("live", ERROR, join(s.tmp, "shadow.jsonl"));
    const report = await new ScanScheduler({
      store: s.storage.sessions, adapters: [s.adapter], classifier: s.classifier, embedder: null,
      idleMinutes: 0, logger: () => {}, ingestGate: g.opt,
    }).tick();
    expect(report).toMatchObject({ inserted: 1, gatedSkips: 0 });
    expect(s.calls.classify).toBe(1);
    await s.storage.close();
  });

  it("shadow: logs what it would skip and still classifies", async () => {
    const s = await setup();
    const log = join(s.tmp, "shadow.jsonl");
    const g = gate("shadow", SKIP, log);
    const report = await new ScanScheduler({
      store: s.storage.sessions, adapters: [s.adapter], classifier: s.classifier, embedder: null,
      idleMinutes: 0, logger: () => {}, ingestGate: g.opt,
    }).tick();
    expect(report).toMatchObject({ inserted: 1, gatedSkips: 0 });
    expect(s.calls.classify).toBe(1);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "pi_gate", runtime: "pi/1.0", score: 0.5, wouldSkip: true, threshold: 1.5 });
    await s.storage.close();
  });

  it("no gate: judge never consulted", async () => {
    const s = await setup();
    const report = await new ScanScheduler({
      store: s.storage.sessions, adapters: [s.adapter], classifier: s.classifier, embedder: null,
      idleMinutes: 0, logger: () => {},
    }).tick();
    expect(report).toMatchObject({ inserted: 1, gatedSkips: 0 });
    expect(s.calls.classify).toBe(1);
    await s.storage.close();
  });
});
