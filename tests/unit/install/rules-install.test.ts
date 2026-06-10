import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cursorRulesPath,
  installCursorRules,
  installOpencodeRules,
  installWindsurfRules,
  opencodeRulesPath,
  uninstallCursorRules,
  uninstallOpencodeRules,
  uninstallWindsurfRules,
  windsurfRulesPath,
} from "../../../src/install/rules-install.js";

describe("rules-install path resolution", () => {
  it("cursor resolves under cwd", () => {
    expect(cursorRulesPath({ cwd: "/tmp/proj" })).toBe("/tmp/proj/.cursor/rules/nlm-recall.mdc");
  });

  it("windsurf resolves under home", () => {
    expect(windsurfRulesPath({ home: "/users/x" })).toBe(
      "/users/x/.codeium/windsurf/memories/global_rules.md",
    );
  });

  it("opencode resolves under home", () => {
    expect(opencodeRulesPath({ home: "/users/x" })).toBe(
      "/users/x/.config/opencode/AGENTS.md",
    );
  });
});

describe("installCursorRules + uninstallCursorRules", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nlm-cursor-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes a .mdc file with frontmatter and the rules body", () => {
    const result = installCursorRules({ cwd });
    expect(result.action).toBe("created");
    const path = cursorRulesPath({ cwd });
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("nlm-memory recall");
  });

  it("is idempotent", () => {
    installCursorRules({ cwd });
    const r2 = installCursorRules({ cwd });
    expect(r2.action).toBe("unchanged");
  });

  it("uninstall deletes the dedicated file", () => {
    installCursorRules({ cwd });
    const r = uninstallCursorRules({ cwd });
    expect(r.action).toBe("deleted-file");
    expect(existsSync(cursorRulesPath({ cwd }))).toBe(false);
  });

  it("uninstall no-ops when file missing", () => {
    const r = uninstallCursorRules({ cwd });
    expect(r.action).toBe("no-file");
  });
});

describe("installWindsurfRules + installOpencodeRules use sentinel-wrapped upsert", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nlm-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("Windsurf install creates global_rules.md with sentinel markers", () => {
    const r = installWindsurfRules({ home });
    expect(r.action).toBe("created");
    const content = readFileSync(windsurfRulesPath({ home }), "utf8");
    expect(content).toContain("<!-- nlm-memory:start -->");
    expect(content).toContain("<!-- nlm-memory:end -->");
    expect(content).not.toContain("alwaysApply");
  });

  it("OpenCode install creates AGENTS.md with sentinel markers", () => {
    const r = installOpencodeRules({ home });
    expect(r.action).toBe("created");
    const content = readFileSync(opencodeRulesPath({ home }), "utf8");
    expect(content).toContain("<!-- nlm-memory:start -->");
  });

  it("Windsurf uninstall removes only the managed block", () => {
    installWindsurfRules({ home });
    const r = uninstallWindsurfRules({ home });
    expect(r.action).toBe("deleted-file");
  });

  it("OpenCode uninstall is symmetric with install", () => {
    installOpencodeRules({ home });
    const r = uninstallOpencodeRules({ home });
    expect(r.action).toBe("deleted-file");
  });
});
