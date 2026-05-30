/**
 * appendSupersedence — telemetry-style writer for the supersedence audit
 * log. Must never throw, but must surface failures via stderr so an
 * operator notices when their audit trail silently goes missing.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendSupersedence } from "../../../src/core/storage/supersedence-log.js";

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
      { predecessorId: "sess_a", successorId: "sess_b" },
      logPath,
    );
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
    expect("reason" in entry).toBe(false);
    expect("source" in entry).toBe(false);
  });

  it("appends rather than overwrites on multiple calls", async () => {
    const logPath = join(tmp, "supersedence-log.jsonl");
    await appendSupersedence({ predecessorId: "a", successorId: "b" }, logPath);
    await appendSupersedence({ predecessorId: "c", successorId: "d" }, logPath);
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
      appendSupersedence({ predecessorId: "a", successorId: "b" }, logPath),
    ).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]?.[0] ?? "";
    expect(String(written)).toContain("failed to append supersedence-log");
    expect(String(written)).toContain(logPath);
  });
});
