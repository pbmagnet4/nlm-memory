import type { ClefAnswer, ClefQuestion } from "./clef-client.js";

export function workstreamQuestion(labels: string[]): ClefQuestion {
  const criteria: Record<string, string> = {};
  labels.forEach((label, i) => { criteria[`w${i}`] = label; });
  criteria["none"] = "None of these: the session belongs to a workstream not listed";
  return { type: "choice", instructions: "Which existing workstream does this session belong to?", criteria };
}

export function pickWorkstream(answer: ClefAnswer, ids: string[], minConfidence: number): string | null {
  if (answer.type !== "choice") throw new Error(`expected a choice answer, got ${answer.type}`);
  if (answer.choice === "none" || answer.confidence < minConfidence) return null;
  const i = Number(answer.choice.slice(1));
  if (!answer.choice.startsWith("w") || !Number.isInteger(i) || !ids[i]) throw new Error(`choice ${answer.choice} is not an option`);
  return ids[i]!;
}

export function scoreWorkstreams(rows: { gold: string; pred: string | null; error?: boolean }[]) {
  let errors = 0, correct = 0, wrong = 0, abstained = 0;
  for (const r of rows) {
    if (r.error) errors++;
    else if (r.pred === null) abstained++;
    else if (r.pred === r.gold) correct++;
    else wrong++;
  }
  return { n: rows.length, errors, correct, wrong, abstained };
}
