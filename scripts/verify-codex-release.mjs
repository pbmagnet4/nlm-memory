#!/usr/bin/env node
/**
 * Release contract for Codex support.
 *
 * This runs after `npm run build` and before `npm publish`. It validates the
 * exact files and configuration Codex consumes, then asks npm for the payload
 * it would publish. Keep this independent of a local Codex installation: a
 * release must be verifiable in CI as well as on an operator workstation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const checkPackedPayload = process.argv.includes("--check-packed");
const REQUIRED_PLUGIN_FILES = [
  "plugin/.codex-plugin/plugin.json",
  "plugin/.mcp.json",
  "plugin/hooks/hooks.json",
  "plugin/scripts/session-start-hook.mjs",
  "plugin/scripts/prompt-recall-hook.mjs",
  "plugin/scripts/stop-hook.mjs",
];
const REQUIRED_PACKED_FILES = ["dist/cli/nlm.js", ...REQUIRED_PLUGIN_FILES];

function fail(message) {
  process.stderr.write(`Codex release contract failed: ${message}\n`);
  process.exitCode = 1;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
}

const pkg = readJson("package.json");
const plugin = readJson("plugin/.codex-plugin/plugin.json");
const mcp = readJson("plugin/.mcp.json");
const hookConfig = readJson("plugin/hooks/hooks.json");

if (plugin.version !== pkg.version) fail("plugin version must match package.json");
if (plugin.name !== "nlm-memory") fail("plugin name must be nlm-memory");
if (plugin.mcpServers !== "./.mcp.json") fail("plugin must declare ./.mcp.json");
if (plugin.hooks !== "./hooks/hooks.json") fail("plugin must declare ./hooks/hooks.json");

const nlmMcp = mcp.mcpServers?.["nlm-memory"];
if (nlmMcp?.command !== "nlm" || JSON.stringify(nlmMcp.args) !== JSON.stringify(["mcp"])) {
  fail("plugin MCP must launch the package's `nlm mcp` stdio server");
}

for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
  const command = hookConfig.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string" || !command.includes("NLM_HOOK_RUNTIME=codex")) {
    fail(`${event} must invoke the Codex-attributed hook`);
  }
  if (!command?.includes("CODEX_PLUGIN_ROOT") || !command.includes("CLAUDE_PLUGIN_ROOT")) {
    fail(`${event} must resolve the Codex plugin root with the compatibility fallback`);
  }
}

for (const path of REQUIRED_PLUGIN_FILES) {
  const absolute = resolve(ROOT, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`missing built distribution file ${path}`);
}

if (checkPackedPayload) {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    fail(`npm pack --dry-run failed: ${packed.stderr.trim() || packed.stdout.trim()}`);
  } else {
    try {
      const files = new Set(JSON.parse(packed.stdout)[0]?.files?.map((entry) => entry.path));
      for (const path of REQUIRED_PACKED_FILES) {
        if (!files.has(path)) fail(`published tarball would omit ${path}`);
      }
    } catch (error) {
      fail(`could not read npm pack manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (!process.exitCode) process.stdout.write("Codex release contract passed.\n");
