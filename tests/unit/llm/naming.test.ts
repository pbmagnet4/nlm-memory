import { describe, expect, it } from "vitest";
import { buildNamingSystemPrompt, parseLongestLabel } from "../../../src/llm/naming.js";
import type { WorkstreamCandidateHint } from "../../../src/ports/llm-client.js";

const TWO = [
  { label: "Alpha" },
  { label: "Beta" },
] satisfies ReadonlyArray<WorkstreamCandidateHint>;

describe("buildNamingSystemPrompt", () => {
  it("matches the exact ollama-client sys string for two candidates (no suffix)", () => {
    const result = buildNamingSystemPrompt(TWO);
    const expected =
      `You label a work session by which project it belongs to. Known projects:\n- Alpha\n- Beta\n` +
      `If it belongs to NONE of these, answer "none". Reply with ONLY the exact project name from the list, or "none".`;
    expect(result).toBe(expected);
  });

  it("matches the exact deepseek-client sys string for two candidates (with /no_think suffix)", () => {
    const result = buildNamingSystemPrompt(TWO, { noThinkSuffix: true });
    const expected =
      `You label a work session by which project it belongs to. Known projects:\n- Alpha\n- Beta\n` +
      `If it belongs to NONE of these, answer "none". Reply with ONLY the exact project name from the list, or "none". /no_think`;
    expect(result).toBe(expected);
  });

  it("emits no suffix when noThinkSuffix is false", () => {
    const result = buildNamingSystemPrompt(TWO, { noThinkSuffix: false });
    expect(result.endsWith("/no_think")).toBe(false);
  });

  it("handles a single candidate", () => {
    const result = buildNamingSystemPrompt([{ label: "NLM" }]);
    expect(result).toContain("- NLM\n");
  });
});

describe("parseLongestLabel", () => {
  const candidates: ReadonlyArray<WorkstreamCandidateHint> = [
    { label: "NLM" },
    { label: "NLM UI" },
  ];

  it("picks the longest matching label when a shorter label is a substring of a longer one", () => {
    expect(parseLongestLabel("nlm ui looks good", candidates)).toBe("NLM UI");
  });

  it("picks shorter label when only it matches", () => {
    expect(parseLongestLabel("worked on nlm today", candidates)).toBe("NLM");
  });

  it("returns null when reply is 'none'", () => {
    expect(parseLongestLabel("none", candidates)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(parseLongestLabel("unrelated reply", candidates)).toBeNull();
  });

  it("is case-insensitive on both the output and the candidate labels", () => {
    const mixed: ReadonlyArray<WorkstreamCandidateHint> = [{ label: "PolySignal" }];
    expect(parseLongestLabel("POLYSIGNAL is the answer", mixed)).toBe("PolySignal");
  });

  it("returns the original label casing, not the lowered match", () => {
    const result = parseLongestLabel("nlm ui", candidates);
    expect(result).toBe("NLM UI");
  });
});
