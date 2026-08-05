/**
 * `nlm connect pi` / `nlm disconnect pi` — registers the bundled pi extension
 * in pi.dev's settings so the prompt-recall hook auto-loads on every pi start.
 *
 * Pi has no plugin install directory analogous to Hermes' ~/.hermes/plugins/.
 * Instead, pi reads `packages: [...]` from ~/.pi/agent/settings.json and
 * resolves each entry on startup — a path to a directory containing an
 * `index.js` (or `index.ts`) auto-loads as the extension entry.
 *
 * The nlm/ directory inside this npm package ships exactly that shape:
 * `index.js` is the bundled extension; `package.json` declares `type: module`.
 * Pi's interactive UI strips `index.{ts,js}` from the display path, so the
 * extension surfaces as `nlm` in the [Extensions] list — matching the
 * naming convention used by pi-mcp-adapter, my-tasks, etc.
 *
 * `connect` appends the absolute path to that directory into `packages` if
 * not already present. `disconnect` strips any matching entry.
 *
 * Idempotent. Format-preserving where possible — pi's settings.json is pure
 * JSON with no comments, so JSON.parse / JSON.stringify with 2-space indent
 * matches pi's own write convention.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isStdioBlock, piMcpEntry, type McpTransport } from "./mcp-block.js";

export interface ConnectPiOptions {
  /** Absolute path to the plugin-pi/ directory shipped with nlm-memory. */
  readonly pluginDir: string;
  readonly dryRun?: boolean;
}

export interface ConnectPiReport {
  readonly settingsPath: string;
  readonly pluginDir: string;
  readonly alreadyPresent: boolean;
  readonly written: boolean;
  readonly dryRun: boolean;
}

export interface DisconnectPiReport {
  readonly settingsPath: string;
  readonly removed: boolean;
  readonly dryRun: boolean;
}

interface PiSettings {
  packages?: string[];
  [key: string]: unknown;
}

export function piAgentDir(): string {
  return process.env["NLM_PI_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

export function piSettingsPath(): string {
  return join(piAgentDir(), "settings.json");
}

/**
 * pi's MCP servers live in a separate file from settings.json — pi core has
 * no MCP concept; the pi-mcp-adapter extension reads this one.
 */
export function piMcpConfigPath(): string {
  return process.env["NLM_PI_MCP_CONFIG"] ?? join(piAgentDir(), "mcp.json");
}

export interface PiMcpReport {
  readonly mcpConfigPath: string;
  readonly alreadyPresent: boolean;
  readonly migratedFromStdio: boolean;
  readonly transport: McpTransport;
  readonly written: boolean;
}

/**
 * Register nlm-memory as an MCP server for pi. Separate from connectPi's
 * extension registration: the extension supplies the prompt-recall hook, this
 * supplies the callable tools. A user wants both, but they are different
 * files and either can exist without the other.
 */
export function connectPiMcp(opts: {
  readonly transport?: McpTransport;
  readonly nlmBinPath?: string;
  readonly nodeExecPath?: string;
  readonly port?: string;
  readonly dryRun?: boolean;
}): PiMcpReport {
  const mcpConfigPath = piMcpConfigPath();
  const transport: McpTransport = opts.transport ?? "http";

  let config: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {};
  if (existsSync(mcpConfigPath)) {
    try {
      config = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    } catch {
      throw new Error(`pi mcp.json at ${mcpConfigPath} is not valid JSON`);
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const alreadyPresent = "nlm-memory" in servers;
  const migratedFromStdio = transport === "http" && alreadyPresent && isStdioBlock(servers["nlm-memory"]);

  const entry = piMcpEntry({
    transport,
    ...(opts.nlmBinPath ? { nlmBinPath: opts.nlmBinPath } : {}),
    ...(opts.nodeExecPath ? { nodeExecPath: opts.nodeExecPath } : {}),
    ...(opts.port ? { port: opts.port } : {}),
  });

  if (!opts.dryRun) {
    servers["nlm-memory"] = entry;
    config.mcpServers = servers;
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    writeFileSync(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  return { mcpConfigPath, alreadyPresent, migratedFromStdio, transport, written: !opts.dryRun };
}

function readSettings(path: string): PiSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PiSettings;
  } catch {
    // Malformed settings — fail loud rather than overwrite. Pi itself would
    // also reject this; we don't want to mask the underlying problem.
    throw new Error(`pi settings.json at ${path} is not valid JSON`);
  }
}

function writeSettings(path: string, settings: PiSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function connectPi(opts: ConnectPiOptions): ConnectPiReport {
  const settingsPath = piSettingsPath();
  const pluginDir = resolve(opts.pluginDir);
  const settings = readSettings(settingsPath);
  const rawPackages = Array.isArray(settings.packages) ? settings.packages : [];

  // Drop any legacy `plugin-pi` entries from nlm-memory <= 0.5.19 so the
  // user doesn't end up with both the old basename and the new `nlm` one.
  // The old path no longer resolves on disk after upgrade, so pi would
  // silently fail to load it — cleaner to strip it here.
  const packages = rawPackages.filter((p) => basename(resolve(p)) !== "plugin-pi");
  const migrated = packages.length !== rawPackages.length;

  const alreadyPresent = packages.some((p) => resolve(p) === pluginDir);

  if (alreadyPresent && !migrated) {
    return {
      settingsPath,
      pluginDir,
      alreadyPresent: true,
      written: false,
      dryRun: Boolean(opts.dryRun),
    };
  }

  if (opts.dryRun) {
    return {
      settingsPath,
      pluginDir,
      alreadyPresent,
      written: false,
      dryRun: true,
    };
  }

  if (!alreadyPresent) packages.push(pluginDir);
  writeSettings(settingsPath, { ...settings, packages });
  return { settingsPath, pluginDir, alreadyPresent, written: true, dryRun: false };
}

export function disconnectPi(opts?: { dryRun?: boolean }): DisconnectPiReport {
  const settingsPath = piSettingsPath();
  if (!existsSync(settingsPath)) {
    return { settingsPath, removed: false, dryRun: opts?.dryRun ?? false };
  }
  const settings = readSettings(settingsPath);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  // Match on basename so we strip any nlm entry regardless of where the
  // user's npm prefix put the nlm-memory install. Also strips the legacy
  // basename "plugin-pi" left behind by nlm-memory <= 0.5.19 so users who
  // ran the older connect still get a clean disconnect.
  const filtered = packages.filter((p) => {
    const base = basename(resolve(p));
    return base !== "nlm" && base !== "plugin-pi";
  });

  if (filtered.length === packages.length) {
    return { settingsPath, removed: false, dryRun: opts?.dryRun ?? false };
  }

  if (opts?.dryRun) {
    return { settingsPath, removed: false, dryRun: true };
  }

  writeSettings(settingsPath, { ...settings, packages: filtered });
  return { settingsPath, removed: true, dryRun: false };
}
