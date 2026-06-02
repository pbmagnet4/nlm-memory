/**
 * `nlm connect pi` / `nlm disconnect pi` — registers the bundled pi extension
 * in pi.dev's settings so the prompt-recall hook auto-loads on every pi start.
 *
 * Pi has no plugin install directory analogous to Hermes' ~/.hermes/plugins/.
 * Instead, pi reads `packages: [...]` from ~/.pi/agent/settings.json and
 * resolves each entry on startup — a path to a directory containing a
 * `package.json` with a `pi.extensions` field loads the declared modules.
 *
 * The plugin-pi/ directory inside this npm package ships exactly that shape:
 * `package.json` declares `pi.extensions: ["scripts/nlm-extension.mjs"]`.
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
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const alreadyPresent = packages.some((p) => resolve(p) === pluginDir);

  if (alreadyPresent || opts.dryRun) {
    return {
      settingsPath,
      pluginDir,
      alreadyPresent,
      written: false,
      dryRun: Boolean(opts.dryRun),
    };
  }

  packages.push(pluginDir);
  writeSettings(settingsPath, { ...settings, packages });
  return { settingsPath, pluginDir, alreadyPresent: false, written: true, dryRun: false };
}

export function disconnectPi(opts?: { dryRun?: boolean }): DisconnectPiReport {
  const settingsPath = piSettingsPath();
  if (!existsSync(settingsPath)) {
    return { settingsPath, removed: false, dryRun: opts?.dryRun ?? false };
  }
  const settings = readSettings(settingsPath);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  // Match on basename so we strip any plugin-pi entry regardless of where the
  // user's npm prefix put the nlm-memory install. The directory name is owned
  // by this package, so collisions are not a realistic concern.
  const filtered = packages.filter((p) => basename(resolve(p)) !== "plugin-pi");

  if (filtered.length === packages.length) {
    return { settingsPath, removed: false, dryRun: opts?.dryRun ?? false };
  }

  if (opts?.dryRun) {
    return { settingsPath, removed: false, dryRun: true };
  }

  writeSettings(settingsPath, { ...settings, packages: filtered });
  return { settingsPath, removed: true, dryRun: false };
}
