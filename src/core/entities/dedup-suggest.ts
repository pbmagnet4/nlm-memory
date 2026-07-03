/**
 * Conservative lexical dedup suggestion for the entity table.
 *
 * No embedding similarity in v1: the workstream matcher falsification showed
 * lexical-adjacent-but-different entities are exactly where embeddings
 * over-merge. Start conservative; tighten only after adjudication data exists.
 */

export interface EntityInput {
  readonly canonical: string;
  readonly sessionCount: number;
  readonly status: string;
}

export interface MergeSuggestion {
  readonly source: string;
  readonly target: string;
  readonly cls: "safe" | "likely";
}

/**
 * Fold for safe-class comparison: lowercase, strip spaces, hyphens,
 * underscores, and dots.
 */
function safeFold(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]+/g, "");
}

// Checked against the already-folded form (hyphens stripped by safeFold).
const REPO_SUFFIXES_FOLDED = ["ts", "js", "py", "rs", "go"];

function stripRepoSuffix(folded: string): string {
  for (const suf of REPO_SUFFIXES_FOLDED) {
    if (folded.endsWith(suf) && folded.length > suf.length) {
      return folded.slice(0, -suf.length);
    }
  }
  return folded;
}

function isSingularPlural(a: string, b: string): boolean {
  return b === a + "s" || a === b + "s";
}

function isRepoSuffixPair(a: string, b: string): boolean {
  const baseA = stripRepoSuffix(a);
  const baseB = stripRepoSuffix(b);
  if (a === baseA && b === baseB) return false;
  return baseA === baseB;
}

/**
 * Pick the target: higher sessionCount wins; on tie, lexicographically smaller
 * canonical is the target (deterministic).
 */
function pickTarget(a: EntityInput, b: EntityInput): { target: EntityInput; source: EntityInput } {
  if (a.sessionCount !== b.sessionCount) {
    return a.sessionCount > b.sessionCount
      ? { target: a, source: b }
      : { target: b, source: a };
  }
  return a.canonical <= b.canonical
    ? { target: a, source: b }
    : { target: b, source: a };
}

/**
 * Suggest merge pairs from a flat list of entities.
 *
 * Groups by fold key, then checks likely patterns within each group.
 * Never suggests a pair twice; never chains (one target per group, all
 * remaining members are sources into that target).
 */
export function suggestMerges(
  entities: ReadonlyArray<EntityInput>,
): ReadonlyArray<MergeSuggestion> {
  const active = entities.filter((e) => e.status !== "retired");

  const safeGroups = new Map<string, EntityInput[]>();
  for (const e of active) {
    const key = safeFold(e.canonical);
    if (!safeGroups.has(key)) safeGroups.set(key, []);
    safeGroups.get(key)!.push(e);
  }

  // Emission-order invariant the CLI applier depends on: every pair that uses
  // an entity as TARGET is emitted before the (single) pair that consumes it as
  // SOURCE, so sequential application never merges into an already-retired row.
  // Reordering emissions (or applying suggestions out of list order) breaks this.
  const suggestions: MergeSuggestion[] = [];
  const consumedAsSource = new Set<string>();

  for (const group of safeGroups.values()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) => {
      if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
      return a.canonical <= b.canonical ? -1 : 1;
    });
    const target = sorted[0]!;

    for (let i = 1; i < sorted.length; i++) {
      const source = sorted[i]!;
      if (consumedAsSource.has(source.canonical)) continue;
      suggestions.push({ source: source.canonical, target: target.canonical, cls: "safe" });
      consumedAsSource.add(source.canonical);
    }
  }

  const activeNonSafe = active.filter((e) => !consumedAsSource.has(e.canonical));

  for (let i = 0; i < activeNonSafe.length; i++) {
    for (let j = i + 1; j < activeNonSafe.length; j++) {
      const a = activeNonSafe[i]!;
      const b = activeNonSafe[j]!;
      if (consumedAsSource.has(a.canonical) || consumedAsSource.has(b.canonical)) continue;

      const fa = safeFold(a.canonical);
      const fb = safeFold(b.canonical);

      const isLikely = isSingularPlural(fa, fb) || isRepoSuffixPair(fa, fb);
      if (!isLikely) continue;

      const { target, source } = pickTarget(a, b);
      suggestions.push({ source: source.canonical, target: target.canonical, cls: "likely" });
      consumedAsSource.add(source.canonical);
    }
  }

  return suggestions;
}
