/**
 * MuseAdapter tests. Mirrors the pi adapter suite — parser-only slice
 * (scheduler ingest is Phase D work).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MuseAdapter } from "../../../../src/core/adapters/muse.js";

const FIXTURES = resolve(__dirname, "../../../fixtures/muse");

describe("MuseAdapter.parseSession — successful session", () => {
  const adapter = new MuseAdapter({ sessionsPath: FIXTURES });

  it("short-successful: 5 turns, muse/1.0 runtime, muse_ id prefix", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.runtime).toBe("muse/1.0");
    expect(chunk.id.startsWith("muse_")).toBe(true);
    expect(chunk.turnCount).toBe(5);
    expect(chunk.label).toBe("Wire up the gateway");
  });

  it("short-successful: project dir and model from metadata record", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk?.projectDir).toBe("/tmp/proj");
    expect(chunk?.model).toBe("muse-test-1");
  });

  it("short-successful: microsecond timestamps become ISO strings", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk?.startedAt).toMatch(/^2026-09-27T/);
    expect(chunk?.endedAt).toMatch(/^2026-09-27T/);
  });

  it("short-successful: tool calls and results become marker turns", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk?.text).toContain("[tool_use: bash]");
    expect(chunk?.text).toContain("[tool_use: read_file]");
    expect(chunk?.text).toContain("[tool_result: gateway listening on :4000]");
  });
});

describe("MuseAdapter.parseSession — noise exclusion", () => {
  const adapter = new MuseAdapter({ sessionsPath: FIXTURES });

  it("drops reasoning, skill-body bundles, and non-main surfaces", async () => {
    const chunk = await adapter.parseSession(`${FIXTURES}/short-successful.jsonl`);
    expect(chunk?.text).not.toContain("internal deliberation");
    expect(chunk?.text).not.toContain("skill-body");
    expect(chunk?.text).not.toContain("internal nudge");
  });

  it("empty transcript returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-adapter-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, '{"record_type":"event","payload_type":"noop","payload":{}}\n');
      expect(await adapter.parseSession(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MuseAdapter.discover", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-discover-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds session.jsonl under date sharding, ignores other files", async () => {
    const shard = join(dir, "2026", "09", "27", "abc123");
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, "session.jsonl"), "{}\n");
    writeFileSync(join(shard, "notes.txt"), "hi\n");
    const adapter = new MuseAdapter({ sessionsPath: dir });
    const found = await adapter.discover();
    expect(found).toEqual([join(shard, "session.jsonl")]);
  });

  it("missing root discovers nothing", async () => {
    const adapter = new MuseAdapter({ sessionsPath: join(dir, "nope") });
    expect(await adapter.discover()).toEqual([]);
  });
});
