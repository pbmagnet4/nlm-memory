/**
 * Claude Code SessionStart hook entrypoint for NLM recall.
 *
 * Fires before any prompt in a new session (including cron-fired and background
 * agents that never trigger UserPromptSubmit). Surfaces relevant prior context
 * proactively so cold-start agents aren't recall-blind.
 *
 * Query is derived from working_directory + project name since no user prompt
 * exists yet — intentionally weaker than prompt-recall, best-effort only.
 *
 * Mirrors prompt-recall-hook.ts shape exactly: same pointer-block format, same
 * memo writes, same NLM_HOOK_MODE semantics.
 */
import { type RecallHitInput } from "../core/hook/select.js";
export type HookMode = "shadow" | "live";
export interface SessionStartInput {
    readonly conversationId: string;
    readonly query: string;
}
export interface RunSessionStartDeps {
    readonly mode: HookMode;
    readonly recall: (query: string) => Promise<ReadonlyArray<RecallHitInput>>;
}
/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export declare function runHook(input: SessionStartInput, deps: RunSessionStartDeps): Promise<string>;
