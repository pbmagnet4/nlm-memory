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

/**
 * The ingest-gate panel: the triage questions plus questions aimed at what the
 * classifier actually stores. Asked in one call; the gate model (gate-model.ts)
 * is fitted on these answers, so changing a question requires refitting it.
 */
export function gateQuestions(): Record<string, ClefQuestion> {
  const flag = (instructions: string): ClefQuestion => ({ type: "noul", instructions });
  return {
    ...triageQuestions(),
    facts: flag("Does the session state durable facts worth remembering later, such as names, versions, ports, paths, settings, owners, prices or deadlines?"),
    outcome: flag("Does the session end with a concrete result, such as a change made, a conclusion reached or a value found?"),
    delegated: flag("Is this session an automated or delegated run, such as a subagent task, scheduled job or tool loop, rather than a person working with an assistant?"),
    extractable: {
      type: "score",
      instructions: "How many distinct decisions and durable facts could be extracted from this session?",
      criteria: ["None", "One or two", "Three to five", "Six or more"],
    },
  };
}
