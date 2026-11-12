/**
 * T1778 — the question sets for the recall hook (E2), the populate precision gate
 * (E3) and the dream contradiction judge (E4), including the 2-3 phrasings tried
 * for each. Every phrasing keeps the same answer names, so one scorer reads any
 * of them; phrasing selection happens on the tune split only.
 */
import type { ClefQuestion } from "../../../src/llm/clef-client.js";

// ---------------------------------------------------------------- E2 recall hook

export type RecallVariant = "R1_generic" | "R2_productLine" | "R3_lossIfDropped";

/** Injected memory summaries are ~700 chars in production; cap keeps the payload honest. */
export const ITEM_CAP = 900;

/** The prompt is the shared state of one hook call. */
export const recallState = (prompt: string): unknown => ({ prompt });

/** One score question per candidate memory, asked in the same call. */
export function recallQuestions(items: readonly string[], variant: RecallVariant): Record<string, ClefQuestion> {
  const out: Record<string, ClefQuestion> = {};
  items.forEach((item, i) => {
    const text = item.slice(0, ITEM_CAP);
    out[`i${i}`] =
      variant === "R1_generic"
        ? {
            type: "score",
            instructions: `How relevant is this memory to the user's prompt?\nMemory: ${text}`,
            criteria: [
              "Nothing to do with what the prompt asks about",
              "Same general area, but nothing the reply needs",
              "About the same project or system, useful background",
              "Says something the reply needs or must not contradict",
            ],
          }
        : variant === "R2_productLine"
          ? {
              type: "score",
              instructions: `How useful is this prior-session context for responding to the user's prompt?\nMemory: ${text}`,
              criteria: [
                "Unrelated topic, pure noise",
                "Same general area but nothing the response needs",
                "Related project or system with some useful background",
                "Directly needed facts or decisions for this prompt",
              ],
            }
          : {
              type: "score",
              instructions: `If this memory were dropped before the assistant saw the prompt, how much would the reply lose?\nMemory: ${text}`,
              criteria: [
                "Nothing: the reply does not change at all",
                "A little: some colour the reply did not need",
                "Something real: background that keeps the reply accurate",
                "A lot: the reply would be wrong, or would miss what was asked",
              ],
            };
  });
  return out;
}

// ------------------------------------------------------------ E3 populate gate

export type PopulateVariant = "P1_informative" | "P2_pageworthy" | "P3_notAssumable";

/** The page is the shared state; each drafted statement is one question. */
export const populateState = (page: { subject: string; title: string }): unknown => ({ page: page.subject, pageTitle: page.title });

export function populateQuestions(page: { subject: string; title: string }, statements: readonly string[], variant: PopulateVariant): Record<string, ClefQuestion> {
  const out: Record<string, ClefQuestion> = {};
  statements.forEach((s, i) => {
    out[`s${i}`] =
      variant === "P1_informative"
        ? {
            type: "score",
            instructions: `How much does this statement tell a reader about ${page.subject}?\nStatement: ${s}`,
            criteria: [
              "Nothing: a fragment, a hash or a label with no claim in it",
              "Almost nothing: a vague mention with no detail a reader could use",
              "Something: one concrete attribute, action or state of it",
              "A lot: specific, checkable detail a reader would want on the page",
            ],
          }
        : variant === "P2_pageworthy"
          ? {
              type: "score",
              instructions: `Should this statement go on the ${page.subject} page ("${page.title}")?\nStatement: ${s}`,
              criteria: [
                "No: no claim in it, or page furniture about the document itself",
                "No: it belongs to a different project or subject",
                "Maybe: about this subject but thin",
                "Yes: a concrete fact a reader of this page came for",
              ],
            }
          : {
              type: "score",
              instructions: `How much does this statement tell a reader about ${page.subject} that they could not assume anyway?\nStatement: ${s}`,
              criteria: [
                "Nothing: no claim, or a fragment with no content",
                "Nothing new: whatever a reader would assume anyway",
                "Something: one concrete attribute, action or state",
                "A lot: detail only this project's record would carry",
              ],
            };
  });
  return out;
}

// --------------------------------------------------------- E4 dream contradiction

export type DreamVariant = "D1_noul" | "D2_score" | "D3_noulStrict";

export interface DreamPair {
  fact: string;
  evidence: string;
}

/** The pair is the shared state; the question is fixed wording per variant. */
export const dreamState = (pair: DreamPair): unknown => ({
  storedFact: pair.fact,
  evidenceFromSource: pair.evidence,
});

export function dreamQuestions(variant: DreamVariant): Record<string, ClefQuestion> {
  return variant === "D1_noul"
    ? { contradict: { type: "noul", instructions: "Does the later evidence contradict the stored fact, so the fact should no longer be treated as true?" } }
    : variant === "D3_noulStrict"
      ? {
          contradict: {
            type: "noul",
            instructions: "Does the evidence state the opposite of the stored fact in the same terms, rather than a different or older detail?",
            criteria: {
              true: "The evidence says the stored fact is no longer true, in the same terms.",
              false: "The evidence is about something else, words the same thing differently, or is an instruction about what to do rather than a statement of fact.",
            },
          },
        }
      : {
          contradict: {
            type: "score",
            instructions: "If the stored fact were kept after reading the evidence, how wrong would a reader be?",
            criteria: [
              "Not wrong: the evidence agrees, or says nothing about it",
              "Barely: wording differs but the fact still holds",
              "Wrong in a detail: some part of the fact no longer holds",
              "Wrong outright: the evidence says the opposite is now true",
            ],
          },
        };
}
