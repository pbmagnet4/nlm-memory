import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLegacyHooks } from "../../../src/install/codex.js";

const ROOT = resolve(__dirname, "../../..");

describe("Codex plugin distribution", () => {
  it("keeps plugin metadata aligned with the public package", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      version: string;
      license: string;
    };
    const plugin = JSON.parse(
      readFileSync(resolve(ROOT, "plugin/.codex-plugin/plugin.json"), "utf8"),
    ) as {
      version: string;
      license: string;
      repository: string;
      homepage: string;
    };

    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.repository).toContain("nlm-memory");
    expect(plugin.repository).not.toContain("nlm-memory-ts");
    expect(plugin.homepage).toContain("nlm-memory");
    expect(plugin.homepage).not.toContain("nlm-memory-ts");
  });

  it("marks packaged Codex hooks with Codex runtime attribution", () => {
    const hooks = JSON.parse(
      readFileSync(resolve(ROOT, "plugin/hooks/hooks.json"), "utf8"),
    ) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };

    const sessionStartCommand = hooks.hooks.SessionStart?.[0]?.hooks[0]?.command;
    const promptCommand = hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command;
    const stopCommand = hooks.hooks.Stop?.[0]?.hooks[0]?.command;

    expect(sessionStartCommand).toContain("NLM_HOOK_RUNTIME=codex");
    expect(sessionStartCommand).toContain("session-start-hook.mjs");
    expect(sessionStartCommand).toContain("CODEX_PLUGIN_ROOT");
    expect(sessionStartCommand).toContain("CLAUDE_PLUGIN_ROOT");
    expect(promptCommand).toContain("NLM_HOOK_RUNTIME=codex");
    expect(promptCommand).toContain("prompt-recall-hook.mjs");
    expect(promptCommand).toContain("CODEX_PLUGIN_ROOT");
    expect(promptCommand).toContain("CLAUDE_PLUGIN_ROOT");
    expect(stopCommand).toContain("NLM_HOOK_RUNTIME=codex");
    expect(stopCommand).toContain("stop-hook.mjs");
  });
});

describe("Codex legacy hook fallback", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-codex-hooks-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes absolute fallback hooks with Codex runtime attribution", () => {
    const hooksPath = join(tmp, "hooks.json");
    writeLegacyHooks(resolve(ROOT, "plugin/scripts"), hooksPath);
    const written = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };

    const sessionStartCommand = written.hooks.SessionStart?.[0]?.hooks[0]?.command;
    const promptCommand = written.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command;
    const stopCommand = written.hooks.Stop?.[0]?.hooks[0]?.command;

    expect(sessionStartCommand).toContain("NLM_HOOK_RUNTIME=codex");
    expect(sessionStartCommand).toContain(resolve(ROOT, "plugin/scripts/session-start-hook.mjs"));
    expect(promptCommand).toContain("NLM_HOOK_RUNTIME=codex");
    expect(promptCommand).toContain(resolve(ROOT, "plugin/scripts/prompt-recall-hook.mjs"));
    expect(stopCommand).toContain("NLM_HOOK_RUNTIME=codex");
    expect(stopCommand).toContain(resolve(ROOT, "plugin/scripts/stop-hook.mjs"));
  });
});
