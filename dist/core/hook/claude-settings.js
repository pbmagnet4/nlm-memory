/**
 * Adds/removes NLM hook entries in a Claude Code settings.json.
 *
 * NLM-owned entries are identified by HOOK_SCRIPT_MARKERS. add is idempotent
 * (replaces any prior NLM entry for the same event); remove strips only NLM
 * entries and preserves everything else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Every NLM hook script ends in `-hook.js`. We tag entries we own by
// matching the filename suffix against this list. Add new entries here
// when a new hook script ships.
const HOOK_SCRIPT_MARKERS = [
    "prompt-recall-hook.js",
    "session-end-hook.js",
    "stop-hook.js",
    "session-start-hook.js",
    "pre-compact-hook.js",
    "subagent-start-hook.js",
];
/**
 * Single-quote a shell argument so paths with spaces or other shell
 * metacharacters survive `sh -c` tokenization. Without this, a path like
 * `~/projects/...` is split on whitespace
 * and node receives the wrong argv — silent hook bricking.
 */
export function shellQuote(arg) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
}
/**
 * Double-quote a cmd.exe argument. Embedded double quotes are doubled per
 * cmd.exe parsing rules. Used for hook commands on Windows where Claude
 * Code dispatches via cmd.exe /c rather than sh -c.
 */
export function cmdQuote(arg) {
    return `"${arg.replace(/"/g, '""')}"`;
}
export function buildHookCommand(execPath, hookJs, mode, targetPlatform = process.platform) {
    if (targetPlatform === "win32") {
        // cmd.exe: `set VAR=val && "exec" "script"`. The set is scoped to the
        // cmd /c invocation so the env var is visible to the chained child.
        return `set NLM_HOOK_MODE=${mode} && ${cmdQuote(execPath)} ${cmdQuote(hookJs)}`;
    }
    return `NLM_HOOK_MODE=${mode} ${shellQuote(execPath)} ${shellQuote(hookJs)}`;
}
function read(path) {
    if (!existsSync(path))
        return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Claude settings at ${path} is not a JSON object`);
    }
    return parsed;
}
function write(path, settings) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
function isNlmEntry(entry) {
    return entry.hooks.some((h) => HOOK_SCRIPT_MARKERS.some((marker) => h.command.includes(marker)));
}
export function addHook(settingsPath, command, event = "UserPromptSubmit") {
    const settings = read(settingsPath);
    const hooks = settings.hooks ?? {};
    const existing = hooks[event] ?? [];
    const others = existing.filter((e) => !isNlmEntry(e));
    const next = [
        ...others,
        { hooks: [{ type: "command", command }] },
    ];
    write(settingsPath, { ...settings, hooks: { ...hooks, [event]: next } });
}
/**
 * Remove the NLM-tagged hook entry from one event (default UserPromptSubmit)
 * or every event when `event === "*"`. Leaves unrelated entries untouched.
 */
export function removeHook(settingsPath, event = "UserPromptSubmit") {
    if (!existsSync(settingsPath))
        return;
    const settings = read(settingsPath);
    const allHooks = settings.hooks ?? {};
    const events = event === "*" ? Object.keys(allHooks) : [event];
    const nextHooks = { ...allHooks };
    for (const ev of events) {
        const existing = nextHooks[ev];
        if (!existing)
            continue;
        const kept = existing.filter((e) => !isNlmEntry(e));
        if (kept.length > 0)
            nextHooks[ev] = kept;
        else
            delete nextHooks[ev];
    }
    write(settingsPath, { ...settings, hooks: nextHooks });
}
//# sourceMappingURL=claude-settings.js.map