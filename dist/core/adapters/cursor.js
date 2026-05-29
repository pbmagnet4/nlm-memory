/**
 * CursorAdapter — reads Cursor AI sessions across all three storage formats.
 *
 * ## Storage locations (macOS, Linux analogues use ~/.config/)
 *
 *   Global DB  ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *     Table: cursorDiskKV
 *     Keys:  composerData:<composerId>   — session metadata + conversation
 *            bubbleId:<composerId>:<id>  — individual messages (separate storage)
 *
 *   Workspace DBs  ~/Library/.../Cursor/User/workspaceStorage/<hash>/state.vscdb
 *     Table: ItemTable
 *     Key:   composer.composerData       — allComposers[] (pre-global-migration)
 *     Key:   workbench.panel.aichat.view.aichat.chatdata  — chat tabs (all versions)
 *
 * ## Session ID prefixes
 *
 *   cr_  — global cursorDiskKV composer (current, v1.x+)
 *   crw_ — workspace ItemTable composer.composerData (v0.43–v1.x)
 *   crc_ — workspace ItemTable chat tab (v0.x–v1.x)
 *
 * ## Options
 *
 *   dbPath — path to globalStorage/state.vscdb
 *            (workspace DBs are derived from dbPath's parent directory)
 *   Env override: NLM_CURSOR_DB_PATH
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";
// ── Path helpers ──────────────────────────────────────────────────────────────
export function defaultDbPath() {
    if (process.env["NLM_CURSOR_DB_PATH"])
        return process.env["NLM_CURSOR_DB_PATH"];
    const home = homedir();
    if (process.platform === "darwin") {
        return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    }
    return join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}
function workspaceStorageDir(globalDbPath) {
    // globalStorage/state.vscdb → User/ → User/workspaceStorage/
    return join(dirname(dirname(globalDbPath)), "workspaceStorage");
}
function listWorkspaceDbs(globalDbPath) {
    const wsDir = workspaceStorageDir(globalDbPath);
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
function extractComposerTurns(bubbles) {
    const turns = [];
    for (const b of bubbles) {
        const type = b.type;
        if (type !== 1 && type !== 2)
            continue;
        const text = (b.text ?? "").trim();
        if (!text)
            continue;
        turns.push({ role: type === 1 ? "user" : "assistant", text });
    }
    return turns;
}
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
function extractSeparateBubbles(db, composerId) {
    const rows = db
        .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC`)
        .all(`bubbleId:${composerId}:%`);
    const turns = [];
    for (const row of rows) {
        if (!row.value)
            continue;
        try {
            const b = JSON.parse(row.value);
            const type = b.type;
            if (type !== 1 && type !== 2)
                continue;
            const text = (b.text ?? "").trim();
            if (text)
                turns.push({ role: type === 1 ? "user" : "assistant", text });
        }
        catch { /* skip malformed */ }
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
function buildChunk(id, runtime, runtimeSessionId, sourcePath, turns, startedAt, endedAt, label) {
    const text = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
    return {
        id,
        runtime,
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
// ── Workspace parsers ─────────────────────────────────────────────────────────
/** Workspace ItemTable: composer.composerData → allComposers[]. */
function discoverWorkspaceComposers(db) {
    try {
        const row = db
            .prepare(`SELECT value FROM ItemTable WHERE key = ?`)
            .get("composer.composerData");
        if (!row?.value)
            return [];
        const data = JSON.parse(row.value);
        const composers = data.allComposers ?? [];
        return composers
            .filter((c) => c.composerId)
            .map((c) => `crw_${c.composerId}`);
    }
    catch {
        return [];
    }
}
/** Workspace ItemTable: workbench.panel.aichat.view.aichat.chatdata → tabs[]. */
function discoverWorkspaceChatTabs(db, since) {
    try {
        const row = db
            .prepare(`SELECT value FROM ItemTable WHERE key = ?`)
            .get("workbench.panel.aichat.view.aichat.chatdata");
        if (!row?.value)
            return [];
        const data = JSON.parse(row.value);
        const tabs = data.tabs ?? [];
        const cutoff = since?.getTime();
        return tabs
            .filter((t) => {
            if (!t.tabId)
                return false;
            if (!(t.bubbles && t.bubbles.length > 0))
                return false;
            if (cutoff !== undefined) {
                const ts = t.lastSendTime;
                // Only skip if we have a real non-zero timestamp that's before the cutoff
                if (ts !== undefined && ts > 0 && ts < cutoff)
                    return false;
            }
            return true;
        })
            .map((t) => `crc_${t.tabId}`);
    }
    catch {
        return [];
    }
}
function parseWorkspaceComposer(db, composerId, dbPath) {
    try {
        const row = db
            .prepare(`SELECT value FROM ItemTable WHERE key = ?`)
            .get("composer.composerData");
        if (!row?.value)
            return null;
        const data = JSON.parse(row.value);
        const meta = (data.allComposers ?? []).find((c) => c.composerId === composerId);
        if (!meta)
            return null;
        const inlineTurns = extractComposerTurns(meta.conversation ?? []);
        if (inlineTurns.length === 0)
            return null;
        const startedAt = normalizeTimestamp(meta.createdAt ?? meta.lastUpdatedAt ?? "");
        const endedAt = normalizeTimestamp(meta.lastUpdatedAt ?? meta.createdAt ?? "");
        const label = meta.name?.trim() ? meta.name.trim().slice(0, 80) : provisionalLabel(inlineTurns);
        return buildChunk(safeSessionId("crw", composerId), "cursor/1.0", composerId, `${dbPath}::composer:${composerId}`, inlineTurns, startedAt, endedAt, label);
    }
    catch {
        return null;
    }
}
function parseWorkspaceChatTab(db, tabId, dbPath) {
    try {
        const row = db
            .prepare(`SELECT value FROM ItemTable WHERE key = ?`)
            .get("workbench.panel.aichat.view.aichat.chatdata");
        if (!row?.value)
            return null;
        const data = JSON.parse(row.value);
        const tab = (data.tabs ?? []).find((t) => t.tabId === tabId);
        if (!tab)
            return null;
        const turns = extractChatTurns(tab.bubbles ?? []);
        if (turns.length === 0)
            return null;
        const endedAtMs = tab.lastSendTime ?? 0;
        const endedAt = endedAtMs > 0 ? new Date(endedAtMs).toISOString() : "";
        const label = tab.chatTitle?.trim()
            ? tab.chatTitle.trim().slice(0, 80)
            : provisionalLabel(turns);
        return buildChunk(safeSessionId("crc", tabId), "cursor/1.0", tabId, `${dbPath}::chat:${tabId}`, turns, endedAt, // no creation timestamp; use endedAt for both
        endedAt, label);
    }
    catch {
        return null;
    }
}
// ── Adapter ───────────────────────────────────────────────────────────────────
export class CursorAdapter {
    name = "cursor";
    runtimeVersion = "cursor/1.0";
    transcriptKind = "cursor-sqlite";
    dbPath;
    constructor(opts = {}) {
        this.dbPath = opts.dbPath ?? defaultDbPath();
    }
    detect() {
        if (existsSync(this.dbPath)) {
            return { adapterName: this.name, enabled: true, path: this.dbPath, hint: null };
        }
        return {
            adapterName: this.name,
            enabled: false,
            path: null,
            hint: "Cursor global DB not found — install Cursor or set NLM_CURSOR_DB_PATH.",
        };
    }
    async discover(options) {
        const ids = [];
        const seen = new Set();
        const add = (id) => { if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        } };
        // ── Global DB (current format, v1.x+) ─────────────────────────────────
        if (existsSync(this.dbPath)) {
            let db;
            try {
                db = new Database(this.dbPath, { readonly: true });
                const hasKV = db
                    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'`)
                    .get();
                if (hasKV) {
                    const rows = db
                        .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC`)
                        .all("composerData:%");
                    const cutoff = options?.since?.getTime();
                    for (const row of rows) {
                        if (!row.value)
                            continue;
                        try {
                            const meta = JSON.parse(row.value);
                            if (cutoff !== undefined) {
                                const ts = meta.lastUpdatedAt ?? meta.createdAt;
                                if (ts !== undefined && ts !== null) {
                                    const normalized = normalizeTimestamp(ts);
                                    if (normalized && Date.parse(normalized) < cutoff)
                                        continue;
                                }
                            }
                            const composerId = meta.composerId ?? row.key.split(":").slice(1).join(":");
                            if (composerId)
                                add(`cr_${composerId}`);
                        }
                        catch { /* skip */ }
                    }
                }
            }
            catch { /* skip inaccessible DB */ }
            finally {
                db?.close();
            }
        }
        // ── Workspace DBs (pre-migration sessions) ────────────────────────────
        for (const wsDbPath of listWorkspaceDbs(this.dbPath)) {
            let db;
            try {
                db = new Database(wsDbPath, { readonly: true });
                const hasItemTable = db
                    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'`)
                    .get();
                if (!hasItemTable)
                    continue;
                for (const id of discoverWorkspaceComposers(db))
                    add(id);
                for (const id of discoverWorkspaceChatTabs(db, options?.since))
                    add(id);
            }
            catch { /* skip */ }
            finally {
                db?.close();
            }
        }
        return ids;
    }
    async parseSession(id) {
        if (id.startsWith("crw_")) {
            return this._parseWorkspaceComposer(id.slice("crw_".length));
        }
        if (id.startsWith("crc_")) {
            return this._parseWorkspaceChatTab(id.slice("crc_".length));
        }
        // cr_ prefix (or legacy unprefixed IDs)
        const composerId = id.startsWith("cr_") ? id.slice("cr_".length) : id;
        return this._parseGlobalComposer(composerId);
    }
    _parseGlobalComposer(composerId) {
        if (!existsSync(this.dbPath))
            return null;
        let db;
        try {
            db = new Database(this.dbPath, { readonly: true });
            const row = db
                .prepare(`SELECT key, value FROM cursorDiskKV WHERE key = ?`)
                .get(`composerData:${composerId}`);
            if (!row?.value)
                return null;
            const meta = JSON.parse(row.value);
            const inlineTurns = extractComposerTurns(meta.conversation ?? []);
            const turns = inlineTurns.length > 0
                ? inlineTurns
                : extractSeparateBubbles(db, composerId);
            if (turns.length === 0)
                return null;
            const startedAt = normalizeTimestamp(meta.createdAt ?? meta.lastUpdatedAt ?? "");
            const endedAt = normalizeTimestamp(meta.lastUpdatedAt ?? meta.createdAt ?? "");
            const label = meta.name?.trim()
                ? meta.name.trim().slice(0, 80)
                : provisionalLabel(turns);
            return buildChunk(safeSessionId("cr", composerId), this.runtimeVersion, composerId, `${this.dbPath}::${composerId}`, turns, startedAt, endedAt, label);
        }
        catch {
            return null;
        }
        finally {
            db?.close();
        }
    }
    _parseWorkspaceComposer(composerId) {
        for (const wsDbPath of listWorkspaceDbs(this.dbPath)) {
            let db;
            try {
                db = new Database(wsDbPath, { readonly: true });
                const chunk = parseWorkspaceComposer(db, composerId, wsDbPath);
                if (chunk)
                    return chunk;
            }
            catch { /* next */ }
            finally {
                db?.close();
            }
        }
        return null;
    }
    _parseWorkspaceChatTab(tabId) {
        for (const wsDbPath of listWorkspaceDbs(this.dbPath)) {
            let db;
            try {
                db = new Database(wsDbPath, { readonly: true });
                const chunk = parseWorkspaceChatTab(db, tabId, wsDbPath);
                if (chunk)
                    return chunk;
            }
            catch { /* next */ }
            finally {
                db?.close();
            }
        }
        return null;
    }
}
//# sourceMappingURL=cursor.js.map