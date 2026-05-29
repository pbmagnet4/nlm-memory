/**
 * `nlm connect hermes` / `nlm disconnect hermes` — writes the nlm-memory
 * MCP server entry into ~/.hermes/config.yaml.
 *
 * Uses yaml's Document API (parseDocument / doc.setIn / doc.toString) to
 * preserve any comments the user has written in their config file. Round-
 * tripping through parse+stringify would silently destroy comments.
 */
export interface ConnectHermesOptions {
    readonly nlmBinPath: string;
    readonly nodeExecPath: string;
    readonly dryRun?: boolean;
}
export interface ConnectHermesReport {
    readonly configPath: string;
    readonly alreadyPresent: boolean;
    readonly written: boolean;
    readonly dryRun: boolean;
}
export interface DisconnectHermesReport {
    readonly configPath: string;
    readonly removed: boolean;
    readonly dryRun: boolean;
}
export declare function hermesConfigPath(): string;
export declare function connectHermes(opts: ConnectHermesOptions): ConnectHermesReport;
export declare function disconnectHermes(opts?: {
    dryRun?: boolean;
}): DisconnectHermesReport;
