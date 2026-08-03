/**
 * appendSupersedence — telemetry-style writer for the supersedence audit
 * log. Must never throw, but must surface failures via stderr so an
 * operator notices when their audit trail silently goes missing.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFactSupersedence,
  appendSupersedence,
  readSupersedenceLog,
} from "../../../src/core/storage/supersedence-log.js";
import { DEFAULT_TEAM_ID } from "../../../src/core/tenancy/default-team.js";

describe("appendSupersedence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sup-log-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a JSONL line with the expected fields", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendSupersedence(
      DEFAULT_TEAM_ID,
      {
        predecessorId: "sess_a",
        successorId: "sess_b",
        reason: "moved to qdrant",
        source: "cli",
      },
      logPath,
    );
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["predecessor_id"]).toBe("sess_a");
    expect(entry["successor_id"]).toBe("sess_b");
    expect(entry["reason"]).toBe("moved to qdrant");
    expect(entry["source"]).toBe("cli");
    expect(typeof entry["ts"]).toBe("string");
  });

  it("omits reason and source when not provided", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendSupersedence(
      DEFAULT_TEAM_ID,
      { predecessorId: "sess_a", successorId: "sess_b" },
      logPath,
    );
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
    expect("reason" in entry).toBe(false);
    expect("source" in entry).toBe(false);
  });

  it("appends rather than overwrites on multiple calls", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendSupersedence(DEFAULT_TEAM_ID, { predecessorId: "a", successorId: "b" }, logPath);
    await appendSupersedence(DEFAULT_TEAM_ID, { predecessorId: "c", successorId: "d" }, logPath);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("does not throw when the parent dir is unwritable, but warns on stderr (B11)", async () => {
    // Point the log at a path under a file that already exists — mkdir will
    // fail because we can't create a directory inside a regular file. This
    // simulates a disk/permission failure deterministically.
    const block = join(tmp, "blocking-file");
    writeFileSync(block, "this is a file, not a dir");
    const logPath = join(block, "supersedence-log.jsonl");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      appendSupersedence(DEFAULT_TEAM_ID, { predecessorId: "a", successorId: "b" }, logPath),
    ).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]?.[0] ?? "";
    expect(String(written)).toContain("failed to append supersedence-log");
    expect(String(written)).toContain(logPath);
  });
});

describe("appendFactSupersedence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-fact-sup-log-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a JSONL line with kind=fact and the expected fields", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendFactSupersedence(
      DEFAULT_TEAM_ID,
      { factId: "fact_abc123", reason: "wrong framework", source: "mcp" },
      logPath,
    );
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["kind"]).toBe("fact");
    expect(entry["fact_id"]).toBe("fact_abc123");
    expect(entry["reason"]).toBe("wrong framework");
    expect(entry["source"]).toBe("mcp");
    expect(typeof entry["ts"]).toBe("string");
    expect("predecessor_id" in entry).toBe(false);
    expect("successor_id" in entry).toBe(false);
  });

  it("omits reason and source when not provided", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendFactSupersedence(DEFAULT_TEAM_ID, { factId: "fact_xyz" }, logPath);
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
    expect("reason" in entry).toBe(false);
    expect("source" in entry).toBe(false);
  });

  it("shares the log file with session entries without interference", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendSupersedence(DEFAULT_TEAM_ID, { predecessorId: "sess_a", successorId: "sess_b" }, logPath);
    await appendFactSupersedence(DEFAULT_TEAM_ID, { factId: "fact_c", reason: "stale" }, logPath);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const session = JSON.parse(lines[0]!) as Record<string, unknown>;
    const fact = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(session["predecessor_id"]).toBe("sess_a");
    expect(fact["kind"]).toBe("fact");
  });

  it("does not throw on write failure, but warns on stderr", async () => {
    const block = join(tmp, "blocking-file");
    writeFileSync(block, "not a dir");
    const logPath = join(block, "supersedence-log.jsonl");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      appendFactSupersedence(DEFAULT_TEAM_ID, { factId: "fact_x" }, logPath),
    ).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(String(stderrSpy.mock.calls[0]?.[0] ?? "")).toContain("fact-supersedence-log");
  });
});

describe("supersedence-log tenant path contract", () => {
  afterEach(() => {
    delete process.env["NLM_SUPERSEDENCE_LOG"];
  });

  it("default team honors NLM_SUPERSEDENCE_LOG override (legacy behavior)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-sup-tenant-"));
    const logPath = join(dir, "supersedence-log.jsonl");
    process.env["NLM_SUPERSEDENCE_LOG"] = logPath;
    try {
      await appendSupersedence(DEFAULT_TEAM_ID, { predecessorId: "a", successorId: "b" });
      expect(existsSync(logPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-default tenant writes under ~/.nlm/tenants/<t>/supersedence-log.jsonl, ignoring NLM_SUPERSEDENCE_LOG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-sup-tenant-"));
    const logPath = join(dir, "supersedence-log.jsonl");
    process.env["NLM_SUPERSEDENCE_LOG"] = logPath;
    const derived = join(homedir(), ".nlm", "tenants", "acme-suplog-test", "supersedence-log.jsonl");
    try {
      await appendSupersedence("acme-suplog-test", { predecessorId: "a", successorId: "b" });
      expect(existsSync(logPath)).toBe(false);
      expect(existsSync(derived)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(derived, { force: true });
    }
  });

  it("two tenants' supersedence logs don't collide", async () => {
    const derivedA = join(homedir(), ".nlm", "tenants", "tenant-a-suplog", "supersedence-log.jsonl");
    const derivedB = join(homedir(), ".nlm", "tenants", "tenant-b-suplog", "supersedence-log.jsonl");
    try {
      await appendSupersedence("tenant-a-suplog", { predecessorId: "sess_a1", successorId: "sess_a2" });
      await appendSupersedence("tenant-b-suplog", { predecessorId: "sess_b1", successorId: "sess_b2" });
      const a = await readSupersedenceLog("tenant-a-suplog");
      const b = await readSupersedenceLog("tenant-b-suplog");
      expect(a).toHaveLength(1);
      expect(a[0]?.predecessorId).toBe("sess_a1");
      expect(b).toHaveLength(1);
      expect(b[0]?.predecessorId).toBe("sess_b1");
    } finally {
      rmSync(derivedA, { force: true });
      rmSync(derivedB, { force: true });
    }
  });
});
