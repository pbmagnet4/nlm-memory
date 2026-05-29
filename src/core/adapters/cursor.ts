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
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";

export interface CursorAdapterOptions {
  readonly dbPath?: string;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface KVRow {
  readonly key: string;
  readonly value: string | null;
}

interface ItemRow {
  readonly value: string | null;
}

interface ComposerMeta {
  readonly composerId?: string;
  readonly name?: string;
  readonly createdAt?: unknown;
  readonly lastUpdatedAt?: unknown;
  readonly conversation?: BubbleData[];
}

interface BubbleData {
  readonly type?: number;
  readonly text?: string;
}

interface ChatTab {
  readonly tabId?: string;
  readonly chatTitle?: string;
  readonly lastSendTime?: number;
  readonly bubbles?: ChatBubble[];
}

interface ChatBubble {
  readonly type?: "user" | "ai" | string;
  readonly text?: string;
  readonly rawText?: string;
}

type Turn = { role: "user" | "assistant"; text: string };

// ── Path helpers ──────────────────────────────────────────────────────────────

export function defaultDbPath(): string {
  if (process.env["NLM_CURSOR_DB_PATH"]) return process.env["NLM_CURSOR_DB_PATH"];
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  return join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}

function workspaceStorageDir(globalDbPath: string): string {
  // globalStorage/state.vscdb → User/ → User/workspaceStorage/
  return join(dirname(dirname(globalDbPath)), "workspaceStorage");
}

function listWorkspaceDbs(globalDbPath: string): string[] {
  const wsDir = workspaceStorageDir(globalDbPath);
  if (!existsSync(wsDir)) return [];
  try {
    return readdirSync(wsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(wsDir, e.name, "state.vscdb"))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

// ── Turn extraction ───────────────────────────────────────────────────────────

function extractComposerTurns(bubbles: BubbleData[]): Turn[] {
  const turns: Turn[] = [];
  for (const b of bubbles) {
    const type = b.type;
    if (type !== 1 && type !== 2) continue;
    const text = (b.text ?? "").trim();
    if (!text) continue;
    turns.push({ role: type === 1 ? "user" : "assistant", text });
  }
  return turns;
}

function extractChatTurns(bubbles: ChatBubble[]): Turn[] {
  const turns: Turn[] = [];
  for (const b of bubbles) {
    const text = (b.rawText ?? b.text ?? "").trim();
    if (!text) continue;
    turns.push({ role: b.type === "user" ? "user" : "assistant", text });
  }
  return turns;
}

function extractSeparateBubbles(db: Database.Database, composerId: string): Turn[] {
  const rows = db
    .prepare<[string], KVRow>(
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC`,
    )
    .all(`bubbleId:${composerId}:%`);
  const turns: Turn[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    try {
      const b = JSON.parse(row.value) as BubbleData;
      const type = b.type;
      if (type !== 1 && type !== 2) continue;
      const text = (b.text ?? "").trim();
      if (text) turns.push({ role: type === 1 ? "user" : "assistant", text });
    } catch { /* skip malformed */ }
  }
  return turns;
}

function provisionalLabel(turns: ReadonlyArray<Turn>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const first = t.text.split("\n", 1)[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  return "Untitled session";
}

function buildChunk(
  id: string,
  runtime: string,
  runtimeSessionId: string,
  sourcePath: string,
  turns: Turn[],
  startedAt: string,
  endedAt: string,
  label: string,
): SessionChunk {
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
function discoverWorkspaceComposers(db: Database.Database): string[] {
  try {
    const row = db
      .prepare<[string], ItemRow>(`SELECT value FROM ItemTable WHERE key = ?`)
      .get("composer.composerData");
    if (!row?.value) return [];
    const data = JSON.parse(row.value) as { allComposers?: ComposerMeta[] };
    const composers = data.allComposers ?? [];
    return composers
      .filter((c) => c.composerId)
      .map((c) => `crw_${c.composerId}`);
  } catch {
    return [];
  }
}

/** Workspace ItemTable: workbench.panel.aichat.view.aichat.chatdata → tabs[]. */
function discoverWorkspaceChatTabs(db: Database.Database, since?: Date): string[] {
  try {
    const row = db
      .prepare<[string], ItemRow>(
        `SELECT value FROM ItemTable WHERE key = ?`,
      )
      .get("workbench.panel.aichat.view.aichat.chatdata");
    if (!row?.value) return [];
    const data = JSON.parse(row.value) as { tabs?: ChatTab[] };
    const tabs = data.tabs ?? [];
    const cutoff = since?.getTime();
    return tabs
      .filter((t) => {
        if (!t.tabId) return false;
        if (!(t.bubbles && t.bubbles.length > 0)) return false;
        if (cutoff !== undefined) {
          const ts = t.lastSendTime;
          // Only skip if we have a real non-zero timestamp that's before the cutoff
          if (ts !== undefined && ts > 0 && ts < cutoff) return false;
        }
        return true;
      })
      .map((t) => `crc_${t.tabId}`);
  } catch {
    return [];
  }
}

function parseWorkspaceComposer(
  db: Database.Database,
  composerId: string,
  dbPath: string,
): SessionChunk | null {
  try {
    const row = db
      .prepare<[string], ItemRow>(`SELECT value FROM ItemTable WHERE key = ?`)
      .get("composer.composerData");
    if (!row?.value) return null;
    const data = JSON.parse(row.value) as { allComposers?: ComposerMeta[] };
    const meta = (data.allComposers ?? []).find((c) => c.composerId === composerId);
    if (!meta) return null;

    const inlineTurns = extractComposerTurns(meta.conversation ?? []);
    if (inlineTurns.length === 0) return null;

    const startedAt = normalizeTimestamp(meta.createdAt ?? meta.lastUpdatedAt ?? "");
    const endedAt = normalizeTimestamp(meta.lastUpdatedAt ?? meta.createdAt ?? "");
    const label = meta.name?.trim() ? meta.name.trim().slice(0, 80) : provisionalLabel(inlineTurns);

    return buildChunk(
      safeSessionId("crw", composerId),
      "cursor/1.0",
      composerId,
      `${dbPath}::composer:${composerId}`,
      inlineTurns,
      startedAt,
      endedAt,
      label,
    );
  } catch {
    return null;
  }
}

function parseWorkspaceChatTab(
  db: Database.Database,
  tabId: string,
  dbPath: string,
): SessionChunk | null {
  try {
    const row = db
      .prepare<[string], ItemRow>(
        `SELECT value FROM ItemTable WHERE key = ?`,
      )
      .get("workbench.panel.aichat.view.aichat.chatdata");
    if (!row?.value) return null;
    const data = JSON.parse(row.value) as { tabs?: ChatTab[] };
    const tab = (data.tabs ?? []).find((t) => t.tabId === tabId);
    if (!tab) return null;

    const turns = extractChatTurns(tab.bubbles ?? []);
    if (turns.length === 0) return null;

    const endedAtMs = tab.lastSendTime ?? 0;
    const endedAt = endedAtMs > 0 ? new Date(endedAtMs).toISOString() : "";
    const label = tab.chatTitle?.trim()
      ? tab.chatTitle.trim().slice(0, 80)
      : provisionalLabel(turns);

    return buildChunk(
      safeSessionId("crc", tabId),
      "cursor/1.0",
      tabId,
      `${dbPath}::chat:${tabId}`,
      turns,
      endedAt, // no creation timestamp; use endedAt for both
      endedAt,
      label,
    );
  } catch {
    return null;
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class CursorAdapter implements TranscriptAdapter {
  readonly name = "cursor";
  readonly runtimeVersion = "cursor/1.0";
  readonly transcriptKind = "cursor-sqlite";

  private readonly dbPath: string;

  constructor(opts: CursorAdapterOptions = {}) {
    this.dbPath = opts.dbPath ?? defaultDbPath();
  }

  detect(): DetectionResult {
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

  async discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>> {
    const ids: string[] = [];
    const seen = new Set<string>();

    const add = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };

    // ── Global DB (current format, v1.x+) ─────────────────────────────────
    if (existsSync(this.dbPath)) {
      let db: Database.Database | undefined;
      try {
        db = new Database(this.dbPath, { readonly: true });
        const hasKV = db
          .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'`)
          .get();

        if (hasKV) {
          const rows = db
            .prepare<[string], KVRow>(
              `SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC`,
            )
            .all("composerData:%");

          const cutoff = options?.since?.getTime();
          for (const row of rows) {
            if (!row.value) continue;
            try {
              const meta = JSON.parse(row.value) as ComposerMeta;
              if (cutoff !== undefined) {
                const ts = meta.lastUpdatedAt ?? meta.createdAt;
                if (ts !== undefined && ts !== null) {
                  const normalized = normalizeTimestamp(ts);
                  if (normalized && Date.parse(normalized) < cutoff) continue;
                }
              }
              const composerId = meta.composerId ?? row.key.split(":").slice(1).join(":");
              if (composerId) add(`cr_${composerId}`);
            } catch { /* skip */ }
          }
        }
      } catch { /* skip inaccessible DB */ } finally {
        db?.close();
      }
    }

    // ── Workspace DBs (pre-migration sessions) ────────────────────────────
    for (const wsDbPath of listWorkspaceDbs(this.dbPath)) {
      let db: Database.Database | undefined;
      try {
        db = new Database(wsDbPath, { readonly: true });
        const hasItemTable = db
          .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'`)
          .get();
        if (!hasItemTable) continue;

        for (const id of discoverWorkspaceComposers(db)) add(id);
        for (const id of discoverWorkspaceChatTabs(db, options?.since)) add(id);
      } catch { /* skip */ } finally {
        db?.close();
      }
    }

    return ids;
  }

  async parseSession(id: string): Promise<SessionChunk | null> {
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

  private _parseGlobalComposer(composerId: string): SessionChunk | null {
    if (!existsSync(this.dbPath)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
      const row = db
        .prepare<[string], KVRow>(`SELECT key, value FROM cursorDiskKV WHERE key = ?`)
        .get(`composerData:${composerId}`);
      if (!row?.value) return null;

      const meta = JSON.parse(row.value) as ComposerMeta;
      const inlineTurns = extractComposerTurns(meta.conversation ?? []);
      const turns = inlineTurns.length > 0
        ? inlineTurns
        : extractSeparateBubbles(db, composerId);
      if (turns.length === 0) return null;

      const startedAt = normalizeTimestamp(meta.createdAt ?? meta.lastUpdatedAt ?? "");
      const endedAt = normalizeTimestamp(meta.lastUpdatedAt ?? meta.createdAt ?? "");
      const label = meta.name?.trim()
        ? meta.name.trim().slice(0, 80)
        : provisionalLabel(turns);

      return buildChunk(
        safeSessionId("cr", composerId),
        this.runtimeVersion,
        composerId,
        `${this.dbPath}::${composerId}`,
        turns,
        startedAt,
        endedAt,
        label,
      );
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  private _parseWorkspaceComposer(composerId: string): SessionChunk | null {
    for (const wsDbPath of listWorkspaceDbs(this.dbPath)) {
      let db: Database.Database | undefined;
      try {
        db = new Database(wsDbPath, { readonly: true });
        const chunk = parseWorkspaceComposer(db, composerId, wsDbPath);
        if (chunk) return chunk;
      } catch { /* next */ } finally {
        db?.close();
      }
    }
    return null;
  }

  private _parseWorkspaceChatTab(tabId: string): SessionChunk | null {
    for (const wsDbPath of listWorkspaceDbs(this.dbPath)) {
      let db: Database.Database | undefined;
      try {
        db = new Database(wsDbPath, { readonly: true });
        const chunk = parseWorkspaceChatTab(db, tabId, wsDbPath);
        if (chunk) return chunk;
      } catch { /* next */ } finally {
        db?.close();
      }
    }
    return null;
  }
}
