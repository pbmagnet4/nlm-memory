import { truncateTranscript, MAX_TRANSCRIPT_CHARS } from "../../../src/core/classifier/prompt.js";
import type { ClefQuestion } from "./clef-client.js";

export function capState(text: string): string {
  return truncateTranscript(text, MAX_TRANSCRIPT_CHARS);
}

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

export function triageQuestions(): Record<string, ClefQuestion> {
  const flag = (instructions: string): ClefQuestion => ({ type: "noul", instructions });
  return {
    kind: {
      type: "choice",
      instructions: "What kind of session is this?",
      criteria: {
        coding: "Writing, fixing or refactoring code",
        ops: "Infrastructure, deployment, configuration or debugging a running system",
        research: "Research, writing, analysis or planning",
        meeting: "Meeting notes or coordination",
        trivial: "A quick lookup, greeting or one-off question with no project work",
      },
    },
    importance: {
      type: "score",
      instructions: "How much durable project value does this session contain?",
      criteria: [
        "None: greeting, trivia or chit-chat; no project, no decision",
        "Minor: routine activity with no lasting decision",
        "Substantive: real project work with at least one concrete decision",
        "Major: significant decisions, failures or lessons that should guide future work",
      ],
    },
    decision: flag("Did the user or agent make a concrete decision in this session?"),
    abandoned: flag("Was an approach tried and then abandoned in this session?"),
    failure: flag("Did something fail in a way worth remembering?"),
    unfinished: flag("Is work left unfinished at the end of the session?"),
  };
}
