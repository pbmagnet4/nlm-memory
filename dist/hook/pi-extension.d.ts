/**
 * pi.dev extension entrypoint for NLM recall.
 *
 * Pi exposes hooks as a TypeScript extension API, not config-file hooks like
 * Claude Code. The user loads this with `pi -e <path>/nlm-extension.mjs`.
 *
 * On every user input event we route through the shared runHook orchestration
 * used by the Claude Code script. Difference: instead of writing to stdout for
 * Claude to merge into the prompt, we return `{ action: "transform", text }`
 * with the pointer block prepended to the user's text — pi's input pipeline
 * substitutes our text in place of the original.
 *
 * Stop-hook equivalent is not needed. Pi sessions land in
 * `~/.pi/agent/sessions/**\/*.jsonl` and the passive pi adapter
 * (`src/core/adapters/pi.ts`) ingests them on its own schedule.
 *
 * Fail-open: any error in the hook returns `{ action: "continue" }` so a
 * recall failure can never block or alter a user's prompt.
 */
interface PiInputEvent {
    readonly type: "input";
    readonly text: string;
    readonly source: string;
}
interface PiSessionManager {
    getSessionId(): string;
}
interface PiExtensionContext {
    readonly sessionManager: PiSessionManager;
}
type PiInputResult = {
    action: "continue";
} | {
    action: "transform";
    text: string;
} | {
    action: "handled";
};
interface PiExtensionAPI {
    on(event: "input", handler: (event: PiInputEvent, ctx: PiExtensionContext) => Promise<PiInputResult> | PiInputResult): void;
}
export default function nlmExtension(pi: PiExtensionAPI): void;
export {};
