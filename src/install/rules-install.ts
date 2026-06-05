/**
 * Per-runtime rules-file install adapters for MCP-only runtimes
 * (Cursor, Windsurf, OpenCode). Each function resolves the runtime's
 * canonical rules-file path on this OS and delegates to upsertRulesBlock /
 * removeRulesBlock for the actual write.
 *
 * Cursor is workspace-scoped only — current Cursor builds don't expose a
 * documented file path for user-global rules (the UI manages them). The
 * cwd is the install target; pass cwd= to override (tests + multi-project
 * scripting).
 *
 * Windsurf and OpenCode both have user-global file paths and install there.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  CURSOR_MDC_FRONTMATTER,
  deleteDedicatedRulesFile,
  removeRulesBlock,
  type RemoveResult,
  upsertRulesBlock,
  type UpsertResult,
  writeDedicatedRulesFile,
} from "./rules-content.js";

const CURSOR_RULE_RELATIVE = join(".cursor", "rules", "nlm-recall.mdc");
const WINDSURF_GLOBAL = join(".codeium", "windsurf", "memories", "global_rules.md");
const OPENCODE_GLOBAL = join(".config", "opencode", "AGENTS.md");

export interface InstallRulesOptions {
  /** Working directory for Cursor (workspace-scoped). Ignored elsewhere. */
  readonly cwd?: string;
  /** Home directory override for tests. */
  readonly home?: string;
}

export function cursorRulesPath(opts: InstallRulesOptions = {}): string {
  return join(opts.cwd ?? process.cwd(), CURSOR_RULE_RELATIVE);
}

export function windsurfRulesPath(opts: InstallRulesOptions = {}): string {
  return join(opts.home ?? homedir(), WINDSURF_GLOBAL);
}

export function opencodeRulesPath(opts: InstallRulesOptions = {}): string {
  return join(opts.home ?? homedir(), OPENCODE_GLOBAL);
}

export function installCursorRules(opts: InstallRulesOptions = {}): UpsertResult {
  // Cursor MDC: dedicated single-purpose file with YAML frontmatter at top.
  return writeDedicatedRulesFile(cursorRulesPath(opts), CURSOR_MDC_FRONTMATTER);
}

export function uninstallCursorRules(opts: InstallRulesOptions = {}): RemoveResult {
  return deleteDedicatedRulesFile(cursorRulesPath(opts));
}

export function installWindsurfRules(opts: InstallRulesOptions = {}): UpsertResult {
  return upsertRulesBlock(windsurfRulesPath(opts));
}

export function uninstallWindsurfRules(opts: InstallRulesOptions = {}): RemoveResult {
  return removeRulesBlock(windsurfRulesPath(opts));
}

export function installOpencodeRules(opts: InstallRulesOptions = {}): UpsertResult {
  return upsertRulesBlock(opencodeRulesPath(opts));
}

export function uninstallOpencodeRules(opts: InstallRulesOptions = {}): RemoveResult {
  return removeRulesBlock(opencodeRulesPath(opts));
}

/**
 * Human-readable summary for the connect command's stdout. Returns null when
 * nothing changed.
 */
export function describeUpsert(runtime: string, result: UpsertResult): string {
  switch (result.action) {
    case "created":
      return `nlm rules nudge created: ${result.targetPath} (${runtime})`;
    case "appended":
      return `nlm rules nudge appended to existing file: ${result.targetPath} (${runtime})`;
    case "replaced":
      return `nlm rules nudge updated in place: ${result.targetPath} (${runtime})`;
    case "unchanged":
      return `nlm rules nudge already current: ${result.targetPath} (${runtime})`;
  }
}

export function describeRemove(runtime: string, result: RemoveResult): string {
  switch (result.action) {
    case "removed":
      return `nlm rules nudge removed from ${result.targetPath} (${runtime})`;
    case "deleted-file":
      return `nlm rules nudge file deleted: ${result.targetPath} (${runtime})`;
    case "not-present":
      return `no nlm rules nudge found in ${result.targetPath} (${runtime})`;
    case "no-file":
      return `no rules file at ${result.targetPath} (${runtime})`;
  }
}

// Silence unused-import warning for platform; reserved for future
// Windows/Linux divergence in path resolution (currently uniform via $HOME).
void platform;
