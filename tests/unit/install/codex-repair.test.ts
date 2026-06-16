import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasNlmMcpTable,
  repairCodex,
  stripStaleCodexEntry,
  writeMcpServerToConfig,
} from "../../../src/install/codex.js";

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

  it("removes the real legacy shapes: plugin + hooks.state tables", () => {
    const toml = [
      '[plugins."nlm-memory@nlm-memory-ts"]',
      "enabled = true",
      "",
      '[hooks.state."nlm-memory@nlm-memory-ts:hooks/hooks.json:stop:0:0"]',
      "fired = 3",
      "",
      "[other]",
      "x = 1",
    ].join("\n");
    const out = stripStaleCodexEntry(toml);
    expect(out).not.toContain("nlm-memory-ts");
    expect(out).toContain("[other]");
    expect(out).toContain("x = 1");
  });

  it("preserves a legitimate local project path containing nlm-memory-ts", () => {
    const toml = [
      '[plugins."nlm-memory@nlm-memory-ts"]',
      "enabled = true",
      "",
      '[projects."/Users/me/Coding Projects/nlm-memory-ts"]',
      "trusted = true",
    ].join("\n");
    const out = stripStaleCodexEntry(toml);
    expect(out).not.toContain("nlm-memory@nlm-memory-ts");
    // the project path is not a stale entry — it must survive
    expect(out).toContain('[projects."/Users/me/Coding Projects/nlm-memory-ts"]');
    expect(out).toContain("trusted = true");
  });

  it("removes a quoted legacy mcp table and its sentinel comments", () => {
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

describe("writeMcpServerToConfig — never duplicates the MCP table", () => {
  let tmp: string;
  let orig: string | undefined;
  let cfg: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-codex-write-"));
    cfg = join(tmp, "config.toml");
    orig = process.env["NLM_CODEX_CONFIG"];
    process.env["NLM_CODEX_CONFIG"] = cfg;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (orig === undefined) delete process.env["NLM_CODEX_CONFIG"];
    else process.env["NLM_CODEX_CONFIG"] = orig;
  });

  it("writes a managed block when none exists", () => {
    writeFileSync(cfg, "[mcp_servers.foo]\ncommand = \"foo\"\n");
    expect(writeMcpServerToConfig(cfg)).toBe("written");
    const txt = readFileSync(cfg, "utf8");
    expect(hasNlmMcpTable(txt)).toBe(true);
    expect(txt.match(/\[mcp_servers\.nlm-memory\]/g)).toHaveLength(1);
  });

  it("leaves a hand-authored bare block untouched instead of duplicating", () => {
    const bare = '[mcp_servers.nlm-memory]\ncommand = "node"\nargs = ["x"]\n\n[mcp_servers.nlm-memory.env]\nNLM_FORMAT = "toon"\n';
    writeFileSync(cfg, bare);
    expect(writeMcpServerToConfig(cfg)).toBe("skipped-existing");
    const txt = readFileSync(cfg, "utf8");
    // exactly one table, and the user's customization survives
    expect(txt.match(/\[mcp_servers\.nlm-memory\]/g)).toHaveLength(1);
    expect(txt).toContain('NLM_FORMAT = "toon"');
  });

  it("refreshes its own sentineled block without duplicating", () => {
    writeMcpServerToConfig(cfg); // first write
    expect(writeMcpServerToConfig(cfg)).toBe("written"); // second write refreshes
    expect(readFileSync(cfg, "utf8").match(/\[mcp_servers\.nlm-memory\]/g)).toHaveLength(1);
  });
});
