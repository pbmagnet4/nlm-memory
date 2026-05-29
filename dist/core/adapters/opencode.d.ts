/**
 * OpenCode adapter.
 *
 * Reads the OpenCode SQLite database at:
 *   macOS: ~/Library/Application Support/opencode/opencode.db
 *   Linux: $XDG_DATA_HOME/opencode/opencode.db (default ~/.local/share/opencode/opencode.db)
 *
 * Unlike the JSONL-based adapters, OpenCode stores all sessions and messages
 * in a single SQLite file. `discover()` queries the sessions table and returns
 * session IDs (not file paths). `parseSession()` treats its string argument as
 * a session ID and reconstructs a SessionChunk from the messages and parts tables.
 *
 * Part types extracted:
 *   - text  (non-ignored): the conversational prose
 *   - tool  : summarized as [tool: <name>]
 *   All other part types (reasoning, step-start/finish, snapshot, patch,
 *   compaction, agent, retry, subtask) are structural and skipped.
 *
 * Format reference: verified against sst/opencode migration
 * 20260127222353_familiar_lady_ursula and session.sql.ts, 2026-05-28.
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface OpenCodeAdapterOptions {
    readonly dbPath?: string;
}
export declare function defaultDbPath(): string;
export declare class OpenCodeAdapter implements TranscriptAdapter {
    readonly name = "opencode";
    readonly runtimeVersion = "opencode/1.0";
    readonly transcriptKind = "opencode-sqlite";
    private readonly dbPath;
    constructor(opts?: OpenCodeAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(sessionId: string): Promise<SessionChunk | null>;
}
