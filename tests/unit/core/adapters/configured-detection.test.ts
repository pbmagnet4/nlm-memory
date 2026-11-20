import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../../../src/core/adapters/claude-code.js";
import { CodexAdapter } from "../../../../src/core/adapters/codex.js";
import { HermesAdapter } from "../../../../src/core/adapters/hermes.js";
import { MuseAdapter } from "../../../../src/core/adapters/muse.js";
import { PiAdapter } from "../../../../src/core/adapters/pi.js";

const create = [
  ["claude-code", (path: string) => new ClaudeCodeAdapter({ projectsPath: path })],
  ["codex", (path: string) => new CodexAdapter({ sessionsPath: path })],
  ["hermes", (path: string) => new HermesAdapter({ sessionsPath: path })],
  ["muse", (path: string) => new MuseAdapter({ sessionsPath: path })],
  ["pi", (path: string) => new PiAdapter({ sessionsPath: path })],
] as const;

describe.each(create)("%s configured source detection", (_name, adapter) => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "nlm-detection-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("enables the configured directory and reports its actual path", () => {
    expect(adapter(tmp).detect()).toMatchObject({ enabled: true, path: tmp });
  });

  it("refuses a missing or non-directory configured path", () => {
    const file = join(tmp, "file");
    writeFileSync(file, "not a directory");
    expect(adapter(file).detect()).toMatchObject({ enabled: false, path: null });
    expect(adapter(join(tmp, "missing")).detect()).toMatchObject({ enabled: false, path: null });
  });
});
