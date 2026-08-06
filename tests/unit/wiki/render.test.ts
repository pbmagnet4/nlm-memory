import { describe, it, expect } from "vitest";
import { renderPage, renderIndex, renderLog, renderAll } from "@core/wiki/render.js";
import type { PageRollup, WikiConfig } from "@core/wiki/types.js";
import type { Fact } from "@shared/types.js";

const config: WikiConfig = { minFacts: 3, minSessions: 3, linkBase: "http://127.0.0.1:3940" };
const TODAY = "2026-08-06";

function fact(over: Partial<Fact> & Pick<Fact, "id">): Fact {
  return {
    kind: "attribute",
    subject: "alpha",
    predicate: "runs-on",
    value: "sqlite",
    sourceSessionId: "s1",
    sourceQuote: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededBy: null,
    confidence: 0.9,
    ...over,
  } as Fact;
}

function page(over: Partial<PageRollup> = {}): PageRollup {
  return {
    subject: "alpha",
    slug: "alpha",
    current: [fact({ id: "f1" })],
    superseded: [],
    sessionIds: ["s1"],
    related: [],
    ...over,
  };
}

describe("renderPage", () => {
  it("writes to <slug>.md", () => {
    expect(renderPage(page(), config, TODAY).relPath).toBe("alpha.md");
  });

  it("carries the original subject in the title, not the slug", () => {
    const out = renderPage(page({ subject: "Whtnxt Agent", slug: "whtnxt-agent" }), config, TODAY);
    expect(out.content).toContain("title: Whtnxt Agent");
    expect(out.relPath).toBe("whtnxt-agent.md");
  });

  it("marks the page as generated in frontmatter", () => {
    const c = renderPage(page(), config, TODAY).content;
    expect(c).toContain("nlm_generated: true");
    expect(c).toContain("last_projected: 2026-08-06");
    expect(c).toContain("fact_count: 1");
    expect(c).toContain("session_count: 1");
    expect(c).toContain("superseded_count: 0");
  });

  it("warns that edits are overwritten", () => {
    expect(renderPage(page(), config, TODAY).content).toContain("Edits are overwritten");
  });

  it("renders a current fact with a block ref and a session link", () => {
    const c = renderPage(page(), config, TODAY).content;
    expect(c).toContain("## Current");
    expect(c).toContain("runs-on: sqlite");
    expect(c).toContain("^f1");
    expect(c).toContain("http://127.0.0.1:3940/thread/s1");
  });

  it("omits History when nothing was superseded", () => {
    expect(renderPage(page(), config, TODAY).content).not.toContain("## History");
  });

  it("renders History when facts were superseded", () => {
    const c = renderPage(
      page({ superseded: [fact({ id: "f0", value: "postgres", supersededBy: "f1" })] }),
      config,
      TODAY,
    ).content;
    expect(c).toContain("## History");
    expect(c).toContain("postgres");
  });

  it("omits Related when there are no related pages", () => {
    expect(renderPage(page(), config, TODAY).content).not.toContain("## Related");
  });

  it("renders Related as wikilinks to slugs", () => {
    const c = renderPage(page({ related: ["beta gamma"] }), config, TODAY).content;
    expect(c).toContain("## Related");
    expect(c).toContain("[[beta-gamma]]");
  });

  it("is byte-identical across two renders of the same input", () => {
    expect(renderPage(page(), config, TODAY).content).toBe(renderPage(page(), config, TODAY).content);
  });
});

describe("renderIndex", () => {
  it("writes to index.md and links every page", () => {
    const out = renderIndex([page(), page({ subject: "beta", slug: "beta" })], TODAY);
    expect(out.relPath).toBe("index.md");
    expect(out.content).toContain("[[alpha]]");
    expect(out.content).toContain("[[beta]]");
  });

  it("states the page count", () => {
    expect(renderIndex([page()], TODAY).content).toContain("1 page");
  });

  it("handles an empty corpus without crashing", () => {
    expect(renderIndex([], TODAY).content).toContain("0 pages");
  });
});

describe("renderLog", () => {
  it("writes to log.md", () => {
    expect(renderLog([page()], TODAY).relPath).toBe("log.md");
  });

  it("lists most recent facts first", () => {
    const older = fact({ id: "old", value: "first", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = fact({ id: "new", value: "second", createdAt: "2026-06-01T00:00:00.000Z" });
    const c = renderLog([page({ current: [older, newer] })], TODAY).content;
    expect(c.indexOf("second")).toBeLessThan(c.indexOf("first"));
  });
});

describe("renderAll", () => {
  it("returns one file per page plus index and log", () => {
    const out = renderAll([page(), page({ subject: "beta", slug: "beta" })], config, TODAY);
    expect([...out.map((f) => f.relPath)].sort()).toEqual(["alpha.md", "beta.md", "index.md", "log.md"]);
  });
});
