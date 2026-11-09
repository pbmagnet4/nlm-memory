/**
 * Fact-dedup scoring core (T1610).
 *
 * Pure functions that propose merges for duplicate or overlapping active
 * facts. No LLM calls, no DB access, no I/O — deterministic on plain inputs,
 * mirroring the dream-pass scoring core (eval/dream-metrics.ts) and the
 * conservative lexical philosophy of entities/dedup-suggest.ts.
 *
 * Conservative by design (the dedup-suggest rationale applies verbatim:
 * lexical-adjacent-but-different values are exactly where similarity
 * over-merges, and a wrong fact merge silently destroys one side's
 * provenance). v1 proposes merges only for:
 *  - `exact`: same subject + predicate, values equivalent under a
 *    case/whitespace/punctuation fold.
 *  - `restatement`: same subject + predicate, one folded value appears as a
 *    contiguous whole-token span inside the other, the shorter span carries
 *    at least MIN_RESTATEMENT_TOKENS tokens, and the longer value adds no
 *    *new* numeric token (an added number means a different facet — "2019"
 *    vs "2019 and 2022" — not a restatement).
 * Distinct values, sub-token substrings ("fast" ⊄ "fastify") and one-token
 * containments never merge. No embeddings anywhere.
 *
 * Proposals are suggestions only; applying them (supersede loser → winner,
 * audit trail) is the applier's job, exactly like suggestMerges' report-only
 * contract. Chains are blocked: a fact that loses once leaves the
 * candidate pool, so no proposal ever points at an already-lost winner.
 */

/** The slice of a fact the dedup pass reads — same structural-subset style
 *  as DreamFact in dream/contradiction-pass.ts. */
export interface FactDedupFact {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  /** ISO timestamp; unparseable values are treated as "unknown" in ranking. */
  readonly createdAt: string;
  /** Distinct sessions asserting this exact triple (FactHit.corroborationCount); absent = 1. */
  readonly corroborationCount?: number;
  /** Supersede/retire markers — an active fact carries neither. */
  readonly supersededBy?: string | null;
  readonly retiredAt?: string | null;
}

export type FactMergeClass = "exact" | "restatement";

export interface FactMergeProposal {
  readonly winnerId: string;
  readonly loserId: string;
  readonly cls: FactMergeClass;
  /** Deterministic, self-explanatory: class + evidence + why this one wins. */
  readonly reason: string;
}

/** A restatement's shorter value must carry at least this many whole tokens;
 *  below that, containment is too weak a signal ("port" ⊂ "port 5432 …"). */
export const MIN_RESTATEMENT_TOKENS = 2;

/** Fold for candidate keys and value equivalence: lowercase, every
 *  letter/number run kept, all other characters collapse to single spaces
 *  ("local-first." ≡ "Local First"). Stricter on subject/predicate, which
 *  extraction already normalizes: case + whitespace only. */
function foldValue(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function foldKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokens(folded: string): ReadonlyArray<string> {
  return folded === "" ? [] : folded.split(" ");
}

function isNumericToken(t: string): boolean {
  return /^\d+$/.test(t);
}

/** An active fact: not superseded, not retired, and all triple parts carry
 *  content after folding (a blank value is a data bug, not a merge input). */
export function isMergeEligible(fact: FactDedupFact): boolean {
  if (fact.supersededBy != null || fact.retiredAt != null) return false;
  return (
    foldKeyPart(fact.subject) !== "" &&
    foldKeyPart(fact.predicate) !== "" &&
    foldValue(fact.value) !== ""
  );
}

/** Does `inner` appear as a contiguous whole-token span of `outer`? */
function containsTokenSpan(
  outer: ReadonlyArray<string>,
  inner: ReadonlyArray<string>,
): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    let hit = true;
    for (let j = 0; j < inner.length; j++) {
      if (outer[i + j] !== inner[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** The restatement rule applied to two folded values of the same
 *  subject+predicate. Returns the (shorter, longer) pair when they are a
 *  restatement, null when they are distinct facets or too weak to merge. */
function restateMatch(
  foldedA: string,
  foldedB: string,
): { readonly shorter: string; readonly longer: string } | null {
  if (foldedA === foldedB) return null; // exact duplicates handled elsewhere
  const ta = tokens(foldedA);
  const tb = tokens(foldedB);
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (shorter.length < MIN_RESTATEMENT_TOKENS) return null;
  if (!containsTokenSpan(longer, shorter)) return null;
  // An added number on the longer side signals a different facet, not a
  // restatement: "windows server 2019" vs "windows server 2019 and 2022".
  const shortNums = new Set(shorter.filter(isNumericToken));
  if (longer.some((t) => isNumericToken(t) && !shortNums.has(t))) return null;
  return { shorter: shorter.join(" "), longer: longer.join(" ") };
}

/** Deterministic winner/loser: more corroborated wins; tie → newer
 *  createdAt wins (unknown timestamps rank lowest); tie → lexicographically
 *  smaller id. Mirrors dedup-suggest's pickTarget determinism style. */
function pickWinner(
  a: FactDedupFact,
  b: FactDedupFact,
): { readonly winner: FactDedupFact; readonly loser: FactDedupFact; readonly factor: string } {
  const ca = a.corroborationCount ?? 1;
  const cb = b.corroborationCount ?? 1;
  if (ca !== cb) {
    return ca > cb
      ? { winner: a, loser: b, factor: `corroboration ${ca}>${cb}` }
      : { winner: b, loser: a, factor: `corroboration ${cb}>${ca}` };
  }
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const ua = Number.isNaN(ta);
  const ub = Number.isNaN(tb);
  // Exactly one timestamp parseable: the parseable one outranks the unknown.
  if (ua !== ub) {
    return ua
      ? { winner: b, loser: a, factor: "newer createdAt" }
      : { winner: a, loser: b, factor: "newer createdAt" };
  }
  if (!ua && ta !== tb) {
    return ta > tb
      ? { winner: a, loser: b, factor: "newer createdAt" }
      : { winner: b, loser: a, factor: "newer createdAt" };
  }
  const [winner, loser] = a.id <= b.id ? [a, b] : [b, a];
  return { winner, loser, factor: "id tie-break" };
}

interface Candidate {
  readonly fact: FactDedupFact;
  readonly valueFolded: string;
}

/**
 * Propose merges from a flat list of facts.
 *
 * Groups by (subject, predicate) fold; within each group emits `exact`
 * proposals first, then `restatement` proposals among the survivors. A fact
 * that has lost once is excluded from every later pair (no chains, no
 * merging into a loser). Scan order and emission order are fully determined
 * by the group key and fact ids, so equal inputs always produce equal
 * output, independent of input order.
 */
export function proposeFactMerges(
  facts: ReadonlyArray<FactDedupFact>,
): ReadonlyArray<FactMergeProposal> {
  const groups = new Map<string, Candidate[]>();
  for (const fact of facts) {
    if (!isMergeEligible(fact)) continue;
    const key = `${foldKeyPart(fact.subject)}\u0000${foldKeyPart(fact.predicate)}`;
    if (!groups.has(key)) groups.set(key, []);
    // Later duplicates of the same id would produce self-pairs; first wins.
    const group = groups.get(key)!;
    if (!group.some((c) => c.fact.id === fact.id)) {
      group.push({ fact, valueFolded: foldValue(fact.value) });
    }
  }

  const proposals: FactMergeProposal[] = [];
  const lost = new Set<string>();

  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const members = [...groups.get(key)!].sort((a, b) =>
      a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0,
    );
    const [subject, predicate] = key.split("\u0000");

    for (const cls of ["exact", "restatement"] as const) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i]!;
          const b = members[j]!;
          if (lost.has(a.fact.id) || lost.has(b.fact.id)) continue;

          let evidence: { shorter: string; longer: string } | null;
          if (cls === "exact") {
            evidence =
              a.valueFolded === b.valueFolded
                ? { shorter: a.valueFolded, longer: b.valueFolded }
                : null;
          } else {
            evidence = restateMatch(a.valueFolded, b.valueFolded);
          }
          if (!evidence) continue;

          const { winner, loser, factor } = pickWinner(a.fact, b.fact);
          const evidenceText =
            cls === "exact"
              ? `equivalent values "${evidence.shorter}"`
              : `restatement "${evidence.shorter}" ⊂ "${evidence.longer}"`;
          proposals.push({
            winnerId: winner.id,
            loserId: loser.id,
            cls,
            reason:
              `fact-dedup ${cls}: "${subject} ${predicate}" — ${evidenceText};` +
              ` winner ${winner.id} over ${loser.id} by ${factor}`,
          });
          lost.add(loser.id);
        }
      }
    }
  }

  return proposals;
}
