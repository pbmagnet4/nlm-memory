/**
 * Shared HTTP recall client for hook entrypoints (Claude Code script, pi extension).
 *
 * Keyword (FTS5) only — hybrid would round-trip through Ollama embedding
 * (~5s warm), too slow to block a user prompt.
 */
import type { RecallHitInput } from "../core/hook/select.js";
export declare const RECALL_LIMIT = 5;
export declare const RECALL_TIMEOUT_MS = 2000;
export declare function recallOverHttp(prompt: string): Promise<ReadonlyArray<RecallHitInput>>;
