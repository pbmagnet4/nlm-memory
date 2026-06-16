/**
 * `nlm connect codex` / `nlm disconnect codex` — installs nlm-memory as a
 * Codex CLI plugin via the marketplace mechanism.
 *
 * Two distribution surfaces:
 *
 * 1. The plugin path (default). Registers a Codex marketplace pointing at
 *    pbmagnet4/nlm-memory and installs the `nlm-memory` plugin from it.
 *    Codex prompts for hook trust on first invocation; once trusted,
 *    UserPromptSubmit + Stop hooks fire, and the .mcp.json wires the
 *    `nlm-memory` MCP server alongside.
 *
 * 2. The legacy hooks.json fallback (--with-hooks). For Codex Desktop
 *    builds where openai/codex#16430 blocks plugin-local hook dispatch,
 *    additionally writes absolute paths into ~/.codex/hooks.json so the
 *    hooks fire via the project-local code path. MCP still comes through
 *    the plugin's .mcp.json.
 *
 * Marketplace + plugin add are delegated to the `codex` binary rather than
 * mutating ~/.codex/config.toml directly — the binary owns the trust state
 * machine and the snapshot fetch flow, and writing TOML by hand would race
 * against codex's own writes. The legacy hooks.json IS authored directly
 * because it's a project-local file the binary doesn't manage.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_SOURCE = "pbmagnet4/nlm-memory";
const PLUGIN_NAME = "nlm-memory";
// Marketplace name is derived from the source's basename by codex when
// `codex plugin marketplace add <source>` runs without a --name flag. For
// owner/repo this is the repo name; for a local path it's the directory
// basename. Both resolve to "nlm-memory" in our case.
const MARKETPLACE_NAME = "nlm-memory";

// Marker substring identifying entries this CLI owns in ~/.codex/hooks.json
// so disconnect can strip only our entries and leave anything the user
// added by hand intact.
const LEGACY_HOOK_MARKER = "/plugin/scripts/";

// Sentinels bracketing the [mcp_servers.nlm-memory] block we manage in
// ~/.codex/config.toml. Sentinel-bracketed regions are removed atomically
// on disconnect and replaced atomically on connect — no TOML parser
// required, no risk of mangling user-authored entries above or below.
const MCP_SENTINEL_BEGIN = "# >>> nlm-memory (managed by nlm connect codex)";
const MCP_SENTINEL_END = "# <<< nlm-memory";

export interface ConnectOptions {
  readonly source?: string;
  readonly withHooks?: boolean;
  readonly dryRun?: boolean;
}

export interface DisconnectOptions {
  readonly withHooks?: boolean;
  readonly dryRun?: boolean;
}

export interface CodexCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCodex(args: ReadonlyArray<string>): CodexCommandResult {
  const result = spawnSync("codex", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function codexBinaryAvailable(): boolean {
  const r = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

export function codexHooksPath(): string {
  return process.env["NLM_CODEX_HOOKS"] ?? join(homedir(), ".codex", "hooks.json");
}

export function codexConfigPath(): string {
  return process.env["NLM_CODEX_CONFIG"] ?? join(homedir(), ".codex", "config.toml");
}

/**
 * Idempotently insert (or update) the [mcp_servers.nlm-memory] block in
 * ~/.codex/config.toml. The block is bracketed by sentinel comments so a
 * later disconnect can strip the exact region without touching anything
 * else. MCP wiring is universal infrastructure — every runtime gets its
 * MCP server registered in its native format. Codex's is TOML in
 * config.toml; we write that directly rather than relying on the plugin
 * system's .mcp.json indirection (which we can't currently verify works
 * outside the upstream plugin pipeline).
 */
export type McpWriteResult = "written" | "skipped-existing";

export function writeMcpServerToConfig(configPath: string): McpWriteResult {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = stripSentinelBlock(existing);

  // An un-sentineled [mcp_servers.nlm-memory] table — hand-authored, or left by
  // a pre-rename install — already wires the server. Appending our managed
  // block would create a duplicate TOML key and break codex's parser, so leave
  // the user's block untouched (and persist the sentinel-strip if we did one).
  if (hasNlmMcpTable(next)) {
    if (next !== existing) writeFileSync(configPath, next, "utf8");
    return "skipped-existing";
  }

  const block = `${MCP_SENTINEL_BEGIN}\n[mcp_servers.nlm-memory]\ncommand = "nlm"\nargs = ["mcp"]\n${MCP_SENTINEL_END}\n`;
  const sep = next.length > 0 && !next.endsWith("\n\n") ? (next.endsWith("\n") ? "\n" : "\n\n") : "";
  writeFileSync(configPath, next + sep + block, "utf8");
  return "written";
}

/** True if the config already declares an `[mcp_servers.nlm-memory]` table. */
export function hasNlmMcpTable(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === "[mcp_servers.nlm-memory]");
}

export function removeMcpServerFromConfig(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const existing = readFileSync(configPath, "utf8");
  const next = stripSentinelBlock(existing);
  if (next === existing) return false;
  writeFileSync(configPath, next, "utf8");
  return true;
}

/**
 * Remove our sentinel-bracketed region from a config.toml string. Tolerant
 * of an unterminated begin sentinel (treats it as a no-op rather than
 * eating the rest of the file) so a corrupted config never amplifies.
 */
function stripSentinelBlock(content: string): string {
  const beginIdx = content.indexOf(MCP_SENTINEL_BEGIN);
  if (beginIdx < 0) return content;
  const endMarker = MCP_SENTINEL_END;
  const endIdx = content.indexOf(endMarker, beginIdx + MCP_SENTINEL_BEGIN.length);
  if (endIdx < 0) return content; // unterminated — refuse to mutate
  let cutEnd = endIdx + endMarker.length;
  if (content[cutEnd] === "\n") cutEnd += 1;
  let cutStart = beginIdx;
  // Also eat the single leading newline that connected this block to the
  // prior section, so repeated connect/disconnect cycles don't accrete blanks.
  if (cutStart > 0 && content[cutStart - 1] === "\n") cutStart -= 1;
  return content.slice(0, cutStart) + content.slice(cutEnd);
}

interface CodexHookEntry {
  readonly type: string;
  readonly command: string;
  readonly statusMessage?: string;
}

interface CodexHookGroup {
  readonly matcher?: string;
  readonly hooks: CodexHookEntry[];
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
  [k: string]: unknown;
}

function readHooksFile(path: string): CodexHooksFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CodexHooksFile;
  } catch {
    // Treat a malformed hooks.json as empty rather than silently
    // overwriting the user's intent. The legacy writer below merges
    // entries — if the file is broken we'd rather error than clobber.
    throw new Error(`~/.codex/hooks.json is not valid JSON: ${path}`);
  }
}

function writeHooksFile(path: string, content: CodexHooksFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content, null, 2) + "\n", "utf8");
}

/**
 * Append our two hook entries into ~/.codex/hooks.json without touching any
 * pre-existing entries. Idempotent: a second call replaces our entries
 * rather than duplicating them (matched by LEGACY_HOOK_MARKER substring).
 */
export function writeLegacyHooks(
  pluginScriptsDir: string,
  hooksPath: string,
): void {
  const file = readHooksFile(hooksPath);
  const hooks = (file.hooks ??= {});

  const ourEntries: Record<string, CodexHookGroup> = {
    SessionStart: {
      hooks: [
        {
          type: "command",
          command: `NLM_HOOK_RUNTIME=codex node "${join(pluginScriptsDir, "session-start-hook.mjs")}"`,
          statusMessage: "nlm-memory: cold-start recall",
        },
      ],
    },
    UserPromptSubmit: {
      hooks: [
        {
          type: "command",
          command: `NLM_HOOK_RUNTIME=codex node "${join(pluginScriptsDir, "prompt-recall-hook.mjs")}"`,
          statusMessage: "nlm-memory: recalling prior sessions",
        },
      ],
    },
    Stop: {
      hooks: [
        {
          type: "command",
          command: `NLM_HOOK_RUNTIME=codex node "${join(pluginScriptsDir, "stop-hook.mjs")}"`,
        },
      ],
    },
  };

  for (const [event, ourGroup] of Object.entries(ourEntries)) {
    const existing = hooks[event] ?? [];
    const kept = existing.filter(
      (group) =>
        !group.hooks.some((h) => h.command.includes(LEGACY_HOOK_MARKER)),
    );
    kept.push(ourGroup);
    hooks[event] = kept;
  }

  writeHooksFile(hooksPath, file);
}

export function removeLegacyHooks(hooksPath: string): boolean {
  if (!existsSync(hooksPath)) return false;
  const file = readHooksFile(hooksPath);
  const hooks = file.hooks;
  if (!hooks) return false;

  let mutated = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.filter(
      (group) =>
        !group.hooks.some((h) => h.command.includes(LEGACY_HOOK_MARKER)),
    );
    if (kept.length !== groups.length) mutated = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  if (mutated) writeHooksFile(hooksPath, file);
  return mutated;
}

export interface ConnectReport {
  readonly source: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly marketplaceAdd: CodexCommandResult | null;
  readonly pluginAdd: CodexCommandResult | null;
  readonly legacyHooksWritten: string | null;
  readonly mcpServerWritten: string | null;
  /** A pre-existing un-sentineled MCP table was found and left untouched. */
  readonly mcpServerAlreadyPresent: boolean;
  readonly dryRun: boolean;
}

export function connectCodex(
  opts: ConnectOptions,
  pluginScriptsDir: string,
): ConnectReport {
  const source = opts.source ?? DEFAULT_SOURCE;
  const marketplaceName = MARKETPLACE_NAME;
  const pluginName = PLUGIN_NAME;

  if (opts.dryRun) {
    return {
      source,
      marketplaceName,
      pluginName,
      marketplaceAdd: null,
      pluginAdd: null,
      legacyHooksWritten: opts.withHooks ? codexHooksPath() : null,
      mcpServerWritten: codexConfigPath(),
      mcpServerAlreadyPresent: false,
      dryRun: true,
    };
  }

  // Marketplace add is idempotent at the codex layer; a re-add of the same
  // source no-ops or refreshes the snapshot depending on the binary.
  const marketplaceAdd = runCodex(["plugin", "marketplace", "add", source]);
  // plugin add is the action that triggers the trust-prompt path on first
  // run. We let codex's exit code propagate to the caller.
  const pluginAdd = runCodex([
    "plugin",
    "add",
    `${pluginName}@${marketplaceName}`,
  ]);

  let legacyHooksWritten: string | null = null;
  if (opts.withHooks) {
    const hooksPath = codexHooksPath();
    writeLegacyHooks(pluginScriptsDir, hooksPath);
    legacyHooksWritten = hooksPath;
  }

  // MCP wiring is always written directly to config.toml — it's the
  // universal infrastructure that should work whether or not the plugin
  // system honors the bundled .mcp.json indirection.
  const configPath = codexConfigPath();
  const mcpResult = writeMcpServerToConfig(configPath);

  return {
    source,
    marketplaceName,
    pluginName,
    marketplaceAdd,
    pluginAdd,
    legacyHooksWritten,
    mcpServerWritten: mcpResult === "written" ? configPath : null,
    mcpServerAlreadyPresent: mcpResult === "skipped-existing",
    dryRun: false,
  };
}

export interface DisconnectReport {
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly pluginRemove: CodexCommandResult | null;
  readonly marketplaceRemove: CodexCommandResult | null;
  readonly legacyHooksRemoved: boolean;
  readonly mcpServerRemoved: boolean;
  readonly dryRun: boolean;
}

export function disconnectCodex(opts: DisconnectOptions): DisconnectReport {
  if (opts.dryRun) {
    return {
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      pluginRemove: null,
      marketplaceRemove: null,
      legacyHooksRemoved: opts.withHooks ?? false,
      mcpServerRemoved: true,
      dryRun: true,
    };
  }

  const pluginRemove = runCodex([
    "plugin",
    "remove",
    `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
  ]);
  const marketplaceRemove = runCodex([
    "plugin",
    "marketplace",
    "remove",
    MARKETPLACE_NAME,
  ]);

  let legacyHooksRemoved = false;
  if (opts.withHooks) {
    legacyHooksRemoved = removeLegacyHooks(codexHooksPath());
  }

  const mcpServerRemoved = removeMcpServerFromConfig(codexConfigPath());

  return {
    marketplaceName: MARKETPLACE_NAME,
    pluginName: PLUGIN_NAME,
    pluginRemove,
    marketplaceRemove,
    legacyHooksRemoved,
    mcpServerRemoved,
    dryRun: false,
  };
}

export function pluginScriptsDir(repoRoot: string): string {
  return resolve(repoRoot, "plugin", "scripts");
}

// Pre-rename marketplace name. Installs of 0.3.x and earlier registered the
// marketplace as "nlm-memory-ts", so their plugin id is "nlm-memory@nlm-memory-ts"
// and their hook-state keys carry the same suffix. `--repair` strips these.
const LEGACY_NAME = "nlm-memory-ts";
// The marketplace suffix is what uniquely identifies stale entries. Matching on
// it (rather than the bare name) avoids false-flagging a legitimate local
// project path like `[projects."…/nlm-memory-ts"]`.
const LEGACY_SUFFIX = `@${LEGACY_NAME}`;

/** True for a config.toml table header that belongs to the pre-rename install. */
function isStaleTableHeader(trimmed: string): boolean {
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  // [plugins."nlm-memory@nlm-memory-ts"], [hooks.state."…@nlm-memory-ts:…"]
  if (trimmed.includes(LEGACY_SUFFIX)) return true;
  // legacy MCP table, if a pre-rename version wrote one
  return trimmed === `[mcp_servers.${LEGACY_NAME}]` || trimmed === `[mcp_servers."${LEGACY_NAME}"]`;
}

/**
 * Remove pre-rename `nlm-memory-ts` tables from a config.toml string: the
 * `[plugins."nlm-memory@nlm-memory-ts"]` registration, its `[hooks.state.…]`
 * entries, and a legacy `[mcp_servers.nlm-memory-ts]` table if present — each up
 * to the next table header. A legitimate `[projects."…/nlm-memory-ts"]` path is
 * preserved (it lacks the `@nlm-memory-ts` marketplace suffix). Old managed
 * sentinel comments are dropped too. Pure — the caller owns IO.
 */
export function stripStaleCodexEntry(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inStaleTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if ((trimmed.startsWith("# >>>") || trimmed.startsWith("# <<<")) && trimmed.includes(LEGACY_NAME)) {
      continue; // our old managed sentinel comments
    }
    if (isStaleTableHeader(trimmed)) {
      inStaleTable = true;
      continue;
    }
    if (inStaleTable) {
      if (trimmed.startsWith("[")) inStaleTable = false; // next table — re-evaluate below
      else continue; // skip key=value / blank lines inside the stale table
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface RepairReport {
  readonly staleMcpRemovedFromConfig: boolean;
  readonly oldPluginRemove: CodexCommandResult | null;
  readonly oldMarketplaceRemove: CodexCommandResult | null;
  readonly connect: ConnectReport;
  readonly dryRun: boolean;
}

/**
 * Convert a stale pre-rename Codex install (nlm-memory-ts) into the current
 * pbmagnet4/nlm-memory wiring without hand-editing config.toml: strip the
 * legacy MCP table, best-effort remove the legacy plugin + marketplace from
 * codex's registry, then run the normal connect.
 */
export function repairCodex(opts: ConnectOptions, scriptsDir: string): RepairReport {
  const configPath = codexConfigPath();

  if (opts.dryRun) {
    const wouldStrip =
      existsSync(configPath) &&
      stripStaleCodexEntry(readFileSync(configPath, "utf8")) !== readFileSync(configPath, "utf8");
    return {
      staleMcpRemovedFromConfig: wouldStrip,
      oldPluginRemove: null,
      oldMarketplaceRemove: null,
      connect: connectCodex(opts, scriptsDir),
      dryRun: true,
    };
  }

  let staleMcpRemovedFromConfig = false;
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf8");
    const cleaned = stripStaleCodexEntry(existing);
    if (cleaned !== existing) {
      writeFileSync(configPath, cleaned, "utf8");
      staleMcpRemovedFromConfig = true;
    }
  }

  // Best-effort: the legacy entries may live only in config.toml, not in
  // codex's registry, so a non-zero exit here is not a repair failure. The
  // legacy plugin id is plugin "nlm-memory" from marketplace "nlm-memory-ts".
  const oldPluginRemove = runCodex(["plugin", "remove", `${PLUGIN_NAME}@${LEGACY_NAME}`]);
  const oldMarketplaceRemove = runCodex(["plugin", "marketplace", "remove", LEGACY_NAME]);

  const connect = connectCodex(opts, scriptsDir);

  return { staleMcpRemovedFromConfig, oldPluginRemove, oldMarketplaceRemove, connect, dryRun: false };
}
