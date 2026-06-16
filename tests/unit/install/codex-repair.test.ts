import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repairCodex, stripStaleCodexEntry } from "../../../src/install/codex.js";

describe("stripStaleCodexEntry", () => {
  it("removes a bare [mcp_servers.nlm-memory-ts] table up to the next table", () => {
    const toml = [
      "[mcp_servers.nlm-memory-ts]",
      'command = "nlm-memory-ts"',
      'args = ["mcp"]',
      "",
      "[mcp_servers.other]",
      'command = "other"',
    ].join("\n");
    const out = stripStaleCodexEntry(toml);
    expect(out).not.toContain("nlm-memory-ts");
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain('command = "other"');
  });

  it("removes a quoted legacy table key and its sentinel comments", () => {
    const toml = [
      "# >>> nlm-memory-ts (managed)",
      '[mcp_servers."nlm-memory-ts"]',
      'command = "nlm-memory-ts"',
      "# <<< nlm-memory-ts",
      "[other]",
      "x = 1",
    ].join("\n");
    const out = stripStaleCodexEntry(toml);
    expect(out).not.toContain("nlm-memory-ts");
    expect(out).toContain("[other]");
    expect(out).toContain("x = 1");
  });

  it("leaves the current nlm-memory table untouched", () => {
    const toml = [
      "# >>> nlm-memory (managed by nlm connect codex)",
      "[mcp_servers.nlm-memory]",
      'command = "nlm"',
      "# <<< nlm-memory",
    ].join("\n");
    expect(stripStaleCodexEntry(toml)).toBe(toml);
  });

  it("is a no-op when no legacy entry exists", () => {
    const toml = "[mcp_servers.foo]\ncommand = \"foo\"\n";
    expect(stripStaleCodexEntry(toml)).toBe(toml);
  });
});

describe("repairCodex (dry-run)", () => {
  let tmp: string;
  let orig: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-codex-repair-"));
    orig = process.env["NLM_CODEX_CONFIG"];
    process.env["NLM_CODEX_CONFIG"] = join(tmp, "config.toml");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (orig === undefined) delete process.env["NLM_CODEX_CONFIG"];
    else process.env["NLM_CODEX_CONFIG"] = orig;
  });

  it("flags a stale config and does not mutate it on dry-run", () => {
    const cfgPath = join(tmp, "config.toml");
    const before = '[mcp_servers.nlm-memory-ts]\ncommand = "nlm-memory-ts"\n';
    writeFileSync(cfgPath, before);

    const report = repairCodex({ dryRun: true }, "/repo/plugin/scripts");

    expect(report.dryRun).toBe(true);
    expect(report.staleMcpRemovedFromConfig).toBe(true); // would remove
    expect(report.connect.dryRun).toBe(true);
    // dry-run must not touch the file
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("reports no stale block when the config is clean", () => {
    writeFileSync(join(tmp, "config.toml"), "[mcp_servers.foo]\n");
    const report = repairCodex({ dryRun: true }, "/repo/plugin/scripts");
    expect(report.staleMcpRemovedFromConfig).toBe(false);
  });
});
