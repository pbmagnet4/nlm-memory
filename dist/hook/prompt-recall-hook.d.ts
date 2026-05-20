/**
 * Claude Code UserPromptSubmit hook entrypoint for NLM recall.
 *
 * runHook is the testable orchestration; main() is the thin process wrapper
 * (stdin / stdout / fetch / env). Every path is fail-open: any error yields
 * no output and a clean exit, so the hook can never block or fail a prompt.
 *
 * Mode is read from NLM_HOOK_MODE (default "shadow"). In shadow mode the
 * hook logs what it would inject and emits nothing; in live mode it emits a
 * pointer block and records the per-conversation memo.
 */
import { type RecallHitInput } from "../core/hook/select.js";
export type HookMode = "shadow" | "live";
export interface HookInput {
    readonly prompt: string;
    readonly conversationId: string;
}
export interface RunHookDeps {
    readonly mode: HookMode;
    readonly recall: (prompt: string) => Promise<ReadonlyArray<RecallHitInput>>;
}
/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export declare function runHook(input: HookInput, deps: RunHookDeps): Promise<string>;
