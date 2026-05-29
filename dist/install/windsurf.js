/**
 * `nlm connect windsurf` / `nlm disconnect windsurf` — registers or removes the
 * Windsurf adapter source in the NLM source registry.
 *
 * NLM reads Windsurf's existing workspace SQLite DBs directly from the User
 * directory. The connect operation only registers the source row so the daemon
 * scans it.
 */
import { existsSync } from "node:fs";
import { defaultUserDir } from "../core/adapters/windsurf.js";
export function connectWindsurf(registry, opts = {}) {
    const userDir = opts.userDir ?? defaultUserDir();
    const dirExists = existsSync(userDir);
    if (opts.dryRun) {
        return { userDir, dirExists, action: "dry-run" };
    }
    const existing = registry.getByName("Windsurf");
    if (existing) {
        if (existing.enabled && existing.pathOrUrl === userDir) {
            return { userDir, dirExists, action: "already-active" };
        }
        registry.update(existing.id, { enabled: true, pathOrUrl: userDir });
        return { userDir, dirExists, action: "enabled" };
    }
    registry.insert({
        kind: "windsurf",
        name: "Windsurf",
        pathOrUrl: userDir,
        runtimeLabel: "windsurf/1.0",
        enabled: dirExists,
    });
    return { userDir, dirExists, action: "created" };
}
export function disconnectWindsurf(registry, opts = {}) {
    if (opts.dryRun)
        return { action: "dry-run" };
    const existing = registry.getByName("Windsurf");
    if (!existing)
        return { action: "not-found" };
    registry.update(existing.id, { enabled: false });
    return { action: "disabled" };
}
//# sourceMappingURL=windsurf.js.map