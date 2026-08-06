/**
 * Assemble one PageRollup per selected subject.
 *
 * `related` links co-occurring subjects rather than entities. Entity pages do
 * not exist until P4, so entity wikilinks would render broken on every page;
 * a subject link points at a page this same run produces.
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
  slugs: ReadonlyMap<string, string>,
): Promise<ReadonlyArray<PageRollup>> {
  const pageSubjects = new Set(selected.map((s) => s.subject));

  const loaded = await Promise.all(
    selected.map(async (stat) => {
      const all = await deps.facts.listForRecall(tenantId, {
        subject: stat.subject,
        includeSuperseded: true,
      });
      const current = all.filter((f) => f.supersededBy === null);
      const superseded = all.filter((f) => f.supersededBy !== null);
      return { stat, current, superseded };
    }),
  );

  const subjectsBySession = new Map<string, Set<string>>();
  for (const { stat, current } of loaded) {
    for (const f of current) {
      let set = subjectsBySession.get(f.sourceSessionId);
      if (!set) {
        set = new Set<string>();
        subjectsBySession.set(f.sourceSessionId, set);
      }
      set.add(stat.subject);
    }
  }

  return loaded.map(({ stat, current, superseded }) => {
    const sessionIds = [...new Set(current.map((f) => f.sourceSessionId))].sort();
    const related = new Set<string>();
    for (const sid of sessionIds) {
      for (const other of subjectsBySession.get(sid) ?? []) {
        if (other !== stat.subject && pageSubjects.has(other)) related.add(other);
      }
    }
    return {
      subject: stat.subject,
      slug: slugs.get(stat.subject) ?? stat.subject,
      current: sortFacts(current),
      superseded: sortFacts(superseded),
      sessionIds,
      related: [...related].sort(),
    };
  });
}

function sortFacts(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  return facts.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
