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
      new Map([["a", ["a"]]]),
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
      new Map([["a", ["a"]]]),
    );
    expect([...page!.sessionIds].sort()).toEqual(["s1", "s2"]);
  });

  it("relates subjects that share a session and are themselves pages", async () => {
    const all = [
      fact({ id: "f1", subject: "a", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "b", sourceSessionId: "s1" }),
      fact({ id: "f3", subject: "c", sourceSessionId: "s9" }),
    ];
    const groups = new Map([
      ["a", ["a"]],
      ["b", ["b"]],
    ]);
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "a", factCount: 1, sessionCount: 1 },
        { subject: "b", factCount: 1, sessionCount: 1 },
      ],
      groups,
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
      new Map([["a", ["a"]]]),
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
      new Map([["a", ["a"]]]),
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
      new Map([["a", ["a"]]]),
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
      new Map([["a", ["a"]]]),
    );
    expect(page!.current.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("merges a colliding group into one PageRollup whose current holds facts from both spellings", async () => {
    const all = [
      fact({ id: "f1", subject: "qwen3.5-4b", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "qwen3.5-4b", sourceSessionId: "s2", predicate: "q" }),
      fact({ id: "f3", subject: "qwen3.5:4b", sourceSessionId: "s3", predicate: "r" }),
    ];
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "qwen3.5-4b", factCount: 2, sessionCount: 2 },
        { subject: "qwen3.5:4b", factCount: 1, sessionCount: 1 },
      ],
      new Map([["qwen3.5-4b", ["qwen3.5-4b", "qwen3.5:4b"]]]),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.current.map((f) => f.id).sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("does not duplicate a fact id appearing under both spellings", async () => {
    const shared = fact({ id: "shared", subject: "qwen3.5-4b", sourceSessionId: "s1" });
    const dup = { ...shared, subject: "qwen3.5:4b" };
    const pages = await rollupPages(
      depsFrom([shared, dup]),
      "team_local",
      [
        { subject: "qwen3.5-4b", factCount: 1, sessionCount: 1 },
        { subject: "qwen3.5:4b", factCount: 1, sessionCount: 1 },
      ],
      new Map([["qwen3.5-4b", ["qwen3.5-4b", "qwen3.5:4b"]]]),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.current.map((f) => f.id)).toEqual(["shared"]);
  });

  it("holds exactly the non-canonical spellings as aliases, empty for an unmerged page", async () => {
    const all = [
      fact({ id: "f1", subject: "qwen3.5-4b", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "qwen3.5:4b", sourceSessionId: "s2" }),
      fact({ id: "f3", subject: "solo", sourceSessionId: "s3" }),
    ];
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "qwen3.5-4b", factCount: 1, sessionCount: 1 },
        { subject: "qwen3.5:4b", factCount: 1, sessionCount: 1 },
        { subject: "solo", factCount: 1, sessionCount: 1 },
      ],
      new Map([
        ["qwen3.5-4b", ["qwen3.5-4b", "qwen3.5:4b"]],
        ["solo", ["solo"]],
      ]),
    );
    const merged = pages.find((p) => p.slug === "qwen3.5-4b")!;
    const unmerged = pages.find((p) => p.slug === "solo")!;
    expect(merged.aliases).toEqual(["qwen3.5:4b"]);
    expect(unmerged.aliases).toEqual([]);
  });

  it("canonical selection: the spelling with the most current facts wins, inputs supplied out of order", async () => {
    const all = [
      fact({ id: "f1", subject: "test-suite", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "test suite", sourceSessionId: "s2", predicate: "q" }),
      fact({ id: "f3", subject: "test suite", sourceSessionId: "s3", predicate: "r" }),
    ];
    // Group members and stats both supplied with the lower-count spelling first.
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "test-suite", factCount: 1, sessionCount: 1 },
        { subject: "test suite", factCount: 2, sessionCount: 2 },
      ],
      new Map([["test-suite", ["test-suite", "test suite"]]]),
    );
    expect(pages[0]!.subject).toBe("test suite");
    expect(pages[0]!.aliases).toEqual(["test-suite"]);
  });

  it("canonical selection: a fact-count tie is broken by exact slug equality", async () => {
    const all = [
      fact({ id: "f1", subject: "whtnxt agent", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "whtnxt-agent", sourceSessionId: "s2" }),
    ];
    // Both spellings tie at one current fact each; "whtnxt-agent" equals the
    // slug exactly and must win regardless of input order.
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "whtnxt agent", factCount: 1, sessionCount: 1 },
        { subject: "whtnxt-agent", factCount: 1, sessionCount: 1 },
      ],
      new Map([["whtnxt-agent", ["whtnxt agent", "whtnxt-agent"]]]),
    );
    expect(pages[0]!.subject).toBe("whtnxt-agent");
    expect(pages[0]!.aliases).toEqual(["whtnxt agent"]);
  });

  it("canonical selection: remaining ties break on localeCompare, neither spelling equal to the slug", async () => {
    const all = [
      fact({ id: "f1", subject: "zeta form", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "alpha form", sourceSessionId: "s2" }),
    ];
    // Both tie at one fact each, and neither equals the slug "alpha-form" nor
    // "zeta-form" is a real reserved match here, so localeCompare decides.
    // Group them under a slug neither spelling equals exactly.
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "zeta form", factCount: 1, sessionCount: 1 },
        { subject: "alpha form", factCount: 1, sessionCount: 1 },
      ],
      new Map([["form-group", ["zeta form", "alpha form"]]]),
    );
    expect(pages[0]!.subject).toBe("alpha form");
    expect(pages[0]!.aliases).toEqual(["zeta form"]);
  });

  it("sessionIds is the deduplicated union across the group", async () => {
    const all = [
      fact({ id: "f1", subject: "qwen3.5-4b", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "qwen3.5:4b", sourceSessionId: "s1", predicate: "q" }),
      fact({ id: "f3", subject: "qwen3.5:4b", sourceSessionId: "s2", predicate: "r" }),
    ];
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "qwen3.5-4b", factCount: 1, sessionCount: 1 },
        { subject: "qwen3.5:4b", factCount: 2, sessionCount: 2 },
      ],
      new Map([["qwen3.5-4b", ["qwen3.5-4b", "qwen3.5:4b"]]]),
    );
    expect([...pages[0]!.sessionIds].sort()).toEqual(["s1", "s2"]);
  });

  it("related names canonical spellings only, never an alias", async () => {
    const all = [
      fact({ id: "f1", subject: "qwen3.5-4b", sourceSessionId: "s1" }),
      fact({ id: "f2", subject: "qwen3.5:4b", sourceSessionId: "s1", predicate: "q" }),
      fact({ id: "f3", subject: "other", sourceSessionId: "s1", predicate: "z" }),
    ];
    const pages = await rollupPages(
      depsFrom(all),
      "team_local",
      [
        { subject: "qwen3.5-4b", factCount: 1, sessionCount: 1 },
        { subject: "qwen3.5:4b", factCount: 1, sessionCount: 1 },
        { subject: "other", factCount: 1, sessionCount: 1 },
      ],
      new Map([
        ["qwen3.5-4b", ["qwen3.5-4b", "qwen3.5:4b"]],
        ["other", ["other"]],
      ]),
    );
    const merged = pages.find((p) => p.slug === "qwen3.5-4b")!;
    const other = pages.find((p) => p.slug === "other")!;
    expect(merged.related).toEqual(["other"]);
    expect(other.related).toEqual(["qwen3.5-4b"]);
    expect(other.related).not.toContain("qwen3.5:4b");
  });
});
