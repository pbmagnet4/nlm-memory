/** Scheduler: re-touch dedupe and transient-failure backoff. */
import { mkdtempSync, writeFileSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { LLMUnreachableError, ClassifierSchemaError } from "../../../../src/ports/llm-client.js";
import type { LLMClient } from "../../../../src/ports/llm-client.js";
import type { SessionChunk, TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");
const OK = { label: "l", summary: "s", entities: [], decisions: [], open: [], confidence: 0.9, facts: [] };

async function setup(failures: Array<() => Error> = []) {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-load-"));
  const storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  const path = join(tmp, "rollout.jsonl");
  writeFileSync(path, "line1\n");
  const age = () => { const old = (Date.now() - 3_600_000) / 1000; utimesSync(path, old, old); };
  age();
  let text = "[user] hello\n[assistant] hi";
  const adapter: TranscriptAdapter = {
    name: "codex", runtimeVersion: "codex/1", transcriptKind: "codex-jsonl",
    detect: () => ({ adapterName: "codex", enabled: true, path: null, hint: null }),
    discover: async () => [path],
    parseSession: async (): Promise<SessionChunk> => ({
      id: "codex_1", runtime: "codex/1", runtimeSessionId: "codex_1", sourcePath: path,
      startedAt: "2026-10-13T10:00:00Z", endedAt: "2026-10-13T10:01:00Z", durationMin: 1, turnCount: 2,
      byteRange: [0, 10], projectDir: "/repo/x", gitBranch: "", text, label: "hello",
    }),
  };
  const calls = { classify: 0 };
  const pending = [...failures];
  const classifier: LLMClient = {
    embed: async () => { throw new Error("no embed"); },
    classify: async () => {
      calls.classify += 1;
      const f = pending.shift();
      if (f) throw f();
      return OK;
    },
    rewriteForRecall: async () => { throw new Error("no"); },
    nameWorkstream: async () => null,
  };
  const logs: string[] = [];
  const scheduler = new ScanScheduler({
    store: storage.sessions, adapters: [adapter], classifier, embedder: null,
    idleMinutes: 0, logger: (m: string) => logs.push(m),
  });
  return {
    storage, scheduler, calls, logs, path, age,
    touch: () => { const t = Date.now() / 1000 - 1800; utimesSync(path, t, t); },
    appendNoise: () => { appendFileSync(path, "{\"type\":\"token_count\"}\n"); age(); },
    appendContent: () => { appendFileSync(path, "line2\n"); age(); text += "\n[user] more"; },
    state: () => storage.sessions.rawDb().prepare("SELECT failure_count FROM adapter_state").get() as { failure_count: number } | undefined,
  };
}

describe("re-touch dedupe", () => {
  it("mtime-only touch is skipped", async () => {
    const s = await setup();
    await s.scheduler.tick();
    s.touch();
    await s.scheduler.tick();
    expect(s.calls.classify).toBe(1);
    await s.storage.close();
  });
  it("file grew but normalized content is identical: skipped, and later growth with new content reclassifies", async () => {
    const s = await setup();
    await s.scheduler.tick();
    s.appendNoise();
    await s.scheduler.tick();
    expect(s.calls.classify).toBe(1);
    s.appendContent();
    await s.scheduler.tick();
    expect(s.calls.classify).toBe(2);
    await s.storage.close();
  });
});

describe("transient failure backoff", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  const http500 = () => new LLMUnreachableError("openai", "status 500");

  it("defers without consuming strikes, backs off 30s then 60s, then classifies after recovery", async () => {
    const s = await setup([http500, http500]);
    await s.scheduler.tick();
    expect(s.calls.classify).toBe(1);
    expect(s.state()).toBeUndefined();
    expect(s.logs.join("\n")).toMatch(/deferred/);
    s.age();
    await s.scheduler.tick(); // inside 30s window
    expect(s.calls.classify).toBe(1);
    vi.setSystemTime(Date.now() + 31_000);
    s.age();
    await s.scheduler.tick(); // second failure, window now 60s
    expect(s.calls.classify).toBe(2);
    vi.setSystemTime(Date.now() + 45_000);
    await s.scheduler.tick();
    expect(s.calls.classify).toBe(2);
    vi.setSystemTime(Date.now() + 20_000);
    const report = await s.scheduler.tick();
    expect(s.calls.classify).toBe(3);
    expect(report.inserted).toBe(1);
    expect(s.state()?.failure_count).toBe(0);
    await s.storage.close();
  });

  it("backoff caps at 10 minutes", async () => {
    const s = await setup(Array.from({ length: 8 }, () => http500));
    for (let i = 0; i < 8; i++) {
      await s.scheduler.tick();
      vi.setSystemTime(Date.now() + 601_000);
    }
    expect(s.calls.classify).toBe(8);
    await s.storage.close();
  });

  it("quality failures still count toward the strike budget", async () => {
    const bad = () => new ClassifierSchemaError("returned non-JSON content");
    const s = await setup([bad]);
    await s.scheduler.tick();
    expect(s.state()?.failure_count).toBe(1);
    await s.storage.close();
  });
});
