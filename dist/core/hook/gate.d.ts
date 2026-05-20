/**
 * Prompt gate for the recall hook. Pure — no I/O.
 *
 * A conservative generative *excluder*: the default is "evaluate" (query
 * recall); only high-precision generative openers short-circuit to
 * "generative". A false "generative" wrongly skips recall — the exact
 * failure this feature fixes — so the generative set is deliberately tight.
 * It is calibrated further against shadow-mode logs.
 */
export type PromptClass = "generative" | "evaluate";
export declare function classifyPrompt(prompt: string): PromptClass;
