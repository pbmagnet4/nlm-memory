/**
 * Unit test: the scheduler tick enforces the exemplar volume cap by calling
 * exemplarStore.applyBucketCap(installScope, maxPerBucket) once per tick,
 * gated by the same NLM_CODE_EXEMPLARS_ENABLED flag that gates capture.
 *
 * Uses a fixture exemplar store (records the cap call) and a real on-disk
 * SQLite session store in a temp dir. Never touches the operator's store.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import type { CodeExemplarStore } from "../../../../src/ports/code-exemplar-store.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../../../src/ports/llm-client.js";
import type { TranscriptAdapter, SessionChunk } from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

class StubClassifier implements LLMClient {
  async embed(): Promise<EmbedResult> { throw new Error("nu"); }
  async rewriteForRecall(): Promise<never> { throw new Error("nu"); }
  async classify(): Promise<ClassifyResult> {
    return { label: "L", summary: "s", entities: [], decisions: [], open: [], confidence: 0.9, facts: [] };
  }
}

interface CapCall { readonly installScope: string; readonly maxPerBucket: number; }

function fixtureExemplarStore(capCalls: CapCall[]): CodeExemplarStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap(installScope, maxPerBucket) {
      capCalls.push({ installScope, maxPerBucket });
      return 0;
    },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict() { return { status: "not_found" as const }; },
    async listBySessions() { return []; },
  };
}

function writeTempJsonl(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '{"type":"user","message":{"content":"hi"}}\n');
  const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(path, oldT, oldT);
  return path;
}

function chunk(sourcePath: string): SessionChunk {
  return {
    id: "pi_cap_1",
    runtime: "pi/1.0",
    runtimeSessionId: "pi_cap_1",
    sourcePath,
    startedAt: "2026-06-09T18:00:00Z",
    endedAt: "2026-06-09T18:05:00Z",
    durationMin: 5,
    turnCount: 2,
    byteRange: [0, 100],
    projectDir: "/repo/x",
    gitBranch: "",
    text: "[user] hi",
    label: "hi",
    signals: [],
  };
}

function adapterFor(transcriptPath: string): TranscriptAdapter {
  return {
    name: "pi",
    runtimeVersion: "pi/1.0",
    transcriptKind: "pi-jsonl",
    detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
    discover: async () => [transcriptPath],
    parseSession: async () => chunk(transcriptPath),
  };
}

async function memStore(): Promise<SqliteStorage> {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-sched-cap-"));
  const storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  return storage;
}

describe("ScanScheduler exemplar bucket cap", () => {
  const prevFlag = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  const prevCap = process.env["NLM_EXEMPLAR_MAX_PER_BUCKET"];
  const dirs: string[] = [];

  beforeEach(() => {
    delete process.env["NLM_EXEMPLAR_MAX_PER_BUCKET"];
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prevFlag;
    if (prevCap === undefined) delete process.env["NLM_EXEMPLAR_MAX_PER_BUCKET"];
    else process.env["NLM_EXEMPLAR_MAX_PER_BUCKET"] = prevCap;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function runTick(): Promise<{ capCalls: CapCall[]; storage: SqliteStorage }> {
    const storage = await memStore();
    const fileDir = mkdtempSync(join(tmpdir(), "nlm-cap-files-"));
    dirs.push(fileDir);
    const transcriptPath = writeTempJsonl(fileDir, "session.jsonl");
    const capCalls: CapCall[] = [];
    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapterFor(transcriptPath)],
      classifier: new StubClassifier(),
      embedder: null,
      installScope: "install-test",
      exemplarStore: fixtureExemplarStore(capCalls),
      codeEmbedder: null,
      idleMinutes: 0,
      logger: () => {},
    });
    await scheduler.tick();
    return { capCalls, storage };
  }

  it("calls applyBucketCap once per tick with the install scope and default cap when the flag is on", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const { capCalls, storage } = await runTick();
    expect(capCalls).toHaveLength(1);
    expect(capCalls[0]!.installScope).toBe("install-test");
    expect(capCalls[0]!.maxPerBucket).toBe(50);
    await storage.close();
  });

  it("honors NLM_EXEMPLAR_MAX_PER_BUCKET override", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    process.env["NLM_EXEMPLAR_MAX_PER_BUCKET"] = "12";
    const { capCalls, storage } = await runTick();
    expect(capCalls).toHaveLength(1);
    expect(capCalls[0]!.maxPerBucket).toBe(12);
    await storage.close();
  });

  it("does not call applyBucketCap when the exemplar flag is off", async () => {
    delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    const { capCalls, storage } = await runTick();
    expect(capCalls).toHaveLength(0);
    await storage.close();
  });
});
