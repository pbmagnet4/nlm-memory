/**
 * The Clef triage panel calibrated in docs/clef-decision-panel-findings.md (T533).
 * Changing a question or the state cap invalidates the ingest gate threshold.
 */
import type { ClefQuestion } from "../../llm/clef-client.js";
import { MAX_TRANSCRIPT_CHARS, truncateTranscript } from "./prompt.js";

export function capState(text: string): string {
  return truncateTranscript(text, MAX_TRANSCRIPT_CHARS);
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
