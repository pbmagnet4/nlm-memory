/**
 * Ollama preflight helpers for `nlm setup`.
 *
 * Three cases handled:
 *   1. Ollama not installed     → install it
 *   2. Ollama installed, server not responding → start the server
 *   3. Embedding model missing  → pull it
 *
 * Platform support:
 *   macOS  — brew install / Ollama.app / brew services / open -a
 *   Linux  — official install.sh / systemctl / detached spawn
 *   Windows — winget install / detached spawn
 */
export declare const EMBEDDING_MODEL = "nomic-embed-text";
export interface OllamaResult {
    readonly ok: boolean;
    readonly output: string;
}
export declare function ollamaBinaryAvailable(): boolean;
/** Returns true if the Ollama server is accepting API requests. */
export declare function ollamaServerRunning(): boolean;
/** Returns true if nomic-embed-text is present in `ollama list`. */
export declare function embeddingModelPresent(): boolean;
/**
 * Install Ollama using the best available method for the current platform.
 * Returns { ok: false } if no automated path exists — caller shows manual instructions.
 */
export declare function installOllama(): OllamaResult;
/**
 * Start the Ollama server in the background.
 *
 * Platform preference:
 *   macOS + brew    → brew services start ollama
 *   macOS + app     → open -a Ollama
 *   Linux + systemd → systemctl start ollama (needs sudo; falls back to spawn)
 *   All others      → detached spawn of `ollama serve`
 */
export declare function startOllamaServer(): OllamaResult;
/**
 * Poll until the Ollama server is accepting requests or maxAttempts is reached.
 * Returns true if the server came up, false on timeout.
 */
export declare function waitForOllamaServer(maxAttempts?: number, intervalMs?: number): Promise<boolean>;
/**
 * Pull the embedding model. Blocks until complete (~1–3 min on first run, a
 * few seconds on subsequent runs). The caller shows a spinner during this call.
 */
export declare function pullEmbeddingModel(): OllamaResult;
export type ClassifierChoice = "deepseek" | "ollama-offline";
/**
 * Write classifier config to ~/.nlm/.env. Merges into the existing file —
 * only the lines we manage are updated; anything the user added by hand stays.
 */
export declare function writeClassifierConfig(choice: ClassifierChoice, apiKey?: string): void;
