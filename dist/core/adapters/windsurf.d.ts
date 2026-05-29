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
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface WindsurfAdapterOptions {
    readonly userDir?: string;
}
export declare function defaultUserDir(): string;
export declare class WindsurfAdapter implements TranscriptAdapter {
    readonly name = "windsurf";
    readonly runtimeVersion = "windsurf/1.0";
    readonly transcriptKind = "windsurf-sqlite";
    private readonly userDir;
    constructor(opts?: WindsurfAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(id: string): Promise<SessionChunk | null>;
    private _parseWorkspaceChatTab;
    private _parseGlobalSession;
}
