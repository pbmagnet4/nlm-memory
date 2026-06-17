/**
 * stripInjectedContext removes NLM's own recall pointer block from a transcript
 * before it is classified, closing the feedback loop where the classifier
 * extracted "facts" from injected recall output (NLM #325).
 */

import { describe, expect, it } from "vitest";
import { formatPointerBlock } from "../../../../src/core/hook/pointer-block.js";
import { stripInjectedContext } from "../../../../src/core/hook/strip-injected-context.js";

describe("stripInjectedContext", () => {
  it("removes a sessions-only pointer block, keeping the real prompt", () => {
    const block = formatPointerBlock([
      { id: "pi_019", label: "Acme location", startedAt: "2026-06-16", summary: "located at ~/projects/acme-app" },
    ]);
    const transcript = `${block}\n\npull up the acme-app project`;

    const out = stripInjectedContext(transcript);

    expect(out).not.toContain("Possibly-relevant prior sessions");
    expect(out).not.toContain("NLM tools:");
    expect(out).not.toContain("Acme location");
    expect(out).toContain("pull up the acme-app project");
  });

  it("removes the 'Known facts about top entities' variant", () => {
    const block = formatPointerBlock(
      [],
      [{ subject: "acme-app", predicate: "owner", value: "user", corroborationCount: 3 }],
    );
    const transcript = `${block}\n\nwhat is outstanding on acme-app`;

    const out = stripInjectedContext(transcript);

    expect(out).not.toContain("Known facts about top entities");
    expect(out).not.toContain("acme-app owner: user");
    expect(out).toContain("what is outstanding on acme-app");
  });

  it("removes a combined sessions + facts block in one pass", () => {
    const block = formatPointerBlock(
      [{ id: "cc_1", label: "Prior", startedAt: "2026-06-01" }],
      [{ subject: "x", predicate: "y", value: "z", corroborationCount: 1 }],
    );
    const transcript = `${block}\n\nreal user message`;

    const out = stripInjectedContext(transcript);

    expect(out).not.toContain("Possibly-relevant");
    expect(out).not.toContain("Known facts");
    expect(out).not.toContain("NLM tools:");
    expect(out.trim()).toBe("real user message");
  });

  it("removes multiple injected blocks across a multi-turn transcript", () => {
    const b1 = formatPointerBlock([{ id: "a", label: "A", startedAt: "2026-06-01" }]);
    const b2 = formatPointerBlock([{ id: "b", label: "B", startedAt: "2026-06-02" }]);
    const transcript = `${b1}\n\nfirst question\n\n${b2}\n\nsecond question`;

    const out = stripInjectedContext(transcript);

    expect(out).not.toContain("NLM tools:");
    expect(out).not.toContain("· A ");
    expect(out).not.toContain("· B ");
    expect(out).toContain("first question");
    expect(out).toContain("second question");
  });

  it("leaves a transcript with no injected block untouched", () => {
    const transcript = "just a normal conversation\nabout databases\n## My own heading";
    expect(stripInjectedContext(transcript)).toBe(transcript);
  });

  it("does not strip a dangling header that has no NLM tools footer (avoid eating real content)", () => {
    const transcript = "## Possibly-relevant prior sessions (nlm-memory)\n- a half-written note that is actually content";
    expect(stripInjectedContext(transcript)).toBe(transcript);
  });
});
