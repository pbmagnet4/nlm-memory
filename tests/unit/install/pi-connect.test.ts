// tests/unit/install/pi-connect.test.ts
//
// `nlm connect pi` must converge pi's packages[] on exactly one CURRENT
// nlm-memory extension entry.
//
// WHY: pi loaded its prompt-recall hook from the nlm-memory dev checkout
// while the daemon served the deployed install. The dev bundle predates the
// hook-log version stamp, so every pi fire looked like a stale build and the
// daily digest raised WARN hook version unknown — while the real problem was
// a second, older extension entry coexisting with the deployed one.
// connect only stripped legacy `plugin-pi` basenames, so re-running it
// appended a duplicate instead of converging. These tests pin: eviction of
// non-current nlm-memory-pi entries, the floating `current` path, and
// migration of version-pinned entries to it.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPi } from "../../../src/install/pi.js";

const ENV_KEY = "NLM_PI_AGENT_DIR";
let savedEnv: string | undefined;
let agentDir: string;

function writeSettings(packages: unknown): void {
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages })}\n`, "utf8");
}

function readPackages(): unknown[] {
  return (JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages: unknown[] }).packages;
}

function makeExtension(parent: string): string {
  // Production shape: the extension root's basename is `nlm`, which the
  // eviction rule keys on — keep it here so the tests exercise the rule.
  const dir = join(parent, "nlm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "nlm-memory-pi", version: "0.0.0", type: "module" })}\n`,
    "utf8",
  );
  writeFileSync(join(dir, "index.js"), "export default function nlmExtension() {}\n", "utf8");
  return dir;
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
  process.env[ENV_KEY] = agentDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("connectPi — floating install path", () => {
  it("writes the `current` path for a versioned install layout", () => {
    const root = mkdtempSync(join(tmpdir(), "nlm-root-"));
    const pinned = makeExtension(join(root, "versions", "0.21.21-t1208.1", "app"));
    symlinkSync(join(root, "versions", "0.21.21-t1208.1"), join(root, "current"));
    writeSettings([]);

    const report = connectPi({ pluginDir: pinned });

    expect(readPackages()).toEqual([join(root, "current", "app", "nlm")]);
    expect(report.pluginDir).toBe(join(root, "current", "app", "nlm"));
  });

  it("falls back to the resolved path without a versions/current layout", () => {
    const dev = makeExtension(mkdtempSync(join(tmpdir(), "nlm-dev-")));
    writeSettings([]);

    const report = connectPi({ pluginDir: dev });

    expect(readPackages()).toEqual([dev]);
    expect(report.pluginDir).toBe(dev);
  });
});

describe("connectPi — stale entry eviction", () => {
  it("evicts a dev-checkout nlm-memory-pi entry and keeps everything else", () => {
    const target = makeExtension(mkdtempSync(join(tmpdir(), "nlm-target-")));
    const dev = makeExtension(mkdtempSync(join(tmpdir(), "nlm-dev-")));
    writeSettings(["npm:other", dev]);

    const report = connectPi({ pluginDir: target });

    expect(readPackages()).toEqual(["npm:other", target]);
    expect(report.evicted).toEqual([dev]);
  });

  it("migrates a version-pinned entry to the floating path instead of duplicating", () => {
    const root = mkdtempSync(join(tmpdir(), "nlm-root-"));
    const pinned = makeExtension(join(root, "versions", "0.21.21-t1208.1", "app"));
    symlinkSync(join(root, "versions", "0.21.21-t1208.1"), join(root, "current"));
    writeSettings([pinned]);

    const report = connectPi({ pluginDir: pinned });

    expect(readPackages()).toEqual([join(root, "current", "app", "nlm")]);
    expect(report.alreadyPresent).toBe(true);
  });

  it("evicts dead nlm entries that no longer resolve on disk", () => {
    const target = makeExtension(mkdtempSync(join(tmpdir(), "nlm-target-")));
    const dead = join(tmpdir(), "nlm-gone-versions", "0.1", "app", "nlm");
    writeSettings([dead, "npm:other"]);

    const report = connectPi({ pluginDir: target });

    expect(readPackages()).toEqual(["npm:other", target]);
    expect(report.evicted).toEqual([dead]);
  });

  it("dry-run reports eviction without writing", () => {
    const target = makeExtension(mkdtempSync(join(tmpdir(), "nlm-target-")));
    const dev = makeExtension(mkdtempSync(join(tmpdir(), "nlm-dev-")));
    writeSettings([dev]);
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");

    const report = connectPi({ pluginDir: target, dryRun: true });

    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
    expect(report.evicted).toEqual([dev]);
    expect(report.written).toBe(false);
  });
});
