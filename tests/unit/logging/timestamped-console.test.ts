import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  logLevelFor,
  prefixLogLine,
  installTimestampedConsole,
  type ConsoleLike,
} from "../../../src/core/logging/timestamped-console.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Fixed clock: 2026-02-05T07:08:09.123Z
const TS_MS = Date.UTC(2026, 1, 5, 7, 8, 9, 123);
const TS_ISO = "2026-02-05T07:08:09.123Z";

function fakeConsole() {
  const lines: Array<{ method: string; text: string }> = [];
  const target: ConsoleLike = {
    log: (...a: unknown[]) => lines.push({ method: "log", text: String(a[0]) }),
    warn: (...a: unknown[]) => lines.push({ method: "warn", text: String(a[0]) }),
    error: (...a: unknown[]) => lines.push({ method: "error", text: String(a[0]) }),
  };
  return { target, lines };
}

describe("logLevelFor", () => {
  it("ERROR for console.error lines containing error/fail/unreachable, case-insensitive", () => {
    expect(logLevelFor("error", "Embed error: connect refused")).toBe("ERROR");
    expect(logLevelFor("error", "[x] sweep FAILED twice")).toBe("ERROR");
    expect(logLevelFor("error", "classifier Unreachable after 3 tries")).toBe("ERROR");
  });

  it("WARN for console.warn regardless of text, and for lines starting with warn", () => {
    expect(logLevelFor("warn", "everything is fine")).toBe("WARN");
    expect(logLevelFor("error", "warn before you proceed")).toBe("WARN");
    expect(logLevelFor("log", "Warning: WAL is 38 MB")).toBe("WARN");
  });

  it("INFO otherwise, and the error-stream check wins over the warn prefix", () => {
    expect(logLevelFor("log", "nlm-memory http listening on 3940")).toBe("INFO");
    expect(logLevelFor("error", "  db:     /Users/x/.nlm/canonical.sqlite")).toBe("INFO");
    // "warning: ... unreachable" on the error stream reads as an error.
    expect(logLevelFor("error", "warning: ollama unreachable")).toBe("ERROR");
  });
});

describe("prefixLogLine", () => {
  it("prefixes `<ISO-8601 UTC ms> <LEVEL> ` to the message", () => {
    expect(prefixLogLine("error", "db unreachable", TS_MS)).toBe(`${TS_ISO} ERROR db unreachable`);
  });

  it("multi-line messages: only the first line is prefixed, the rest is byte-identical", () => {
    const msg = "ingest failed\nat foo (a.ts:1)\n  bar";
    expect(prefixLogLine("error", msg, TS_MS)).toBe(`${TS_ISO} ERROR ingest failed\nat foo (a.ts:1)\n  bar`);
  });

  it("an empty message still gets a prefix line", () => {
    expect(prefixLogLine("log", "", TS_MS)).toBe(`${TS_ISO} INFO `);
  });
});

describe("installTimestampedConsole", () => {
  it("wraps log/warn/error, formats args like util.format, and restores on the returned call", () => {
    const { target, lines } = fakeConsole();
    const restore = installTimestampedConsole({ target, now: () => TS_MS });

    target.error("embedding %s for %d", "failed", 3);
    target.log("plain %s", "line");
    target.warn("careful");
    expect(lines).toEqual([
      { method: "error", text: `${TS_ISO} ERROR embedding failed for 3` },
      { method: "log", text: `${TS_ISO} INFO plain line` },
      { method: "warn", text: `${TS_ISO} WARN careful` },
    ]);

    restore();
    target.error("back to raw");
    expect(lines[lines.length - 1]!.text).toBe("back to raw");
    restore(); // idempotent
    expect(lines[lines.length - 1]!.text).toBe("back to raw");
  });
});

describe("daemon start vs one-shot CLI", () => {
  it("the wrapper is installed only in the `start` command action", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(REPO_ROOT, "src", "cli", "nlm.ts"), "utf8");
    const startIdx = src.indexOf('.command("start")');
    const nextCommandIdx = src.indexOf('program\n  .command("migrate")');
    expect(startIdx).toBeGreaterThan(-1);
    expect(nextCommandIdx).toBeGreaterThan(startIdx);
    const startAction = src.slice(startIdx, nextCommandIdx);
    expect(startAction).toContain("installTimestampedConsole()");
    // Exactly one call site in the whole CLI entry point.
    const callSites = src.match(/installTimestampedConsole\(\)/g) ?? [];
    expect(callSites).toHaveLength(1);
  });

  it("one-shot CLI output carries no timestamp prefix", () => {
    // `misses` with an absent log writes two console.error lines and exits 0
    // without touching the DB. Spawn the real entry point (same as tsx dev).
    const tmp = mkdtempSync(join(tmpdir(), "nlm-cli-prefix-"));
    try {
      const r = spawnSync(
        process.execPath,
        [join(REPO_ROOT, "node_modules", ".bin", "tsx"), join(REPO_ROOT, "src", "cli", "nlm.ts"), "misses"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 90_000,
          env: { ...process.env, NLM_MISS_LOG: join(tmp, "absent.jsonl"), NLM_STATE_ROOT: tmp, HOME: tmp },
        },
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("No miss log");
      expect(r.stderr).toMatch(/^nlm|^No/m);
      expect(r.stderr).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /m);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
