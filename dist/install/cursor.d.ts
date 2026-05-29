/**
 * `nlm connect cursor` / `nlm disconnect cursor` — registers or removes the
 * Cursor adapter source in the NLM source registry.
 *
 * Unlike plugin-based runtimes (hermes-agent, codex), Cursor needs no file
 * to be installed. NLM reads Cursor's existing state.vscdb directly. The
 * connect operation only registers the source row so the daemon scans it.
 */
import type { SourceRegistry } from "../core/sources/source-registry.js";
export interface ConnectCursorOptions {
    readonly dbPath?: string;
    readonly dryRun?: boolean;
}
export interface ConnectCursorReport {
    readonly adapterDbPath: string;
    readonly adapterExists: boolean;
    readonly action: "created" | "enabled" | "already-active" | "dry-run";
}
export interface DisconnectCursorReport {
    readonly action: "disabled" | "not-found" | "dry-run";
}
export declare function connectCursor(registry: SourceRegistry, opts?: ConnectCursorOptions): ConnectCursorReport;
export declare function disconnectCursor(registry: SourceRegistry, opts?: {
    dryRun?: boolean;
}): DisconnectCursorReport;
