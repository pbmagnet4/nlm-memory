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
 * `connect` converges `packages` on exactly one entry for the connected
 * build: it writes the floating `current`-symlink path for versioned
 * installs so upgrades do not need a re-connect, migrates version-pinned
 * entries for the same build to it, and evicts entries that would load a
 * different nlm-memory build (dev checkouts, dead paths, legacy
 * `plugin-pi`). `disconnect` strips any matching entry.
 *
 * Idempotent. Format-preserving where possible — pi's settings.json is pure
 * JSON with no comments, so JSON.parse / JSON.stringify with 2-space indent
 * matches pi's own write convention.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  /** packages[] entries removed because they pointed at a different nlm-memory build. */
  readonly evicted: readonly string[];
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

/**
 * Resolve a packages[] entry the way pi does: relative to the pi agent
 * dir, not the connecting process's cwd.
 */
function resolvePackageEntry(entry: string): string {
  return resolve(piAgentDir(), entry);
}

/** realpath when the target exists, lexical resolution otherwise. */
function canonicalOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Floating equivalent of a version-pinned install path:
 * `<root>/versions/<v>/app/nlm` → `<root>/current/app/nlm` when that
 * symlink exists, so the wiring survives upgrades instead of pinning the
 * build that happened to be current at connect time. Falls back to the
 * resolved path for layouts without a versions/current pair (dev
 * checkouts, npm installs).
 */
function floatPluginDir(pluginDir: string): string {
  const resolved = resolve(pluginDir);
  const parts = resolved.split(sep);
  if (
    parts.length >= 5 &&
    parts[parts.length - 4] === "versions" &&
    parts[parts.length - 2] === "app" &&
    parts[parts.length - 1] === "nlm"
  ) {
    // Rejoin from segments rather than splicing the string: the leading
    // "" segment of an absolute path must survive, or join() returns a
    // relative path that existsSync can never find.
    const root = parts.slice(0, parts.length - 4).join(sep) || sep;
    const floating = join(root, "current", "app", "nlm");
    if (existsSync(floating)) return floating;
  }
  return resolved;
}

/** True when the directory is an nlm-memory pi extension root. */
function isNlmExtensionDir(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === "nlm-memory-pi";
  } catch {
    return false;
  }
}

export function connectPi(opts: ConnectPiOptions): ConnectPiReport {
  const settingsPath = piSettingsPath();
  const pluginDir = floatPluginDir(opts.pluginDir);
  const targetCanonical = canonicalOrResolved(resolvePackageEntry(pluginDir));
  const settings = readSettings(settingsPath);
  const rawPackages = Array.isArray(settings.packages) ? settings.packages : [];

  // Evict entries that would load a different nlm-memory build alongside
  // the one being connected. A dev-checkout path next to the deployed
  // install fires the same hook twice from two builds — the older bundle
  // predates the hook-log version stamp, so every one of its fires reads
  // as a stale hook in the digest parity check. Identification is positive
  // (package.json name), never bare-basename: an unrelated `nlm` dir is
  // left alone, while a dead nlm path that resolves nowhere is dropped
  // because pi could not load it anyway.
  const evicted: string[] = [];
  const kept = rawPackages.filter((p) => {
    if (typeof p !== "string") return true;
    const base = basename(resolvePackageEntry(p));
    if (base === "plugin-pi") {
      // Legacy entries from nlm-memory <= 0.5.19. The old path no longer
      // resolves on disk after upgrade, so pi would silently fail to load
      // it — cleaner to strip it here.
      evicted.push(p);
      return false;
    }
    if (canonicalOrResolved(resolvePackageEntry(p)) === targetCanonical) return true;
    const abs = resolvePackageEntry(p);
    if (base === "nlm" && (!existsSync(abs) || isNlmExtensionDir(abs))) {
      evicted.push(p);
      return false;
    }
    return true;
  });

  // A version-pinned entry for the same build counts as present, but its
  // literal form is migrated to the floating path so the next upgrade
  // does not need another connect.
  let migrated = false;
  const packages = kept.map((p) => {
    if (
      typeof p === "string" &&
      canonicalOrResolved(resolvePackageEntry(p)) === targetCanonical &&
      resolvePackageEntry(p) !== resolvePackageEntry(pluginDir)
    ) {
      migrated = true;
      return pluginDir;
    }
    return p;
  });

  const alreadyPresent = packages.some(
    (p) => typeof p === "string" && canonicalOrResolved(resolvePackageEntry(p)) === targetCanonical,
  );

  if (opts.dryRun) {
    return { settingsPath, pluginDir, alreadyPresent, evicted, written: false, dryRun: true };
  }

  if (alreadyPresent && evicted.length === 0 && !migrated) {
    return { settingsPath, pluginDir, alreadyPresent: true, evicted, written: false, dryRun: false };
  }

  if (!alreadyPresent) packages.push(pluginDir);
  writeSettings(settingsPath, { ...settings, packages });
  return { settingsPath, pluginDir, alreadyPresent, evicted, written: true, dryRun: false };
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
