import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitCommand } from "../../../src/cli/init.js";

const MARKER_BEGIN = "<!-- nlm-agent-contract:begin -->";
const MARKER_END = "<!-- nlm-agent-contract:end -->";

describe("runInitCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nlm-init-test-"));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("--agent claude-code emits the claude-code template to stdout", () => {
    const chunks: string[] = [];
    const errs: string[] = [];
    runInitCommand({
      agent: "claude-code",
      stdout: (s) => { chunks.push(s); },
      stderr: (s) => { errs.push(s); },
    });
    const out = chunks.join("");
    expect(out).toContain("recall_sessions");
    expect(out).toContain("cite_session");
    expect(out).toContain("get_session");
    expect(out).toContain("NLM");
    expect(errs).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("--agent generic emits the generic template to stdout", () => {
    const chunks: string[] = [];
    const errs: string[] = [];
    runInitCommand({
      agent: "generic",
      stdout: (s) => { chunks.push(s); },
      stderr: (s) => { errs.push(s); },
    });
    const out = chunks.join("");
    expect(out).toContain("recall_sessions");
    expect(out).toContain("cite_session");
    expect(out).toContain("get_session");
    expect(out).toContain("NLM");
    expect(errs).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("--write appends the block with begin/end markers, preserving existing content", () => {
    const target = join(tmpDir, "CLAUDE.md");
    writeFileSync(target, "# Existing content\n", "utf8");
    const chunks: string[] = [];
    const errs: string[] = [];

    runInitCommand({
      agent: "claude-code",
      write: target,
      stdout: (s) => { chunks.push(s); },
      stderr: (s) => { errs.push(s); },
    });

    expect(chunks).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();

    const content = readFileSync(target, "utf8");
    expect(content).toContain("# Existing content");
    expect(content).toContain(MARKER_BEGIN);
    expect(content).toContain(MARKER_END);
    expect(content).toContain("recall_sessions");

    const beginIdx = content.indexOf(MARKER_BEGIN);
    const existingIdx = content.indexOf("# Existing content");
    expect(beginIdx).toBeGreaterThan(existingIdx);
    expect(content.indexOf(MARKER_END)).toBeGreaterThan(beginIdx);
  });

  it("re-run without --force refuses with a clear message and leaves the file unchanged", () => {
    const target = join(tmpDir, "CLAUDE.md");
    const errs: string[] = [];

    runInitCommand({
      agent: "claude-code",
      write: target,
      stdout: () => {},
      stderr: (s) => { errs.push(s); },
    });

    const contentAfterFirst = readFileSync(target, "utf8");
    errs.length = 0;
    process.exitCode = undefined;

    runInitCommand({
      agent: "claude-code",
      write: target,
      stdout: () => {},
      stderr: (s) => { errs.push(s); },
    });

    expect(process.exitCode).toBe(1);
    const errOut = errs.join("");
    expect(errOut).toMatch(/already contains/);
    expect(errOut).toMatch(/--force/);
    expect(readFileSync(target, "utf8")).toBe(contentAfterFirst);
  });

  it("--force replaces the block in place, preserving content outside the markers", () => {
    const target = join(tmpDir, "CLAUDE.md");
    const errs: string[] = [];
    writeFileSync(target, "# Header\n", "utf8");

    runInitCommand({
      agent: "claude-code",
      write: target,
      stdout: () => {},
      stderr: (s) => { errs.push(s); },
    });

    const afterFirst = readFileSync(target, "utf8");
    writeFileSync(target, afterFirst + "\n# Footer\n", "utf8");
    errs.length = 0;
    process.exitCode = undefined;

    runInitCommand({
      agent: "generic",
      write: target,
      force: true,
      stdout: () => {},
      stderr: (s) => { errs.push(s); },
    });

    expect(process.exitCode).toBeUndefined();
    const final = readFileSync(target, "utf8");
    expect(final).toContain("# Header");
    expect(final).toContain("# Footer");
    expect(final.split(MARKER_BEGIN).length).toBe(2);
    expect(final.split(MARKER_END).length).toBe(2);
  });

  it("unknown agent name writes an error to stderr and sets exitCode 1", () => {
    const errs: string[] = [];

    runInitCommand({
      agent: "vscode",
      stdout: () => {},
      stderr: (s) => { errs.push(s); },
    });

    expect(process.exitCode).toBe(1);
    const errOut = errs.join("");
    expect(errOut).toMatch(/unknown agent/);
    expect(errOut).toContain("claude-code");
    expect(errOut).toContain("generic");
  });
});
