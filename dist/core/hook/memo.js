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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function stateDir() {
    return process.env["NLM_HOOK_STATE_DIR"] ?? join(homedir(), ".nlm", "hook-state");
}
function memoPath(conversationId) {
    const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
    return join(stateDir(), `${safe}.json`);
}
export function loadSurfaced(conversationId) {
    try {
        const path = memoPath(conversationId);
        if (!existsSync(path))
            return new Set();
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(parsed))
            return new Set();
        return new Set(parsed.filter((x) => typeof x === "string"));
    }
    catch {
        return new Set();
    }
}
export function recordSurfaced(conversationId, ids) {
    try {
        const merged = loadSurfaced(conversationId);
        for (const id of ids)
            merged.add(id);
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(memoPath(conversationId), JSON.stringify([...merged]), "utf8");
    }
    catch {
        // Memo write failure must never break the hook.
    }
}
//# sourceMappingURL=memo.js.map