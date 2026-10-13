import type { ClefQuestion } from "../../../src/llm/clef-client.js";

const GATE_INSTRUCTIONS =
  "Would the prior-session context help the assistant respond to the user's prompt? Answer yes only if the context is about the same project, system or topic the prompt concerns, or contains facts the response would need. Answer no if the context is about an unrelated topic.";

export function recallGateQuestions(variant: "noul" | "noulCriteria" | "score"): Record<string, ClefQuestion> {
  if (variant === "noul") return { q: { type: "noul", instructions: GATE_INSTRUCTIONS } };
  if (variant === "noulCriteria") {
    return {
      q: {
        type: "noul",
        instructions: GATE_INSTRUCTIONS,
        criteria: {
          true: "The prior-session context concerns the same project, system or topic as the prompt, or has facts needed to answer it.",
          false: "The prior-session context is about an unrelated topic and would be noise.",
        },
      },
    };
  }
  return {
    q: {
      type: "score",
      instructions: "How useful is the prior-session context for responding to the user's prompt?",
      criteria: [
        "Unrelated topic, pure noise",
        "Same general area but nothing the response needs",
        "Related project or system with some useful background",
        "Directly needed facts or decisions for this prompt",
      ],
    },
  };
}

