/**
 * Adds/removes the NLM recall hook entry in a Claude Code settings.json.
 *
 * The nlm entry is identified by its command containing the marker
 * "prompt-recall-hook.js". add is idempotent (it replaces any prior nlm
 * entry); remove strips only the nlm entry and preserves everything else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const HOOK_MARKER = "prompt-recall-hook.js";
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
    return entry.hooks.some((h) => h.command.includes(HOOK_MARKER));
}
export function addHook(settingsPath, command) {
    const settings = read(settingsPath);
    const hooks = settings.hooks ?? {};
    const existing = hooks.UserPromptSubmit ?? [];
    const others = existing.filter((e) => !isNlmEntry(e));
    const next = [
        ...others,
        { hooks: [{ type: "command", command }] },
    ];
    write(settingsPath, { ...settings, hooks: { ...hooks, UserPromptSubmit: next } });
}
export function removeHook(settingsPath) {
    if (!existsSync(settingsPath))
        return;
    const settings = read(settingsPath);
    const existing = settings.hooks?.UserPromptSubmit;
    if (!existing)
        return;
    const kept = existing.filter((e) => !isNlmEntry(e));
    const { UserPromptSubmit: _removed, ...otherHooks } = settings.hooks ?? {};
    const hooks = kept.length > 0
        ? { ...otherHooks, UserPromptSubmit: kept }
        : otherHooks;
    write(settingsPath, { ...settings, hooks });
}
//# sourceMappingURL=claude-settings.js.map