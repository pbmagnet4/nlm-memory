/**
 * Prompt gate for the recall hook. Pure — no I/O.
 *
 * A conservative generative *excluder*: the default is "evaluate" (query
 * recall); only high-precision generative openers short-circuit to
 * "generative". A false "generative" wrongly skips recall — the exact
 * failure this feature fixes — so the generative set is deliberately tight.
 * It is calibrated further against shadow-mode logs.
 */
const LEADING_FILLER = /^(please|can you|could you|would you|will you|i need you to|i'd like you to|i want you to|i would like you to|help me|let's|lets|hey|ok|okay)\b[\s,]*/i;
const GENERATIVE_OPENER = /^(write|draft|create|compose|generate|brainstorm|design|outline|sketch|invent|rename|come up with)\b/i;
export function classifyPrompt(prompt) {
    let p = prompt.trim();
    for (let i = 0; i < 3 && LEADING_FILLER.test(p); i++) {
        p = p.replace(LEADING_FILLER, "");
    }
    return GENERATIVE_OPENER.test(p) ? "generative" : "evaluate";
}
//# sourceMappingURL=gate.js.map