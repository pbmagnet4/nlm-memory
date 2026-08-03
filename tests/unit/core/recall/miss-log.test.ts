import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMiss, appendMisses, missStats } from "../../../../src/core/recall/miss-log.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

describe("miss-log: appendMiss / appendMisses", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-miss-"));
    path = join(dir, "miss-log.jsonl");
    delete process.env["NLM_MISS_LOG_ENABLED"];
  });
  afterEach(() => {
    delete process.env["NLM_MISS_LOG_ENABLED"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a single miss event", async () => {
    await appendMiss(
      DEFAULT_TEAM_ID,
      {
        conversationId: "conv1",
        missedId: "cc_abc_123456",
        kind: "get_session",
        surfacedCount: 3,
      },
      path,
    );
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    const obj = JSON.parse(content.trim());
    expect(obj.conversationId).toBe("conv1");
    expect(obj.missedId).toBe("cc_abc_123456");
    expect(obj.kind).toBe("get_session");
    expect(obj.surfacedCount).toBe(3);
    expect(typeof obj.ts).toBe("string");
  });

  it("appends multiple misses sharing one timestamp", async () => {
    await appendMisses(
      DEFAULT_TEAM_ID,
      [
        { conversationId: "c1", missedId: "id_a_111111", kind: "get_session", surfacedCount: 2 },
        { conversationId: "c1", missedId: "id_b_222222", kind: "cite_session", surfacedCount: 2 },
      ],
      path,
    );
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const t1 = JSON.parse(lines[0]!).ts;
    const t2 = JSON.parse(lines[1]!).ts;
    expect(t1).toBe(t2);
  });

  it("does NOT write when NLM_MISS_LOG_ENABLED=0", async () => {
    process.env["NLM_MISS_LOG_ENABLED"] = "0";
    await appendMiss(
      DEFAULT_TEAM_ID,
      { conversationId: "c", missedId: "cc_skip_999999", kind: "get_session", surfacedCount: 1 },
      path,
    );
    expect(existsSync(path)).toBe(false);
  });

  it("survives a permission error without throwing", async () => {
    await expect(
      appendMiss(
        DEFAULT_TEAM_ID,
        { conversationId: "c", missedId: "x", kind: "get_session", surfacedCount: 0 },
        "/dev/null/cant-mkdir-here",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("miss-log: missStats", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-miss-"));
    path = join(dir, "miss-log.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns log-absent when no log exists", async () => {
    const stats = await missStats(DEFAULT_TEAM_ID, 7, path);
    expect(stats.logPresent).toBe(false);
    expect(stats.total).toBe(0);
  });

  it("aggregates miss counts and distinct conversations", async () => {
    await appendMisses(
      DEFAULT_TEAM_ID,
      [
        { conversationId: "c1", missedId: "cc_a_111111", kind: "get_session", surfacedCount: 3 },
        { conversationId: "c2", missedId: "cc_a_111111", kind: "get_session", surfacedCount: 5 },
        { conversationId: "c2", missedId: "cc_a_111111", kind: "cite_session", surfacedCount: 5 },
        { conversationId: "c3", missedId: "cc_b_222222", kind: "get_session", surfacedCount: 2 },
      ],
      path,
    );
    const stats = await missStats(DEFAULT_TEAM_ID, 30, path);
    expect(stats.logPresent).toBe(true);
    expect(stats.total).toBe(4);
    expect(stats.distinctIds).toBe(2);
    const top = stats.topIds.find((r) => r.id === "cc_a_111111");
    expect(top?.count).toBe(3);
    expect(top?.conversations).toBe(2);
  });

  it("filters by lookback window", async () => {
    // Manually write an old-timestamped row + a recent one
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    const { appendFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ts: old, conversationId: "c_old", missedId: "old_111111", kind: "get_session", surfacedCount: 1 })}\n` +
        `${JSON.stringify({ ts: recent, conversationId: "c_new", missedId: "new_222222", kind: "get_session", surfacedCount: 1 })}\n`,
    );
    const stats = await missStats(DEFAULT_TEAM_ID, 7, path);
    expect(stats.total).toBe(1);
    expect(stats.topIds[0]?.id).toBe("new_222222");
  });

  it("ignores malformed JSON lines", async () => {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path,
      "not json\n" +
        `${JSON.stringify({ ts: new Date().toISOString(), conversationId: "c", missedId: "ok_111111", kind: "get_session", surfacedCount: 0 })}\n` +
        "{\"missing_required_fields\":true}\n",
    );
    const stats = await missStats(DEFAULT_TEAM_ID, 7, path);
    expect(stats.total).toBe(1);
    expect(stats.distinctIds).toBe(1);
  });
});

describe("miss-log tenant path contract", () => {
  afterEach(() => {
    delete process.env["NLM_MISS_LOG"];
    delete process.env["NLM_MISS_LOG_ENABLED"];
  });

  it("default team honors NLM_MISS_LOG override (legacy behavior)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-miss-tenant-"));
    const logPath = join(dir, "miss-log.jsonl");
    process.env["NLM_MISS_LOG"] = logPath;
    try {
      await appendMiss(DEFAULT_TEAM_ID, { conversationId: "c", missedId: "cc_x_111111", kind: "get_session", surfacedCount: 1 });
      expect(existsSync(logPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-default tenant writes under ~/.nlm/tenants/<t>/miss-log.jsonl, ignoring NLM_MISS_LOG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-miss-tenant-"));
    const logPath = join(dir, "miss-log.jsonl");
    process.env["NLM_MISS_LOG"] = logPath;
    const derived = join(homedir(), ".nlm", "tenants", "acme-misslog-test", "miss-log.jsonl");
    try {
      await appendMiss("acme-misslog-test", { conversationId: "c", missedId: "cc_x_111111", kind: "get_session", surfacedCount: 1 });
      expect(existsSync(logPath)).toBe(false);
      expect(existsSync(derived)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(derived, { force: true });
    }
  });

  it("two tenants' miss logs don't collide", async () => {
    const derivedA = join(homedir(), ".nlm", "tenants", "tenant-a-misslog", "miss-log.jsonl");
    const derivedB = join(homedir(), ".nlm", "tenants", "tenant-b-misslog", "miss-log.jsonl");
    try {
      await appendMiss("tenant-a-misslog", { conversationId: "c", missedId: "id_a_111111", kind: "get_session", surfacedCount: 1 });
      await appendMiss("tenant-b-misslog", { conversationId: "c", missedId: "id_b_111111", kind: "get_session", surfacedCount: 1 });
      const a = JSON.parse(readFileSync(derivedA, "utf8").trim());
      const b = JSON.parse(readFileSync(derivedB, "utf8").trim());
      expect(a.missedId).toBe("id_a_111111");
      expect(b.missedId).toBe("id_b_111111");
    } finally {
      rmSync(derivedA, { force: true });
      rmSync(derivedB, { force: true });
    }
  });
});
