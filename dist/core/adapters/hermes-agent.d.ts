/**
 * NousResearch Hermes Agent adapter.
 *
 * Reads the Hermes Agent SQLite state database at:
 *   ~/.hermes/state.db  (customizable via HERMES_HOME)
 *
 * Schema (schema version 11):
 *   sessions — id, title, source, started_at (Unix float), ended_at (Unix float)
 *   messages — id, session_id, role, content, tool_calls (JSON), tool_name, timestamp (Unix float)
 *
 * Roles extracted: user, assistant (with optional tool_calls), tool (result).
 * Roles skipped: system.
 *
 * Tool calls in assistant messages are summarized as [tool_use: <name>].
 * Tool result messages are summarized as [tool_result: <name>: <preview>].
 *
 * This adapter is distinct from HermesAdapter (src/core/adapters/hermes.ts),
 * which reads Whtnxt Hermes WebUI session JSON files from ~/.hermes/sessions/.
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface HermesAgentAdapterOptions {
    readonly dbPath?: string;
}
export declare function defaultDbPath(): string;
export declare class HermesAgentAdapter implements TranscriptAdapter {
    readonly name = "hermes-agent";
    readonly runtimeVersion = "hermes-agent/1.0";
    readonly transcriptKind = "hermes-agent-sqlite";
    private readonly dbPath;
    constructor(opts?: HermesAgentAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(sessionId: string): Promise<SessionChunk | null>;
}
