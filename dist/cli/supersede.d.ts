/**
 * `nlm supersede` — interactive operator path for post-hoc supersedence.
 *
 * Wraps `SessionStore.markSuperseded` with two search prompts (predecessor +
 * successor) and an optional reason. Reuses the recall layer so operators
 * pick by label/snippet, never by typing UUIDs. Idempotent: re-running on
 * the same pair returns `noop: true` rather than re-writing.
 *
 * The non-interactive path (both ids passed as args) exists for shell
 * scripts and the test suite — when both ids are present and `--yes` is
 * set, no prompts fire.
 *
 * I/O is injected so tests can drive the command without a TTY. The real
 * CLI wires this to @clack/prompts; tests pass a stub io.
 */
import type { RecallService as RecallServiceType } from "../core/recall/recall-service.js";
import type { SessionStore } from "../ports/session-store.js";
export interface SupersedeOptions {
    readonly predecessor?: string | undefined;
    readonly successor?: string | undefined;
    readonly reason?: string | undefined;
    readonly yes?: boolean;
}
export interface SupersedeIO {
    /** Prompt the user with a free-text query, returning the search term. */
    promptQuery(label: string): Promise<string | null>;
    /** Show ranked candidates, return the chosen session id or null on cancel. */
    promptCandidate(label: string, candidates: ReadonlyArray<SessionCandidate>): Promise<string | null>;
    /** Ask for the optional reason field. Empty string means none. */
    promptReason(): Promise<string | null>;
    /** Confirm the link before writing. */
    confirmLink(predecessor: SessionCandidate, successor: SessionCandidate): Promise<boolean>;
    /**
     * Confirm an overwrite of an existing supersedence link. Fires only when
     * the predecessor is already marked superseded by a *different* successor —
     * the user is about to silently stomp a prior decision. Default IO renders
     * a distinct prompt so the destructive nature is unmissable.
     */
    confirmOverwrite(predecessor: SessionCandidate, existingSuccessor: SessionCandidate, newSuccessor: SessionCandidate): Promise<boolean>;
    /** Emit a human-readable line. Stdout for results, stderr for narration. */
    info(line: string): void;
    warn(line: string): void;
}
export interface SessionCandidate {
    readonly id: string;
    readonly label: string;
    readonly startedAt: string | null;
    readonly runtime: string;
}
export interface SupersedeDeps {
    readonly store: SessionStore;
    readonly recall: RecallServiceType;
    readonly io: SupersedeIO;
}
export type SupersedeOutcome = {
    kind: "marked";
    predecessor: string;
    successor: string;
    reason?: string;
} | {
    kind: "noop";
    predecessor: string;
    successor: string;
} | {
    kind: "cancelled";
    reason: string;
};
export declare function executeSupersede(deps: SupersedeDeps, opts: SupersedeOptions): Promise<SupersedeOutcome>;
export declare function defaultIO(): SupersedeIO;
export interface RunSupersedeArgs extends SupersedeOptions {
}
export declare function runSupersedeCommand(args: RunSupersedeArgs, factory?: () => SupersedeDeps): Promise<void>;
