/**
 * `nlm connect claude-code` / `nlm disconnect claude-code` — writes the
 * nlm-memory MCP server block into ~/.mcp.json and removes it on disconnect.
 *
 * ~/.mcp.json is the global MCP config file that Claude Code reads on
 * startup. We merge our entry into the existing mcpServers object rather
 * than replacing the file, so other MCP servers the user has configured are
 * preserved.
 */
import type { ClaudeHookEvent } from "../core/hook/claude-settings.js";
export interface ConnectClaudeCodeOptions {
    readonly nlmBinPath: string;
    readonly nodeExecPath: string;
    readonly dryRun?: boolean;
}
export interface ConnectClaudeCodeReport {
    readonly mcpConfigPath: string;
    readonly alreadyPresent: boolean;
    readonly written: boolean;
    readonly dryRun: boolean;
}
export interface DisconnectClaudeCodeReport {
    readonly mcpConfigPath: string;
    readonly removed: boolean;
    readonly dryRun: boolean;
}
export declare function mcpConfigPath(): string;
export declare function connectClaudeCode(opts: ConnectClaudeCodeOptions): ConnectClaudeCodeReport;
export interface HookSpec {
    readonly event: ClaudeHookEvent;
    readonly script: string;
    readonly label: string;
}
export interface HookInstallOptions {
    readonly nodeExecPath: string;
    readonly hooks: ReadonlyArray<HookSpec>;
    readonly settingsPath: string;
    readonly hookLogPath: string;
    readonly addHook: (path: string, command: string, event?: ClaudeHookEvent) => void;
    readonly removeHook: (path: string, event?: ClaudeHookEvent | "*") => void;
    readonly buildHookCommand: (nodeExec: string, script: string, mode: "shadow" | "live") => string;
    readonly smokeTestHookCommand: (command: string, logPath: string) => {
        ok: boolean;
        reason?: string;
        stderr?: string;
    };
}
export interface HookInstallResult {
    readonly ok: boolean;
    readonly count: number;
    readonly failedLabel?: string;
    readonly errorMessage?: string;
}
export declare function installClaudeCodeHooks(opts: HookInstallOptions): HookInstallResult;
export declare function disconnectClaudeCode(opts?: {
    dryRun?: boolean;
}): DisconnectClaudeCodeReport;
