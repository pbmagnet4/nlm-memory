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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
export const EMBEDDING_MODEL = "nomic-embed-text";
const OS = platform();
// ── Detection ─────────────────────────────────────────────────────────────
export function ollamaBinaryAvailable() {
    const r = spawnSync("ollama", ["--version"], { encoding: "utf8" });
    return r.status === 0;
}
/** Returns true if the Ollama server is accepting API requests. */
export function ollamaServerRunning() {
    const r = spawnSync("ollama", ["list"], { encoding: "utf8" });
    return r.status === 0;
}
/** Returns true if nomic-embed-text is present in `ollama list`. */
export function embeddingModelPresent() {
    const r = spawnSync("ollama", ["list"], { encoding: "utf8" });
    if (r.status !== 0)
        return false;
    return r.stdout.includes(EMBEDDING_MODEL);
}
function brewAvailable() {
    return spawnSync("brew", ["--version"], { encoding: "utf8" }).status === 0;
}
function ollamaAppInstalled() {
    return existsSync("/Applications/Ollama.app");
}
function wingetAvailable() {
    return spawnSync("winget", ["--version"], { encoding: "utf8", shell: true }).status === 0;
}
function systemctlAvailable() {
    return spawnSync("systemctl", ["--version"], { encoding: "utf8" }).status === 0;
}
// ── Install ───────────────────────────────────────────────────────────────
/**
 * Install Ollama using the best available method for the current platform.
 * Returns { ok: false } if no automated path exists — caller shows manual instructions.
 */
export function installOllama() {
    if (OS === "darwin") {
        if (brewAvailable()) {
            const r = spawnSync("brew", ["install", "ollama"], { encoding: "utf8" });
            return { ok: r.status === 0, output: (r.stdout + r.stderr).trim() };
        }
        return {
            ok: false,
            output: "Homebrew not found. Download Ollama from https://ollama.com/download and re-run setup.",
        };
    }
    if (OS === "linux") {
        // Runs: curl -fsSL https://ollama.com/install.sh | sh
        // The official Ollama installer — sets up the binary and a systemd service.
        // Requires sudo internally and may modify /etc/systemd/. The caller is
        // responsible for confirming this with the user before calling.
        const r = spawnSync("sh", ["-c", "curl -fsSL --proto '=https' https://ollama.com/install.sh | sh"], {
            encoding: "utf8",
            timeout: 120_000,
        });
        return { ok: r.status === 0, output: (r.stdout + r.stderr).trim() };
    }
    if (OS === "win32") {
        if (wingetAvailable()) {
            const r = spawnSync("winget", ["install", "Ollama.Ollama"], { encoding: "utf8", shell: true });
            return { ok: r.status === 0, output: (r.stdout + r.stderr).trim() };
        }
        return {
            ok: false,
            output: "Download Ollama from https://ollama.com/download and re-run setup.",
        };
    }
    return { ok: false, output: `Unsupported platform: ${OS}. Install from https://ollama.com/download.` };
}
// ── Server start ──────────────────────────────────────────────────────────
/**
 * Start the Ollama server in the background.
 *
 * Platform preference:
 *   macOS + brew    → brew services start ollama
 *   macOS + app     → open -a Ollama
 *   Linux + systemd → systemctl start ollama (needs sudo; falls back to spawn)
 *   All others      → detached spawn of `ollama serve`
 */
export function startOllamaServer() {
    if (OS === "darwin") {
        if (brewAvailable()) {
            const r = spawnSync("brew", ["services", "start", "ollama"], { encoding: "utf8" });
            if (r.status === 0)
                return { ok: true, output: "Started via brew services" };
        }
        if (ollamaAppInstalled()) {
            const r = spawnSync("open", ["-a", "Ollama"], { encoding: "utf8" });
            if (r.status === 0)
                return { ok: true, output: "Started via Ollama.app" };
        }
    }
    if (OS === "linux" && systemctlAvailable()) {
        // systemctl requires root — try without sudo first (works in user sessions
        // where the service is installed under the current user), fall through on failure.
        const r = spawnSync("systemctl", ["start", "ollama"], { encoding: "utf8" });
        if (r.status === 0)
            return { ok: true, output: "Started via systemctl" };
    }
    // Universal fallback: detach `ollama serve`.
    try {
        mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
        const child = spawn("ollama", ["serve"], {
            detached: true,
            stdio: "ignore",
        });
        child.unref();
        return { ok: true, output: `ollama serve started (pid ${child.pid})` };
    }
    catch (e) {
        return { ok: false, output: e instanceof Error ? e.message : String(e) };
    }
}
/**
 * Poll until the Ollama server is accepting requests or maxAttempts is reached.
 * Returns true if the server came up, false on timeout.
 */
export async function waitForOllamaServer(maxAttempts = 15, intervalMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
        if (ollamaServerRunning())
            return true;
        await new Promise((res) => setTimeout(res, intervalMs));
    }
    return false;
}
// ── Model pull ────────────────────────────────────────────────────────────
/**
 * Pull the embedding model. Blocks until complete (~1–3 min on first run, a
 * few seconds on subsequent runs). The caller shows a spinner during this call.
 */
export function pullEmbeddingModel() {
    // Give the server a moment to accept connections if it was just started.
    const r = spawnSync("ollama", ["pull", EMBEDDING_MODEL], { encoding: "utf8" });
    return { ok: r.status === 0, output: (r.stdout + r.stderr).trim() };
}
/**
 * Write classifier config to ~/.nlm/.env. Merges into the existing file —
 * only the lines we manage are updated; anything the user added by hand stays.
 */
export function writeClassifierConfig(choice, apiKey) {
    const envPath = join(homedir(), ".nlm", ".env");
    const nlmDir = join(homedir(), ".nlm");
    mkdirSync(nlmDir, { recursive: true, mode: 0o700 });
    chmodSync(nlmDir, 0o700);
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const kept = existing
        .split("\n")
        .filter((l) => !l.startsWith("DEEPSEEK_API_KEY=") && !l.startsWith("NLM_CLASSIFIER="))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const additions = [];
    if (choice === "deepseek" && apiKey) {
        // Strip newlines that clipboard paste can introduce.
        const sanitized = apiKey.replace(/[\r\n]/g, "").trim();
        additions.push(`DEEPSEEK_API_KEY=${sanitized}`);
    }
    if (choice === "ollama-offline")
        additions.push("NLM_CLASSIFIER=ollama");
    writeFileSync(envPath, [kept, ...additions].filter(Boolean).join("\n") + "\n", { mode: 0o600 });
    chmodSync(envPath, 0o600);
}
//# sourceMappingURL=ollama.js.map