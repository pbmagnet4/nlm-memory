/**
 * WindsurfAdapter — reads Windsurf (Codeium Cascade) sessions.
 *
 * ## Storage locations (macOS; Linux uses ~/.config/)
 *
 *   Workspace DBs  ~/Library/Application Support/Windsurf/User/workspaceStorage/<hash>/state.vscdb
 *     Table: ItemTable
 *     Key:   workbench.panel.aichat.view.aichat.chatdata  — chat tabs
 *     Bubble role: type 'user' → user, type 'ai' → assistant
 *
 *   Global DB  ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
 *     Table: cursorDiskKV (if present) — composerData:*, agentData:*, flowData:*
 *     Table: ItemTable (fallback)     — keys matching %agent%, %flow%, %cascade%
 *     Conversation format: type 1/2 (user/assistant) or role: user/assistant
 *
 * ## Session ID prefixes
 *
 *   ws_  — workspace chat tab (ItemTable chatdata)
 *   wsg_ — global DB agent/flow session (cursorDiskKV or ItemTable)
 *
 * ## pathOrUrl in source registry
 *   Path to the Windsurf User directory. The adapter discovers:
 *     <userDir>/workspaceStorage/<hash>/state.vscdb  (workspace)
 *     <userDir>/globalStorage/state.vscdb             (global)
 *
 * Env override: NLM_WINDSURF_USER_DIR
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";
const CHAT_KEY = "workbench.panel.aichat.view.aichat.chatdata";
// ── Path helpers ──────────────────────────────────────────────────────────────
export function defaultUserDir() {
    if (process.env["NLM_WINDSURF_USER_DIR"])
        return process.env["NLM_WINDSURF_USER_DIR"];
    const home = homedir();
    if (process.platform === "darwin") {
        return join(home, "Library/Application Support/Windsurf/User");
    }
    return join(home, ".config/Windsurf/User");
}
function workspaceStorageDir(userDir) {
    return join(userDir, "workspaceStorage");
}
function globalDbPath(userDir) {
    return join(userDir, "globalStorage", "state.vscdb");
}
function listWorkspaceDbs(userDir) {
    const wsDir = workspaceStorageDir(userDir);
    if (!existsSync(wsDir))
        return [];
    try {
        return readdirSync(wsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(wsDir, e.name, "state.vscdb"))
            .filter((p) => existsSync(p));
    }
    catch {
        return [];
    }
}
// ── Turn extraction ───────────────────────────────────────────────────────────
function extractChatTurns(bubbles) {
    const turns = [];
    for (const b of bubbles) {
        const text = (b.rawText ?? b.text ?? "").trim();
        if (!text)
            continue;
        turns.push({ role: b.type === "user" ? "user" : "assistant", text });
    }
    return turns;
}
function extractAgentTurns(bubbles) {
    const turns = [];
    for (const b of bubbles) {
        const text = (b.text ?? "").trim();
        if (!text)
            continue;
        // Accept numeric type (1/2) or string role
        const isUser = b.type === 1 || b.role === "user";
        const isAssistant = b.type === 2 || b.role === "assistant";
        if (!isUser && !isAssistant)
            continue;
        turns.push({ role: isUser ? "user" : "assistant", text });
    }
    return turns;
}
function provisionalLabel(turns) {
    for (const t of turns) {
        if (t.role !== "user")
            continue;
        const first = t.text.split("\n", 1)[0]?.trim();
        if (first)
            return first.slice(0, 80);
    }
    return "Untitled session";
}
function buildChunk(id, runtimeSessionId, sourcePath, turns, startedAt, endedAt, label) {
    const text = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
    return {
        id,
        runtime: "windsurf/1.0",
        runtimeSessionId,
        sourcePath,
        startedAt,
        endedAt,
        durationMin: durationMinutes(startedAt, endedAt),
        turnCount: turns.length,
        byteRange: [0, Buffer.byteLength(text, "utf8")],
        projectDir: "",
        gitBranch: "",
        text,
        label,
    };
}
// ── Workspace chat helpers ────────────────────────────────────────────────────
function parseTabsFromDb(dbPath) {
    let db;
    try {
        db = new Database(dbPath, { readonly: true });
        const row = db
            .prepare(`SELECT key, value FROM ItemTable WHERE key = ?`)
            .get(CHAT_KEY);
        if (!row?.value)
            return [];
        const data = JSON.parse(row.value);
        return Array.isArray(data.tabs) ? data.tabs : [];
    }
    catch {
        return [];
    }
    finally {
        db?.close();
    }
}
function parseGlobalSessions(globalPath) {
    if (!existsSync(globalPath))
        return [];
    let db;
    const results = [];
    try {
        db = new Database(globalPath, { readonly: true });
        const tables = db
            .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
            .all()
            .map((r) => r.name);
        if (tables.includes("cursorDiskKV")) {
            const rows = db
                .prepare(`SELECT key, value FROM cursorDiskKV
           WHERE key LIKE 'composerData:%' OR key LIKE 'agentData:%' OR key LIKE 'flowData:%'
           ORDER BY rowid ASC`)
                .all();
            for (const row of rows) {
                if (!row.value)
                    continue;
                try {
                    const meta = JSON.parse(row.value);
                    const rawId = meta.composerId ?? row.key.split(":").slice(1).join(":");
                    if (rawId)
                        results.push({ id: rawId, meta, dbPath: globalPath });
                }
                catch { /* skip */ }
            }
        }
        else if (tables.includes("ItemTable")) {
            // Fallback: probe for agent/flow/cascade keys
            const rows = db
                .prepare(`SELECT key, value FROM ItemTable
           WHERE key LIKE '%agent%' OR key LIKE '%flow%' OR key LIKE '%cascade%'`)
                .all();
            for (const row of rows) {
                if (!row.value)
                    continue;
                try {
                    const data = JSON.parse(row.value);
                    if (typeof data !== "object" || !data)
                        continue;
                    // Accept any object with a conversation array
                    const conv = data.conversation;
                    if (!Array.isArray(conv) || conv.length === 0)
                        continue;
                    const id = data.composerId ?? row.key;
                    results.push({ id, meta: data, dbPath: globalPath });
                }
                catch { /* skip */ }
            }
        }
    }
    catch { /* inaccessible */ }
    finally {
        db?.close();
    }
    return results;
}
// ── Adapter ───────────────────────────────────────────────────────────────────
export class WindsurfAdapter {
    name = "windsurf";
    runtimeVersion = "windsurf/1.0";
    transcriptKind = "windsurf-sqlite";
    userDir;
    constructor(opts = {}) {
        this.userDir = opts.userDir ?? defaultUserDir();
    }
    detect() {
        if (existsSync(this.userDir)) {
            return { adapterName: this.name, enabled: true, path: this.userDir, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Windsurf User directory not found — install Windsurf or set NLM_WINDSURF_USER_DIR.",
        };
    }
    async discover(options) {
        const seen = new Set();
        const ids = [];
        const add = (id) => { if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        } };
        const cutoff = options?.since?.getTime();
        // ── Workspace chat tabs ───────────────────────────────────────────────
        for (const dbPath of listWorkspaceDbs(this.userDir)) {
            for (const tab of parseTabsFromDb(dbPath)) {
                if (!tab.tabId)
                    continue;
                if (!(tab.bubbles && tab.bubbles.length > 0))
                    continue;
                if (cutoff !== undefined) {
                    const ts = tab.lastSendTime;
                    // Only skip when we have a real non-zero timestamp older than the cutoff.
                    // Missing (undefined) or zero timestamps are treated as "unknown age" — include.
                    if (ts !== undefined && ts > 0 && ts < cutoff)
                        continue;
                }
                add(`ws_${tab.tabId}`);
            }
        }
        // ── Global agent/flow sessions ────────────────────────────────────────
        for (const gs of parseGlobalSessions(globalDbPath(this.userDir))) {
            if (cutoff !== undefined) {
                const ts = gs.meta.lastUpdatedAt ?? gs.meta.createdAt;
                if (ts !== undefined && ts !== null) {
                    const normalized = normalizeTimestamp(ts);
                    if (normalized && Date.parse(normalized) < cutoff)
                        continue;
                }
            }
            add(`wsg_${gs.id}`);
        }
        return ids;
    }
    async parseSession(id) {
        if (id.startsWith("wsg_")) {
            return this._parseGlobalSession(id.slice("wsg_".length));
        }
        // ws_ prefix or legacy plain tabId
        const tabId = id.startsWith("ws_") ? id.slice("ws_".length) : id;
        return this._parseWorkspaceChatTab(tabId);
    }
    _parseWorkspaceChatTab(tabId) {
        for (const dbPath of listWorkspaceDbs(this.userDir)) {
            const tabs = parseTabsFromDb(dbPath);
            const tab = tabs.find((t) => t.tabId === tabId);
            if (!tab)
                continue;
            const turns = extractChatTurns(tab.bubbles ?? []);
            if (turns.length === 0)
                return null;
            const endedAtMs = tab.lastSendTime ?? 0;
            const endedAt = endedAtMs > 0 ? new Date(endedAtMs).toISOString() : "";
            const label = tab.chatTitle?.trim()
                ? tab.chatTitle.trim().slice(0, 80)
                : provisionalLabel(turns);
            return buildChunk(safeSessionId("ws", tabId), tabId, `${dbPath}::${tabId}`, turns, endedAt, endedAt, label);
        }
        return null;
    }
    _parseGlobalSession(rawId) {
        for (const gs of parseGlobalSessions(globalDbPath(this.userDir))) {
            if (gs.id !== rawId)
                continue;
            const turns = extractAgentTurns(gs.meta.conversation ?? []);
            if (turns.length === 0)
                return null;
            const startedAt = normalizeTimestamp(gs.meta.createdAt ?? gs.meta.lastUpdatedAt ?? "");
            const endedAt = normalizeTimestamp(gs.meta.lastUpdatedAt ?? gs.meta.createdAt ?? "");
            const label = gs.meta.name?.trim()
                ? gs.meta.name.trim().slice(0, 80)
                : provisionalLabel(turns);
            return buildChunk(safeSessionId("wsg", rawId), rawId, `${gs.dbPath}::${rawId}`, turns, startedAt, endedAt, label);
        }
        return null;
    }
}
//# sourceMappingURL=windsurf.js.map