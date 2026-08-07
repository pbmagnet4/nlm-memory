/**
 * Assemble one PageRollup per slug group.
 *
 * A group with more than one member is a merge: colliding spellings of one
 * concept, already resolved by buildSlugGroups. This stage picks a canonical
 * spelling, unions the group's facts (deduplicated by id, since the same
 * fact must never render twice), and lists the rest as aliases.
 *
 * `related` links co-occurring subjects rather than entities. Entity pages do
 * not exist until P4, so entity wikilinks would render broken on every page;
 * a subject link points at a page this same run produces, and always names
 * the canonical spelling so the link never points at an alias.
 */
import type { FactStore, SubjectStat } from "@ports/fact-store.js";
import type { Fact } from "@shared/types.js";
import type { PageRollup } from "./types.js";

export interface RollupDeps {
  readonly facts: Pick<FactStore, "listForRecall">;
}

export async function rollupPages(
  deps: RollupDeps,
  tenantId: string,
  selected: ReadonlyArray<SubjectStat>,
  groups: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<ReadonlyArray<PageRollup>> {
  const currentFactCountBySubject = new Map(selected.map((s) => [s.subject, s.factCount]));

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  const loaded = await Promise.all(
    sortedGroups.map(async ([slug, members]) => {
      const perMember = await Promise.all(
        members.map((subject) =>
          deps.facts.listForRecall(tenantId, { subject, includeSuperseded: true }),
        ),
      );
      const deduped = dedupeById(perMember.flat());
      const current = deduped.filter((f) => f.supersededBy === null);
      const superseded = deduped.filter((f) => f.supersededBy !== null);

      const orderedMembers = members
        .slice()
        .sort((a, b) => compareCanonical(a, b, slug, currentFactCountBySubject));
      const subject = orderedMembers[0]!;
      const aliases = orderedMembers.slice(1).sort((a, b) => a.localeCompare(b));

      return { slug, subject, aliases, current, superseded };
    }),
  );

  const subjectsBySession = new Map<string, Set<string>>();
  for (const { subject, current } of loaded) {
    for (const f of current) {
      let set = subjectsBySession.get(f.sourceSessionId);
      if (!set) {
        set = new Set<string>();
        subjectsBySession.set(f.sourceSessionId, set);
      }
      set.add(subject);
    }
  }

  return loaded.map(({ slug, subject, aliases, current, superseded }) => {
    const sessionIds = [...new Set(current.map((f) => f.sourceSessionId))].sort();
    const related = new Set<string>();
    for (const sid of sessionIds) {
      for (const other of subjectsBySession.get(sid) ?? []) {
        if (other !== subject) related.add(other);
      }
    }
    return {
      subject,
      slug,
      aliases,
      current: sortFacts(current),
      superseded: sortFacts(superseded),
      sessionIds,
      related: [...related].sort(),
    };
  });
}

/**
 * Canonical spelling within a group: most current facts wins; a tie where
 * exactly one spelling equals the slug is broken in its favor; any remaining
 * tie falls to localeCompare. A strict total order, so sorting members with
 * it and taking the first element is deterministic regardless of input
 * order.
 *
 * `a` and `b` are always group members, and every group member is drawn
 * from `selected` (buildSlugGroups is only ever called on
 * `selected.map(s => s.subject)`), which is exactly what populates
 * `currentFactCountBySubject`. The lookup can't miss, so a non-null
 * assertion documents that instead of a `?? 0` fallback masking a case that
 * never occurs.
 */
function compareCanonical(
  a: string,
  b: string,
  slug: string,
  currentFactCountBySubject: ReadonlyMap<string, number>,
): number {
  const countA = currentFactCountBySubject.get(a)!;
  const countB = currentFactCountBySubject.get(b)!;
  if (countA !== countB) return countB - countA;
  const aIsSlug = a === slug;
  const bIsSlug = b === slug;
  if (aIsSlug !== bIsSlug) return aIsSlug ? -1 : 1;
  return a.localeCompare(b);
}

function dedupeById(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  const byId = new Map<string, Fact>();
  for (const f of facts) byId.set(f.id, f);
  return [...byId.values()];
}

function sortFacts(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  return facts.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
