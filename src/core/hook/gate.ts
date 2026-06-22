/**
 * Prompt gate for the recall hook. Pure — no I/O.
 *
 * Two excluders, both conservative (a wrong exclusion skips useful recall — the
 * failure this feature exists to prevent — so both sets are deliberately tight):
 *
 *  - "skip": no user query to serve. Harness-injected events (IDE selections,
 *    task notifications, system reminders), bare acknowledgements ("ok", "do
 *    it"), and empty/punctuation prompts. Measured: ~41% of historical hook
 *    injections fired on these — pure context flooding that can never be cited.
 *    SAFE by construction: any prompt that still carries real user content after
 *    stripping harness boilerplate falls through and still fires.
 *  - "generative": high-precision generative openers ("write", "draft", …).
 *
 * Everything else defaults to "evaluate" (run recall).
 */

export type PromptClass = "generative" | "evaluate" | "skip";

const LEADING_FILLER =
  /^(please|can you|could you|would you|will you|i need you to|i'd like you to|i want you to|i would like you to|help me|let's|lets|hey|ok|okay)\b[\s,]*/i;

const GENERATIVE_OPENER =
  /^(write|draft|create|compose|generate|brainstorm|design|outline|sketch|invent|rename|come up with)\b/i;

// Harness-injected tags. These are emitted by the agent runtime, not typed by
// the user, so they carry no query intent on their own. We strip the whole
// block (well-formed `<tag>…</tag>`, or to end-of-string if unclosed) — a real
// user query appended after the block survives and still triggers recall.
const HARNESS_TAGS = [
  "ide_selection",
  "ide_opened_file",
  "ide_closed_file",
  "ide_diagnostics",
  "ide_recently_modified_file",
  "task-notification",
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
];
const HARNESS_BLOCK = new RegExp(
  `<(${HARNESS_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?(?:</\\1>|$)`,
  "gi",
);

// Whole-prompt acknowledgements — matched against the entire residual, so a
// real query that merely opens with an ack word ("ok so why does X…") is NOT
// caught. A bare ack has no recall value.
const ACK_ONLY =
  /^(yes|yep|yeah|sure|ok|okay|k|thanks|thank you|ty|done|nice|cool|great|perfect|continue|next|go|go ahead|do it|yes please|sounds good|good|got it|right|correct)\W*$/i;

function contentWordCount(s: string): number {
  const m = s.match(/[A-Za-z0-9]{2,}/g);
  return m ? m.length : 0;
}

export function classifyPrompt(prompt: string): PromptClass {
  let p = prompt.replace(HARNESS_BLOCK, " ").replace(/\s+/g, " ").trim();
  if (contentWordCount(p) === 0) return "skip"; // harness-only / empty / punctuation
  if (ACK_ONLY.test(p)) return "skip"; // bare acknowledgement

  for (let i = 0; i < 3 && LEADING_FILLER.test(p); i++) {
    p = p.replace(LEADING_FILLER, "");
  }
  p = p.trim();
  if (contentWordCount(p) === 0) return "skip"; // was pure leading filler ("ok", "lets")

  return GENERATIVE_OPENER.test(p) ? "generative" : "evaluate";
}
