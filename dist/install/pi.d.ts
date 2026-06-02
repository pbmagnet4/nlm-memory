/**
 * `nlm connect pi` / `nlm disconnect pi` — registers the bundled pi extension
 * in pi.dev's settings so the prompt-recall hook auto-loads on every pi start.
 *
 * Pi has no plugin install directory analogous to Hermes' ~/.hermes/plugins/.
 * Instead, pi reads `packages: [...]` from ~/.pi/agent/settings.json and
 * resolves each entry on startup — a path to a directory containing a
 * `package.json` with a `pi.extensions` field loads the declared modules.
 *
 * The plugin-pi/ directory inside this npm package ships exactly that shape:
 * `package.json` declares `pi.extensions: ["scripts/nlm-extension.mjs"]`.
 *
 * `connect` appends the absolute path to that directory into `packages` if
 * not already present. `disconnect` strips any matching entry.
 *
 * Idempotent. Format-preserving where possible — pi's settings.json is pure
 * JSON with no comments, so JSON.parse / JSON.stringify with 2-space indent
 * matches pi's own write convention.
 */
export interface ConnectPiOptions {
    /** Absolute path to the plugin-pi/ directory shipped with nlm-memory. */
    readonly pluginDir: string;
    readonly dryRun?: boolean;
}
export interface ConnectPiReport {
    readonly settingsPath: string;
    readonly pluginDir: string;
    readonly alreadyPresent: boolean;
    readonly written: boolean;
    readonly dryRun: boolean;
}
export interface DisconnectPiReport {
    readonly settingsPath: string;
    readonly removed: boolean;
    readonly dryRun: boolean;
}
export declare function piAgentDir(): string;
export declare function piSettingsPath(): string;
export declare function connectPi(opts: ConnectPiOptions): ConnectPiReport;
export declare function disconnectPi(opts?: {
    dryRun?: boolean;
}): DisconnectPiReport;
