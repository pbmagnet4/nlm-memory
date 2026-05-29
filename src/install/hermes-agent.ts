/**
 * `nlm connect hermes-agent` / `nlm disconnect hermes-agent` — installs the
 * nlm-memory plugin into NousResearch Hermes Agent's plugin directory and
 * optionally enables it via the `hermes` binary.
 *
 * The plugin lives in plugin-hermes-agent/ at the repo root. `connect`
 * copies it to ~/.hermes/plugins/nlm-memory/ (flat layout, one category
 * level max per Hermes plugin discovery rules). `disconnect` removes that
 * directory.
 *
 * MCP server wiring (the [mcp_servers.nlm-memory] block in
 * ~/.hermes/config.yaml) is handled separately by `nlm connect hermes`.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface ConnectHermesAgentOptions {
  readonly pluginSrcDir: string;
  readonly dryRun?: boolean;
  readonly enableViaCliIfAvailable?: boolean;
}

export interface ConnectHermesAgentReport {
  readonly destDir: string;
  readonly copied: boolean;
  readonly alreadyPresent: boolean;
  readonly enabledViaCli: boolean;
  readonly dryRun: boolean;
}

export interface DisconnectHermesAgentReport {
  readonly destDir: string;
  readonly removed: boolean;
  readonly dryRun: boolean;
}

export function hermesAgentPluginDir(): string {
  return process.env["NLM_HERMES_PLUGIN_DIR"] ?? join(homedir(), ".hermes", "plugins", "nlm-memory");
}

export function connectHermesAgent(opts: ConnectHermesAgentOptions): ConnectHermesAgentReport {
  const destDir = hermesAgentPluginDir();
  const alreadyPresent = existsSync(destDir);

  if (!opts.dryRun) {
    mkdirSync(dirname(destDir), { recursive: true });
    cpSync(opts.pluginSrcDir, destDir, { recursive: true });

    let enabledViaCli = false;
    if (opts.enableViaCliIfAvailable !== false) {
      const result = spawnSync("hermes", ["plugins", "enable", "nlm-memory"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      enabledViaCli = result.status === 0;
    }
    return { destDir, copied: true, alreadyPresent, enabledViaCli, dryRun: false };
  }

  return { destDir, copied: false, alreadyPresent, enabledViaCli: false, dryRun: true };
}

export function disconnectHermesAgent(opts?: { dryRun?: boolean }): DisconnectHermesAgentReport {
  const destDir = hermesAgentPluginDir();
  const present = existsSync(destDir);

  if (!opts?.dryRun && present) {
    rmSync(destDir, { recursive: true, force: true });
    return { destDir, removed: true, dryRun: false };
  }

  return { destDir, removed: false, dryRun: opts?.dryRun ?? false };
}
