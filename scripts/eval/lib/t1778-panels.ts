/**
 * T1778 E1/E2 helper — the panel variants and the score-question builders.
 *
 * Variants keep the SAME answer names as the production panel in
 * src/core/classifier/triage-panel.ts, so src/core/classifier/gate-model.ts can
 * read any of them without change; only the wording of the two score questions
 * differs. Selection between variants happens on the tune split only.
 */
import type { ClefQuestion } from "../../../src/llm/clef-client.js";
import { gateQuestions, triageQuestions } from "../../../src/core/classifier/triage-panel.js";

export type Variant = "A_prod" | "B_anchored" | "C_counterfactual";

const FLAGS = ["decision", "abandoned", "failure", "unfinished", "facts", "outcome", "delegated"] as const;

/** One panel: the triage choice/score questions plus the seven noul flags. */
export function panel(variant: Variant): Record<string, ClefQuestion> {
  if (variant === "A_prod") return gateQuestions();
  const prod = gateQuestions();
  const base = triageQuestions();
  const flags: Record<string, ClefQuestion> = {};
  for (const f of FLAGS) flags[f] = prod[f]!;
  const kind: ClefQuestion = base.kind!;
  if (variant === "B_anchored") {
    return {
      ...flags,
      kind,
      importance: {
        type: "score",
        instructions: "If this session were filed away, what would a future assistant gain from reading it?",
        criteria: [
          "Nothing: no project content at all",
          "Little: routine work with nothing stored",
          "Some: at least one durable fact such as a path, port, version, setting or owner",
          "Much: a decision, failure or lesson that changes future work",
        ],
      },
      extractable: {
        type: "score",
        instructions: "Count the items a summariser could store from this session: decisions, failures, and durable facts such as names, versions, ports, paths, settings, owners.",
        criteria: ["Zero", "One or two", "Three to five", "Six or more"],
      },
    };
  }
  return {
    ...flags,
    kind,
    importance: {
      type: "score",
      instructions: "Would skipping this session lose anything a later session could not work out again by itself?",
      criteria: [
        "Nothing: noise, or the answer is easy to work out again",
        "A little: a minor detail that would take some looking",
        "A real amount: a decision or setting not written down anywhere else",
        "A lot: a lesson or failure mode that would otherwise be repeated",
      ],
    },
    extractable: {
      type: "score",
      instructions: "Of the items a summariser could store (decisions, failures, durable facts), how many are NOT already obvious from the code or config alone?",
      criteria: ["Zero", "One or two", "Three to five", "Six or more"],
    },
  };
}
