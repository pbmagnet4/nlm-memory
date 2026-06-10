/**
 * Shared rules-file content + idempotent writer for MCP-only runtimes
 * (Cursor, Windsurf, OpenCode) that lack a pre-prompt hook surface.
 *
 * Each runtime's install adapter calls upsertRulesBlock(targetPath) to write
 * RULES_BLOCK between sentinel markers. Re-running is idempotent: the
 * sentinel-bracketed region is replaced in place, leaving any unrelated
 * content in the target file intact. removeRulesBlock(targetPath) strips
 * only the bracketed region, preserving the rest.
 *
 * Conservative wording: the block instructs the agent to call
 * `recall_sessions` only on history-flavored prompts and to skip on
 * greenfield ones. This trades some recall fire-rate for less noise on
 * prompts where prior context isn't useful.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CURSOR_MDC_FRONTMATTER = `---
description: nlm-memory recall nudge — call recall_sessions on history-flavored prompts
alwaysApply: true
---
`;

export const START_SENTINEL = "<!-- nlm-memory:start -->";
export const END_SENTINEL = "<!-- nlm-memory:end -->";

export const RULES_BLOCK = `# nlm-memory recall

If the user references prior work, prior decisions, ongoing projects,
or asks "what did we figure out about X" / "where did we leave Y" /
"is Z still open" — call the \`recall_sessions\` MCP tool first with the
relevant keywords and treat its output as primary context. Cite returned
session IDs when you reference them.

Skip recall on greenfield prompts: drafting new content from scratch,
naming, brainstorming, or any forward-looking task with no plausible
prior context.
`;

function bracketed(): string {
  return `${START_SENTINEL}\n${RULES_BLOCK}${END_SENTINEL}\n`;
}

export type UpsertAction = "created" | "appended" | "replaced" | "unchanged";

export interface UpsertResult {
  readonly action: UpsertAction;
  readonly targetPath: string;
}

/**
 * Write the rules block to targetPath, creating the file (and parent dirs)
 * if needed. If a sentinel-bracketed block already exists, replace it in
 * place; otherwise append to the existing file. Returns the action taken.
 */
export function upsertRulesBlock(targetPath: string): UpsertResult {
  const block = bracketed();
  if (!existsSync(targetPath)) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, block, { mode: 0o644 });
    return { action: "created", targetPath };
  }

  const existing = readFileSync(targetPath, "utf8");
  const startIdx = existing.indexOf(START_SENTINEL);
  const endIdx = existing.indexOf(END_SENTINEL);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Existing managed block — replace in place. Capture content before
    // the start sentinel and after the end sentinel (plus its trailing
    // newline if present) to preserve surrounding user content.
    const before = existing.slice(0, startIdx);
    let afterStart = endIdx + END_SENTINEL.length;
    if (existing[afterStart] === "\n") afterStart += 1;
    const after = existing.slice(afterStart);
    const next = `${before}${block}${after}`;
    if (next === existing) return { action: "unchanged", targetPath };
    writeFileSync(targetPath, next, { mode: 0o644 });
    return { action: "replaced", targetPath };
  }

  // No managed block present — append. Ensure exactly one blank line
  // between any prior content and the new block.
  const trimmed = existing.replace(/\s*$/, "");
  const next = trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
  writeFileSync(targetPath, next, { mode: 0o644 });
  return { action: "appended", targetPath };
}

/**
 * Write a dedicated NLM-owned rules file (no sentinels — whole-file ownership).
 * Used for Cursor's .mdc rules where the file is single-purpose and benefits
 * from YAML frontmatter being at the very top with no other content.
 */
export function writeDedicatedRulesFile(targetPath: string, prefix = ""): UpsertResult {
  const next = `${prefix}${RULES_BLOCK}`;
  if (!existsSync(targetPath)) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, next, { mode: 0o644 });
    return { action: "created", targetPath };
  }
  const existing = readFileSync(targetPath, "utf8");
  if (existing === next) return { action: "unchanged", targetPath };
  writeFileSync(targetPath, next, { mode: 0o644 });
  return { action: "replaced", targetPath };
}

/**
 * Delete a dedicated NLM-owned rules file. No-op if the file doesn't exist.
 */
export function deleteDedicatedRulesFile(targetPath: string): RemoveResult {
  if (!existsSync(targetPath)) return { action: "no-file", targetPath };
  unlinkSync(targetPath);
  return { action: "deleted-file", targetPath };
}

export type RemoveAction = "removed" | "deleted-file" | "not-present" | "no-file";

export interface RemoveResult {
  readonly action: RemoveAction;
  readonly targetPath: string;
}

/**
 * Strip the sentinel-bracketed block from targetPath. If the file would be
 * empty (or whitespace-only) after removal, delete the file. If the file
 * doesn't exist or doesn't contain the block, no-op.
 */
export function removeRulesBlock(targetPath: string): RemoveResult {
  if (!existsSync(targetPath)) return { action: "no-file", targetPath };
  const existing = readFileSync(targetPath, "utf8");
  const startIdx = existing.indexOf(START_SENTINEL);
  const endIdx = existing.indexOf(END_SENTINEL);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { action: "not-present", targetPath };
  }

  const before = existing.slice(0, startIdx).replace(/\s*$/, "");
  let afterStart = endIdx + END_SENTINEL.length;
  if (existing[afterStart] === "\n") afterStart += 1;
  const after = existing.slice(afterStart).replace(/^\s*/, "");

  let next: string;
  if (before.length === 0 && after.length === 0) {
    unlinkSync(targetPath);
    return { action: "deleted-file", targetPath };
  } else if (before.length === 0) {
    next = `${after}\n`.replace(/\n+$/, "\n");
  } else if (after.length === 0) {
    next = `${before}\n`;
  } else {
    next = `${before}\n\n${after}\n`.replace(/\n+$/, "\n");
  }

  writeFileSync(targetPath, next, { mode: 0o644 });
  return { action: "removed", targetPath };
}
