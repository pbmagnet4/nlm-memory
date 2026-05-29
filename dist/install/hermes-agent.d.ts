/**
 * `nlm connect hermes-agent` / `nlm disconnect hermes-agent` — installs the
 * nlm-memory plugin into NousResearch Hermes Agent's plugin directory and
 * optionally enables it via the `hermes` binary.
 *
 * The plugin lives in plugin-hermes-agent/ at the repo root. `connect`
 * copies it to ~/.hermes/plugins/nlm-memory/ (flat layout, one category
 * level max per Hermes plugin discovery rules). `disconnect` removes that
 * directory.
 *
 * MCP server wiring (the [mcp_servers.nlm-memory] block in
 * ~/.hermes/config.yaml) is handled separately by `nlm connect hermes`.
 */
export interface ConnectHermesAgentOptions {
    readonly pluginSrcDir: string;
    readonly dryRun?: boolean;
    readonly enableViaCliIfAvailable?: boolean;
}
export interface ConnectHermesAgentReport {
    readonly destDir: string;
    readonly copied: boolean;
    readonly alreadyPresent: boolean;
    readonly enabledViaCli: boolean;
    readonly dryRun: boolean;
}
export interface DisconnectHermesAgentReport {
    readonly destDir: string;
    readonly removed: boolean;
    readonly dryRun: boolean;
}
export declare function hermesAgentPluginDir(): string;
export declare function connectHermesAgent(opts: ConnectHermesAgentOptions): ConnectHermesAgentReport;
export declare function disconnectHermesAgent(opts?: {
    dryRun?: boolean;
}): DisconnectHermesAgentReport;
