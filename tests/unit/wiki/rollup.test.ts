import { describe, it, expect } from "vitest";
import { rollupPages } from "@core/wiki/rollup.js";
import type { Fact } from "@shared/types.js";
import type { FactListFilter } from "@ports/fact-store.js";

function fact(over: Partial<Fact> & Pick<Fact, "id" | "subject" | "sourceSessionId">): Fact {
  return {
    kind: "attribute",
    predicate: "p",
    value: "v",
    sourceQuote: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededBy: null,
    confidence: 0.9,
    ...over,
  } as Fact;
}

function depsFrom(all: ReadonlyArray<Fact>) {
  return {
    facts: {
      async listForRecall(_t: string, filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
        return all.filter((f) => {
          if (filter.subject !== undefined && f.subject !== filter.subject) return false;
          if (filter.includeSuperseded !== true && f.supersededBy !== null) return false;
          return true;
        });
      },
    },
  };
}

describe("rollupPages", () => {
  it("splits current from superseded facts", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "a", sourceSessionId: "s2", supersededBy: "f1" }),
    ];
    const [page] = await rollupPages(
      depsFrom(all),
      "team_local",
      [{ subject: "a", factCount: 1, sessionCount: 1 }],
      new Map([["a", "a"]]),
    );
    expect(page!.current.map((f) => f.id)).toEqual(["f1"]);
    expect(page!.superseded.map((f) => f.id)).toEqual(["f2"]);
  });

  it("collects distinct contributing session ids from current facts", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "a", sourceSessionId: "s1", predicate: "q" }),
      fact({ id: "f3", subject: "a", sourceSessionId: "s2", predicate: "r" }),
    ];
    const [page] = await rollupPages(
      depsFrom(all),
      "team_local",
      [{ subject: "a", factCount: 3, sessionCount: 2 }],
      new Map([["a", "a"]]),
    );
    expect([...page!.sessionIds].sort()).toEqual(["s1", "s2"]);
  });

  it("relates subjects that share a session and are themselves pages", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "b", sourceSessionId: "s1" }),
      fact({ id: "f3", subject: "c", sourceSessionId: "s9" }),
    ];
    const slugs = new Map([["a", "a"], ["b", "b"]]);
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "a", factCount: 1, sessionCount: 1 },
        { subject: "b", factCount: 1, sessionCount: 1 },
      ],
      slugs,
    );
    expect(pages.find((p) => p.subject === "a")!.related).toEqual(["b"]);
    expect(pages.find((p) => p.subject === "b")!.related).toEqual(["a"]);
  });

  it("never relates a subject to itself", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "a", sourceSessionId: "s1", predicate: "q" }),
    ];
    const [page] = await rollupPages(
      depsFrom(all),
      "team_local",
      [{ subject: "a", factCount: 2, sessionCount: 1 }],
      new Map([["a", "a"]]),
    );
    expect(page!.related).toEqual([]);
  });

  it("never relates to a subject that did not earn a page", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "noise", sourceSessionId: "s1" }),
    ];
    const [page] = await rollupPages(
      depsFrom(all),
      "team_local",
      [{ subject: "a", factCount: 1, sessionCount: 1 }],
      new Map([["a", "a"]]),
    );
    expect(page!.related).toEqual([]);
  });

  it("orders current facts by createdAt ascending when supplied out of order", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1", createdAt: "2026-01-02T00:00:00.000Z" }),
      fact({
        id: "f2",
        subject: "a",
        sourceSessionId: "s1",
        predicate: "q",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const [page] = await rollupPages(
      depsFrom(all),
      "team_local",
      [{ subject: "a", factCount: 2, sessionCount: 1 }],
      new Map([["a", "a"]]),
    );
    expect(page!.current.map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  it("breaks a createdAt tie on id ascending when supplied out of order", async () => {
    const all = [
      fact({ id: "f2", subject: "a", sourceSessionId: "s1", predicate: "q" }),
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
    ];
    const [page] = await rollupPages(
      depsFrom(all),
      "team_local",
      [{ subject: "a", factCount: 2, sessionCount: 1 }],
      new Map([["a", "a"]]),
    );
    expect(page!.current.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});
