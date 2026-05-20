/**
 * Per-conversation dedup memo for the recall hook. One JSON file per
 * conversation holds the set of session ids already surfaced, so each is
 * surfaced at most once per conversation.
 *
 * State dir defaults to ~/.nlm/hook-state/, overridable via
 * NLM_HOOK_STATE_DIR (testability — mirrors query-log.ts).
 *
 * Every function is defensive: a missing or corrupt file yields an empty
 * memo, and a write failure is swallowed. The hook must never break on memo
 * I/O.
 */
export declare function loadSurfaced(conversationId: string): Set<string>;
export declare function recordSurfaced(conversationId: string, ids: ReadonlyArray<string>): void;
