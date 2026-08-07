import { describe, it, expect } from "vitest";
import { projectWiki } from "@core/wiki/project.js";
import { MemoryWikiWriter } from "@core/adapters/memory-wiki-writer.js";
import type { WikiConfig } from "@core/wiki/types.js";
import type { Fact } from "@shared/types.js";
import type { FactListFilter, SubjectStat } from "@ports/fact-store.js";

const config: WikiConfig = { minFacts: 2, minSessions: 2, linkBase: "http://127.0.0.1:3940" };
const TODAY = "2026-08-06";

function fact(id: string, subject: string, session: string): Fact {
  return {
    id,
    kind: "attribute",
    subject,
    predicate: `p-${id}`,
    value: `v-${id}`,
    sourceSessionId: session,
    sourceQuote: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededBy: null,
    confidence: 0.9,
  } as Fact;
}

function factsDeps(all: ReadonlyArray<Fact>) {
  return {
    async listSubjectStats(): Promise<ReadonlyArray<SubjectStat>> {
      const bySubject = new Map<string, Fact[]>();
      for (const f of all) {
        const arr = bySubject.get(f.subject) ?? [];
        arr.push(f);
        bySubject.set(f.subject, arr);
      }
      return [...bySubject].map(([subject, fs]) => ({
        subject,
        factCount: fs.length,
        sessionCount: new Set(fs.map((f) => f.sourceSessionId)).size,
      }));
    },
    async listForRecall(_t: string, filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
      return all.filter((f) => f.subject === filter.subject);
    },
  };
}

describe("projectWiki", () => {
  const corpus = [
    fact("f1", "alpha", "s1"),
    fact("f2", "alpha", "s2"),
    fact("f3", "beta", "s1"),
  ];

  it("writes qualifying pages plus index and log", async () => {
    const writer = new MemoryWikiWriter();
    const result = await projectWiki({ facts: factsDeps(corpus), writer }, "team_local", config, TODAY);
    expect([...(await writer.list())].sort()).toEqual(["alpha.md", "index.md", "log.md"]);
    expect(result.qualifying).toBe(1);
    expect(result.written).toBe(3);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const writer = new MemoryWikiWriter();
    const deps = { facts: factsDeps(corpus), writer };
    await projectWiki(deps, "team_local", config, TODAY);
    const second = await projectWiki(deps, "team_local", config, TODAY);
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(3);
  });

  it("removes a page whose subject fell below threshold", async () => {
    const writer = new MemoryWikiWriter();
    await projectWiki({ facts: factsDeps(corpus), writer }, "team_local", config, TODAY);
    const shrunk = [fact("f3", "beta", "s1")];
    const result = await projectWiki({ facts: factsDeps(shrunk), writer }, "team_local", config, TODAY);
    expect(await writer.list()).not.toContain("alpha.md");
    expect(result.removed).toBe(1);
  });

  it("reports zero coverage drift on a successful run", async () => {
    const writer = new MemoryWikiWriter();
    const result = await projectWiki({ facts: factsDeps(corpus), writer }, "team_local", config, TODAY);
    expect(result.coverageDrift).toBe(0);
  });

  it("produces an empty but valid tree for an empty corpus", async () => {
    const writer = new MemoryWikiWriter();
    const result = await projectWiki({ facts: factsDeps([]), writer }, "team_local", config, TODAY);
    expect(result.qualifying).toBe(0);
    expect([...(await writer.list())].sort()).toEqual(["index.md", "log.md"]);
  });

  it("merges a subject-vs-subject slug collision into one page rather than throwing", async () => {
    const colliding = [
      fact("f1", "a b", "s1"),
      fact("f2", "a b", "s2"),
      fact("f3", "a/b", "s1"),
      fact("f4", "a/b", "s2"),
    ];
    const writer = new MemoryWikiWriter();
    const result = await projectWiki(
      { facts: factsDeps(colliding), writer },
      "team_local",
      config,
      TODAY,
    );
    expect([...(await writer.list())].sort()).toEqual(["a-b.md", "index.md", "log.md"]);
    expect(result.qualifying).toBe(1);
  });

  it("rejects a qualifying subject named log rather than letting the generic log page overwrite it", async () => {
    const withReservedSubject = [
      fact("f1", "log", "s1"),
      fact("f2", "log", "s2"),
    ];
    const writer = new MemoryWikiWriter();
    await expect(
      projectWiki({ facts: factsDeps(withReservedSubject), writer }, "team_local", config, TODAY),
    ).rejects.toThrow(/collision/);
  });

  it("merges two spellings of one subject into one page instead of rejecting", async () => {
    // Both spellings must independently clear config's minFacts=2/minSessions=2
    // so the group genuinely has two selected members, not one that qualified
    // and one that selectSubjects already filtered out.
    const colliding = [
      fact("f1", "test-suite", "s1"),
      fact("f2", "test-suite", "s2"),
      fact("f3", "test suite", "s3"),
      fact("f4", "test suite", "s4"),
    ];
    const writer = new MemoryWikiWriter();
    const result = await projectWiki(
      { facts: factsDeps(colliding), writer },
      "team_local",
      config,
      TODAY,
    );
    expect([...(await writer.list())].sort()).toEqual(["index.md", "log.md", "test-suite.md"]);
    expect(result.qualifying).toBe(1);
  });

  it("counts qualifying as pages, not subjects, keeping coverageDrift at zero for a merged corpus", async () => {
    // Same two-member-group requirement as above: both spellings must clear
    // the threshold on their own so this exercises a real two-subject merge,
    // not a singleton group that happens to report qualifying=1 either way.
    const colliding = [
      fact("f1", "test-suite", "s1"),
      fact("f2", "test-suite", "s2"),
      fact("f3", "test suite", "s3"),
      fact("f4", "test suite", "s4"),
    ];
    const writer = new MemoryWikiWriter();
    const result = await projectWiki(
      { facts: factsDeps(colliding), writer },
      "team_local",
      config,
      TODAY,
    );
    expect(result.qualifying).toBe(1);
    expect(result.onDisk).toBe(1);
    expect(result.coverageDrift).toBe(0);
  });

  it("still rejects a subject slugging to a reserved name", async () => {
    const withReservedSubject = [fact("f1", "index", "s1"), fact("f2", "index", "s2")];
    const writer = new MemoryWikiWriter();
    await expect(
      projectWiki({ facts: factsDeps(withReservedSubject), writer }, "team_local", config, TODAY),
    ).rejects.toThrow(/collision/);
  });
});
