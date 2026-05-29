/**
 * `nlm connect windsurf` / `nlm disconnect windsurf` — registers or removes the
 * Windsurf adapter source in the NLM source registry.
 *
 * NLM reads Windsurf's existing workspace SQLite DBs directly from the User
 * directory. The connect operation only registers the source row so the daemon
 * scans it.
 */
import type { SourceRegistry } from "../core/sources/source-registry.js";
export interface ConnectWindsurfOptions {
    readonly userDir?: string;
    readonly dryRun?: boolean;
}
export interface ConnectWindsurfReport {
    readonly userDir: string;
    readonly dirExists: boolean;
    readonly action: "created" | "enabled" | "already-active" | "dry-run";
}
export interface DisconnectWindsurfReport {
    readonly action: "disabled" | "not-found" | "dry-run";
}
export declare function connectWindsurf(registry: SourceRegistry, opts?: ConnectWindsurfOptions): ConnectWindsurfReport;
export declare function disconnectWindsurf(registry: SourceRegistry, opts?: {
    dryRun?: boolean;
}): DisconnectWindsurfReport;
