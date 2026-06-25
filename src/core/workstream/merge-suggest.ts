import { normalizeLabel } from "./model.js";

export interface MergeSuggestInputItem {
  readonly id: string;
  readonly label: string;
  readonly entities: ReadonlyArray<string>;
  readonly sessionIds: ReadonlyArray<string>;
}

export interface MergeSuggestion {
  readonly aId: string; readonly aLabel: string;
  readonly bId: string; readonly bLabel: string;
  readonly score: number;
  readonly sharedEntities: number;
  readonly sharedSessions: number;
  readonly labelSimilarity: number;
}

function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): { shared: number; score: number } {
  const sa = new Set(a); const sb = new Set(b);
  let shared = 0;
  for (const x of sa) if (sb.has(x)) shared++;
  const union = sa.size + sb.size - shared;
  return { shared, score: union === 0 ? 0 : shared / union };
}

function levenshtein(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

function labelSimilarity(a: string, b: string): number {
  const na = normalizeLabel(a); const nb = normalizeLabel(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export function scoreMergePair(a: MergeSuggestInputItem, b: MergeSuggestInputItem): MergeSuggestion {
  const ent = jaccard(a.entities, b.entities);
  const sess = jaccard(a.sessionIds, b.sessionIds);
  const lab = labelSimilarity(a.label, b.label);
  const score = (ent.score + sess.score + lab) / 3;
  return {
    aId: a.id, aLabel: a.label, bId: b.id, bLabel: b.label,
    score, sharedEntities: ent.shared, sharedSessions: sess.shared, labelSimilarity: lab,
  };
}

/** All unordered pairs scoring >= minScore, ranked desc. Pure; O(n^2) over the (small) workstream set. */
export function suggestMerges(items: ReadonlyArray<MergeSuggestInputItem>, minScore: number): ReadonlyArray<MergeSuggestion> {
  const out: MergeSuggestion[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = scoreMergePair(items[i]!, items[j]!);
      if (s.score >= minScore) out.push(s);
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
