/**
 * `nlm setup` — interactive first-run wizard.
 *
 * Step order:
 *   1. Select runtimes
 *   2. Ollama preflight (install → start server → pull embedding model)
 *   3. Classifier API key
 *   4. DB migrations
 *   5. Daemon (LaunchAgent on macOS / systemd hint on Linux / Task Scheduler hint on Windows)
 *   6. Per-runtime MCP + hook wiring
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { cancel, confirm, intro, isCancel, log, multiselect, outro, password, select, spinner, } from "@clack/prompts";
import { connectClaudeCode } from "./claude-code.js";
import { connectHermes } from "./hermes.js";
import { codexBinaryAvailable, connectCodex, pluginScriptsDir } from "./codex.js";
import { defaultDbPath as openCodeDefaultDbPath } from "../core/adapters/opencode.js";
import { EMBEDDING_MODEL, embeddingModelPresent, installOllama, ollamaBinaryAvailable, ollamaServerRunning, pullEmbeddingModel, startOllamaServer, waitForOllamaServer, writeClassifierConfig, } from "./ollama.js";
import { installClaudeCodeHooks } from "./claude-code.js";
const OS = platform();
function detectRuntimes() {
    const claudeProjectsPath = process.env["NLM_CLAUDE_PROJECTS_PATH"]
        ?? join(homedir(), ".claude", "projects");
    const hermesPath = process.env["NLM_HERMES_SESSIONS_PATH"]
        ?? join(homedir(), ".hermes", "sessions");
    const piPath = process.env["PI_SESSIONS_PATH"]
        ?? join(homedir(), ".pi", "agent", "sessions");
    const openCodeDb = openCodeDefaultDbPath();
    return [
        {
            id: "claude-code",
            label: "Claude Code",
            hint: existsSync(claudeProjectsPath) ? "detected" : "not found",
            detected: existsSync(claudeProjectsPath),
        },
        {
            id: "codex",
            label: "Codex (OpenAI)",
            hint: codexBinaryAvailable() ? "detected" : "not found — install: npm i -g @openai/codex",
            detected: codexBinaryAvailable(),
        },
        {
            id: "opencode",
            label: "OpenCode (sst)",
            hint: existsSync(openCodeDb) ? "detected" : "not found",
            detected: existsSync(openCodeDb),
        },
        {
            id: "hermes",
            label: "Hermes",
            hint: existsSync(hermesPath) ? "detected" : "not found",
            detected: existsSync(hermesPath),
        },
        {
            id: "pi",
            label: "pi.dev",
            hint: existsSync(piPath) ? "detected" : "not found",
            detected: existsSync(piPath),
        },
    ];
}
export async function runSetup(opts) {
    intro("NLM Memory — first-run setup");
    // ── Step 1: runtime selection ─────────────────────────────────────────
    const runtimes = detectRuntimes();
    const detectedIds = runtimes.filter((r) => r.detected).map((r) => r.id);
    const selected = await multiselect({
        message: "Which AI coding runtimes do you use?",
        options: runtimes.map((r) => ({ value: r.id, label: r.label, hint: r.hint })),
        initialValues: detectedIds,
        required: false,
    });
    if (isCancel(selected)) {
        cancel("Setup cancelled.");
        process.exit(0);
    }
    const chosen = selected;
    // ── Step 2: Ollama preflight ──────────────────────────────────────────
    if (!ollamaBinaryAvailable()) {
        const installMsg = OS === "linux"
            ? "Ollama not found. Install now? (runs the official install.sh as current user — see https://ollama.com/install.sh)"
            : "Ollama not found. Install it now? (required for memory indexing)";
        const doInstall = await confirm({ message: installMsg });
        if (isCancel(doInstall)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        if (doInstall) {
            const is = spinner();
            is.start("Installing Ollama");
            const result = installOllama();
            if (result.ok) {
                is.stop("Ollama installed");
            }
            else {
                is.stop("Ollama install failed");
                log.warn(result.output);
                log.warn("Install Ollama manually from https://ollama.com/download, then re-run `nlm setup`.");
            }
        }
        else {
            log.warn("Skipping Ollama install — memory indexing won't work until Ollama is running with nomic-embed-text.");
        }
    }
    // Ensure server is running before attempting pull.
    if (ollamaBinaryAvailable() && !ollamaServerRunning()) {
        const ss = spinner();
        ss.start("Starting Ollama server");
        const result = startOllamaServer();
        if (result.ok) {
            ss.start("Waiting for Ollama server to accept connections");
            const ready = await waitForOllamaServer(15, 1000);
            if (ready) {
                ss.stop("Ollama server ready");
            }
            else {
                ss.stop("Ollama server started but not responding yet");
                log.warn("If the model pull fails, wait a moment and run `ollama pull nomic-embed-text` manually.");
            }
        }
        else {
            ss.stop("Could not start Ollama server automatically");
            log.warn(`Start it manually with \`ollama serve\`, then re-run \`nlm setup\`. (${result.output})`);
        }
    }
    if (ollamaBinaryAvailable() && !embeddingModelPresent()) {
        const doPull = await confirm({ message: `Pull the ${EMBEDDING_MODEL} embedding model now? (~274 MB, required for semantic recall)` });
        if (isCancel(doPull)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        if (doPull) {
            const ps = spinner();
            ps.start(`Pulling ${EMBEDDING_MODEL} (this may take a few minutes)`);
            const result = pullEmbeddingModel();
            if (result.ok) {
                ps.stop(`${EMBEDDING_MODEL} ready`);
            }
            else {
                ps.stop("Model pull failed");
                log.warn(`Run \`ollama pull ${EMBEDDING_MODEL}\` manually to retry.`);
            }
        }
        else {
            log.warn(`Skipping model pull — run \`ollama pull ${EMBEDDING_MODEL}\` before using memory recall.`);
        }
    }
    if (ollamaBinaryAvailable() && embeddingModelPresent()) {
        log.success(`Ollama ready — ${EMBEDDING_MODEL} present`);
    }
    // ── Step 3: classifier API key ────────────────────────────────────────
    const wantKey = await confirm({ message: "Add a classifier API key? (enables accurate session tagging; DeepSeek is ~$0.002/session)" });
    if (isCancel(wantKey)) {
        cancel("Setup cancelled.");
        process.exit(0);
    }
    if (wantKey) {
        const classifierChoice = await select({
            message: "Which classifier?",
            options: [
                { value: "deepseek", label: "DeepSeek", hint: "recommended — fast, cheap, needs DEEPSEEK_API_KEY" },
                { value: "ollama-offline", label: "Ollama (offline)", hint: "free, no API key, slower and less accurate" },
            ],
        });
        if (isCancel(classifierChoice)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        if (classifierChoice === "deepseek") {
            const key = await password({ message: "DeepSeek API key (get one at platform.deepseek.com):" });
            if (isCancel(key)) {
                cancel("Setup cancelled.");
                process.exit(0);
            }
            if (key && key.trim()) {
                writeClassifierConfig("deepseek", key.trim());
                log.success("DeepSeek API key saved to ~/.nlm/.env");
            }
            else {
                log.warn("No key entered — set DEEPSEEK_API_KEY in ~/.nlm/.env later.");
            }
        }
        else {
            writeClassifierConfig("ollama-offline");
            log.success("Classifier set to Ollama offline (saved to ~/.nlm/.env)");
        }
    }
    // ── Step 4: migrations ────────────────────────────────────────────────
    const ms = spinner();
    ms.start("Running database migrations");
    try {
        const { SqliteSessionStore } = await import("../core/storage/sqlite-session-store.js");
        const store = new SqliteSessionStore({ dbPath: opts.dbPath, migrationsDir: opts.migrationsDir });
        store.close();
        ms.stop("Database ready");
    }
    catch (e) {
        ms.stop("Migration failed");
        log.error(`${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
    // ── Step 5: daemon ────────────────────────────────────────────────────
    if (OS === "darwin") {
        const installDaemon = await confirm({ message: "Install macOS LaunchAgent (auto-start on login)?" });
        if (isCancel(installDaemon)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        if (installDaemon) {
            const ds = spinner();
            ds.start("Installing LaunchAgent");
            try {
                const uid = process.getuid?.();
                if (uid === undefined)
                    throw new Error("Could not determine UID");
                mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
                writeFileSync(opts.launchAgentPlist, opts.buildPlist(opts.nodeExecPath, opts.nlmBinPath), "utf8");
                try {
                    execFileSync("launchctl", ["bootout", `gui/${uid}`, opts.launchAgentLabel], { stdio: "ignore" });
                }
                catch { /* not loaded yet — expected */ }
                execFileSync("launchctl", ["bootstrap", `gui/${uid}`, opts.launchAgentPlist]);
                ds.stop("LaunchAgent installed — daemon running");
            }
            catch (e) {
                ds.stop("LaunchAgent install failed");
                log.error(`${e instanceof Error ? e.message : String(e)}`);
                log.warn("Run `nlm install` manually later.");
            }
        }
    }
    else if (OS === "linux") {
        log.info("Linux daemon: add `nlm start` to your init system to auto-start on boot.");
        log.info("  systemd example:  sudo systemctl enable --now nlm  (after creating a unit file)");
        log.info("  Quick start now:  nlm start &");
    }
    else if (OS === "win32") {
        log.info("Windows daemon: run `nlm start` at login via Task Scheduler.");
        log.info("  Or start manually: nlm start");
    }
    // ── Step 6: per-runtime configuration ────────────────────────────────
    for (const id of chosen) {
        switch (id) {
            case "claude-code": {
                // MCP config
                const cs = spinner();
                cs.start("Configuring Claude Code — MCP server");
                try {
                    const report = connectClaudeCode({ nlmBinPath: opts.nlmBinPath, nodeExecPath: opts.nodeExecPath });
                    cs.stop(`MCP server ${report.alreadyPresent ? "updated" : "written"} → ${report.mcpConfigPath}`);
                }
                catch (e) {
                    cs.stop("MCP config write failed");
                    log.error(`${e instanceof Error ? e.message : String(e)}`);
                }
                // Hooks — Claude Code hooks are process hooks (settings.json), not
                // OS-level scripts, so they work on all platforms where Claude Code runs.
                const hs = spinner();
                hs.start("Configuring Claude Code — session hooks");
                const hookLogPath = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
                const hookResult = installClaudeCodeHooks({
                    nodeExecPath: opts.nodeExecPath,
                    hooks: opts.allHooks,
                    settingsPath: opts.claudeSettingsPath,
                    hookLogPath,
                    addHook: opts.addHook,
                    removeHook: opts.removeHook,
                    buildHookCommand: opts.buildHookCommand,
                    smokeTestHookCommand: opts.smokeTestHookCommand,
                });
                if (hookResult.ok) {
                    hs.stop(`${hookResult.count} hooks installed → ${opts.claudeSettingsPath}`);
                }
                else {
                    hs.stop(`Hook install failed (${hookResult.failedLabel ?? "unknown"})`);
                    if (hookResult.errorMessage)
                        log.error(hookResult.errorMessage);
                    log.warn("Run `nlm hook install` manually after checking your Node path.");
                }
                break;
            }
            case "codex": {
                if (!codexBinaryAvailable()) {
                    log.warn("Codex binary not found — install with `npm i -g @openai/codex`, then run `nlm connect codex`.");
                    break;
                }
                const cs = spinner();
                cs.start("Connecting Codex");
                try {
                    const report = connectCodex({ source: "pbmagnet4/nlm-memory-ts" }, pluginScriptsDir(opts.repoRoot));
                    if (report.marketplaceAdd?.status !== 0 || report.pluginAdd?.status !== 0) {
                        cs.stop("Codex connect had errors — run `nlm connect codex` manually to retry");
                    }
                    else {
                        cs.stop("Codex marketplace + plugin registered");
                    }
                }
                catch (e) {
                    cs.stop("Codex connect failed");
                    log.error(`${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }
            case "opencode":
                log.success("OpenCode: session scanning enabled (passive — no extra config needed)");
                break;
            case "hermes": {
                const hs = spinner();
                hs.start("Configuring Hermes");
                try {
                    const report = connectHermes({ nlmBinPath: opts.nlmBinPath, nodeExecPath: opts.nodeExecPath });
                    hs.stop(`MCP server ${report.alreadyPresent ? "updated" : "written"} → ${report.configPath}`);
                }
                catch (e) {
                    hs.stop("Hermes config write failed");
                    log.error(`${e instanceof Error ? e.message : String(e)}`);
                    log.warn("Run `nlm connect hermes` manually after checking ~/.hermes/config.yaml.");
                }
                break;
            }
            case "pi":
                log.success("pi.dev: session scanning enabled (passive — no extra config needed)");
                break;
        }
    }
    // ── Summary ───────────────────────────────────────────────────────────
    const needsRestart = [];
    if (chosen.includes("claude-code"))
        needsRestart.push("Claude Code");
    if (chosen.includes("hermes"))
        needsRestart.push("Hermes");
    outro(needsRestart.length > 0
        ? `Done! Restart ${needsRestart.join(" and ")} for the MCP server to activate, then start a session — memory will follow.`
        : "Done! Start a session in any configured runtime and NLM will begin indexing automatically.");
}
//# sourceMappingURL=setup.js.map