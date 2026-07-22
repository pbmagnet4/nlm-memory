/**
 * Shared scope stamping for inbound signals. Both transports that write
 * signals (POST /api/signal and the MCP report_outcome tool) call this, so
 * the rows they produce carry identical scope regardless of entry point.
 *
 * Precedence mirrors the original /api/signal behavior: an explicit
 * repo_path wins; otherwise a session-correlated signal inherits that
 * session's stamped scope. "global" is stored as NULL (signals never take
 * global scope). Flag off (NLM_SCOPE_STAMP unset) is a no-op.
 */

import { deriveScope } from "@core/scope/derive-scope.js";
import { loadAliasMap } from "@core/scope/alias-map.js";
import { scopeStampEnabled } from "@core/scope/stamp-flag.js";
import type { Signal } from "@shared/types.js";

export interface SessionScopeReader {
  getSessionScopeById(tenantId: string, id: string): Promise<string | null>;
}

export async function stampSignalScope(
  signal: Signal,
  tenantId: string,
  opts: {
    readonly repoPath?: string | null;
    readonly sessionScopeReader?: SessionScopeReader | undefined;
  },
): Promise<Signal> {
  if (!scopeStampEnabled()) return signal;
  let scope: string | null = null;
  if (opts.repoPath) {
    const derived = deriveScope(opts.repoPath, loadAliasMap());
    scope = derived === "global" ? null : derived;
  } else if (signal.sessionId && opts.sessionScopeReader) {
    const inherited = await opts.sessionScopeReader.getSessionScopeById(tenantId, signal.sessionId);
    scope = inherited === "global" ? null : inherited;
  }
  return { ...signal, scope };
}
