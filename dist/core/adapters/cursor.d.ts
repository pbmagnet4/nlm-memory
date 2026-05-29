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
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface CursorAdapterOptions {
    readonly dbPath?: string;
}
export declare function defaultDbPath(): string;
export declare class CursorAdapter implements TranscriptAdapter {
    readonly name = "cursor";
    readonly runtimeVersion = "cursor/1.0";
    readonly transcriptKind = "cursor-sqlite";
    private readonly dbPath;
    constructor(opts?: CursorAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(id: string): Promise<SessionChunk | null>;
    private _parseGlobalComposer;
    private _parseWorkspaceComposer;
    private _parseWorkspaceChatTab;
}
