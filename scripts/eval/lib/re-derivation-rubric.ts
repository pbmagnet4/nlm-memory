/**
 * Blind labelling rubric for Stage A.
 *
 * The five categories are not arbitrary. They come from inspecting what the
 * shipped detector actually flags (2026-08-04): 12 of its 15 positives are
 * subagent code reviews whose entire decision content is "Task 6 approved" or
 * "Approved Task 2". A binary genuine/not rubric scores that cluster as
 * ambiguous; naming RITUAL scores it as the specific artifact it is, which is
 * what lets the calibration report WHY a configuration is wrong rather than
 * only that it is.
 *
 * BLINDING: buildJudgePrompt renders dates, labels, decisions, and excerpts and
 * nothing else. It deliberately omits session ids, because the `cc_sub_` prefix
 * would hand the judge the subagent flag - and the subagent confound is
 * precisely what these labels exist to measure independently of the detector.
 */

export type VerdictLabel =
  | "GENUINE"
  | "REVISIT"
  | "RITUAL"
  | "SAME_TOPIC_DIFFERENT_DECISION"
  | "UNRELATED"
  | "DUPLICATE";

export const VERDICT_LABELS: ReadonlyArray<VerdictLabel> = [
  "GENUINE",
  "REVISIT",
  "RITUAL",
  "SAME_TOPIC_DIFFERENT_DECISION",
  "UNRELATED",
  "DUPLICATE",
];

export interface Verdict {
  readonly label: VerdictLabel;
  readonly confidence: number;
  readonly reason: string;
}

export interface SampleSide {
  readonly label: string;
  readonly startedAt: string;
  readonly decisions: ReadonlyArray<string>;
  readonly excerpt: string;
}

export interface SampleRow {
  readonly pairId: string;
  readonly a: SampleSide;
  readonly b: SampleSide;
}

export const RUBRIC_SYSTEM = `You are labelling whether a later AI working session RE-DERIVED a decision that an earlier session had already settled.

Reply with JSON only, no prose around it:
{"label": "<LABEL>", "confidence": <number 0..1>, "reason": "<one sentence>"}

LABELS:

- GENUINE: the later session works out an answer the earlier session had already
  settled, with no sign it knew about the earlier one. This is the ONLY positive
  label. The work was redone because the prior answer was not available.

- REVISIT: the later session knowingly changes, refines, reverses, or extends the
  earlier decision. Knowing you are changing a prior call is not re-deriving it.

- RITUAL: both sessions perform the same recurring routine on different subjects.
  "Task 6 approved" and "Approved Task 2" are the same ritual, not the same
  decision. Code reviews, status checks, and approvals of differently-numbered
  tasks all land here. This is the most common wrong answer, so check for it
  before choosing GENUINE.

- SAME_TOPIC_DIFFERENT_DECISION: the two sessions share a subject area but settle
  genuinely different questions about it.

- UNRELATED: the two sessions are about different work entirely. They may share a
  stray word or tool name, but nothing about one bears on the other. Use this
  rather than SAME_TOPIC_DIFFERENT_DECISION when there is no shared subject.

- DUPLICATE: the two sessions look like the same piece of work recorded twice,
  rather than a person doing the work twice.

HOW TO JUDGE:

Read what the decisions actually say and what the excerpts show each session
doing. Ask: did the later session have to work something out that the earlier
session had already worked out?

Short, formulaic decision text is weak evidence of anything. Two sessions can
share almost every word and still be unrelated work. When the only thing the two
decisions share is boilerplate phrasing, prefer RITUAL over GENUINE.

Two sessions can also re-derive the same decision while sharing almost no words.
Judge the substance, not the wording overlap.

If you are genuinely unsure, pick the most likely label and set confidence low.`;

function renderSide(name: string, s: SampleSide): string {
  const decisions = s.decisions.map((d) => `  - ${d}`).join("\n");
  return [
    `${name} (${s.startedAt.slice(0, 10)}): ${s.label}`,
    `Decisions:`,
    decisions || "  (none recorded)",
    `What the session did: ${s.excerpt.trim()}`,
  ].join("\n");
}

export function buildJudgePrompt(row: SampleRow): string {
  return [
    renderSide("EARLIER SESSION", row.a),
    "",
    renderSide("LATER SESSION", row.b),
    "",
    "Did the LATER session re-derive a decision the EARLIER session had already settled?",
  ].join("\n");
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Returns null rather than guessing when the model's output cannot be read as a
 * verdict. Callers record null and EXCLUDE the row from scoring - coercing an
 * unparseable reply to a negative would quietly inflate every recall number.
 */
export function parseVerdict(raw: string): Verdict | null {
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const o = parsed as Record<string, unknown>;
  const label = o["label"];
  if (typeof label !== "string") return null;
  const upper = label.toUpperCase().replace(/[\s-]+/g, "_");
  if (!VERDICT_LABELS.includes(upper as VerdictLabel)) return null;

  return {
    label: upper as VerdictLabel,
    confidence: clamp01(typeof o["confidence"] === "number" ? o["confidence"] : 0),
    reason: typeof o["reason"] === "string" ? o["reason"] : "",
  };
}

/** GENUINE is the only positive. Everything else is a negative for scoring. */
export function isPositive(v: Verdict): boolean {
  return v.label === "GENUINE";
}
