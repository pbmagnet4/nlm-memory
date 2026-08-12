/**
 * coerceClassifyResult — defensive parser over raw LLM JSON output. Focuses
 * on the Phase B.2 facts[] additions; existing fields are covered by the
 * end-to-end OllamaClient tests.
 */

import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  PREDICATE_VOCABULARY,
  coerceClassifyResult,
  isEphemeralSubject,
  isNonAnswerValue,
} from "../../../../src/core/classifier/prompt.js";

describe("isEphemeralSubject", () => {
  it("flags per-run build artifacts seen accumulating duplicate active facts", () => {
    for (const s of [
      "tsc",
      "typecheck",
      "test suite",
      "tests",
      "npm test",
      "test-result",
      "commit",
      "commit-sha",
      "main",
      "task-2-review",
      "task-7",
      "security-review",
      "code-quality",
    ]) {
      expect(isEphemeralSubject(s), s).toBe(true);
    }
  });

  it("flags the whole task-<n>-<suffix> family, not just bare task ids", () => {
    for (const s of [
      "task-8-task-quality",
      "task-2-brief.md",
      "task-5-ats-bump-js-port",
      "task-3.1",
      "task-12b",
      "task-9-implementation",
      "task-10-pre-period",
      "task-405",
    ]) {
      expect(isEphemeralSubject(s), s).toBe(true);
    }
  });

  it("does NOT flag durable subjects that merely start with task", () => {
    for (const s of ["task-tracking", "task-master", "taskwarrior"]) {
      expect(isEphemeralSubject(s), s).toBe(false);
    }
  });

  it("does NOT flag durable project and infrastructure subjects", () => {
    for (const s of [
      "nlm-memory",
      "nxtos",
      "qdrant",
      "gtm-mcp",
      "navflow-repo",
      "cronic-repo",
      "whtnxt",
      "texas-land-tax",
    ]) {
      expect(isEphemeralSubject(s), s).toBe(false);
    }
  });

  it("normalizes case and surrounding whitespace before matching", () => {
    expect(isEphemeralSubject("  TSC  ")).toBe(true);
    expect(isEphemeralSubject("Test Suite")).toBe(true);
  });
});

describe("isNonAnswerValue", () => {
  it("flags failed-observation / null-result values seen polluting the store", () => {
    for (const v of [
      "ssh command executed but result not provided",
      "unconfirmed via failed search commands",
      "did not run due to missing logs/content-neuro-score/ directory",
      "failed (gemini: command not found)",
      "Chat ID not provided",
      "unconfirmed existence of hello@example.com",
      "unknown number of open tasks",
      "unknown",
      "n/a",
      "TBD",
    ]) {
      expect(isNonAnswerValue(v), v).toBe(true);
    }
  });

  it("does NOT flag legitimate characterized facts", () => {
    for (const v of [
      "Hono",
      "produces malformed JSON on create_record calls",
      "http://macpro:8080/v1",
      "$35/mo (Solo), $65/mo (Pro, 3 locations)",
      "Next.js + TypeScript",
      "running via pm2 on port 3940",
    ]) {
      expect(isNonAnswerValue(v), v).toBe(false);
    }
  });
});

describe("coerceClassifyResult — facts", () => {
  function baseFields() {
    return {
      label: "L",
      summary: "S",
      entities: [],
      decisions: [],
      open: [],
      confidence: 0.8,
    };
  }

  it("returns an empty facts array when the key is missing entirely", () => {
    expect(coerceClassifyResult(baseFields()).facts).toEqual([]);
  });

  it("returns an empty facts array when facts is not an array", () => {
    expect(
      coerceClassifyResult({ ...baseFields(), facts: "not-an-array" }).facts,
    ).toEqual([]);
  });

  it("normalizes subject + predicate to lowercase and trims value", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "NLM-Memory-TS", predicate: "Framework", value: "  Hono  " },
      ],
    });
    expect(out.facts).toEqual([
      { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
    ]);
  });

  it("drops facts about per-run build artifacts, keeping durable ones", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "attribute", subject: "tsc", predicate: "status", value: "clean" },
        { kind: "attribute", subject: "test suite", predicate: "status", value: "303 passed" },
        { kind: "attribute", subject: "commit", predicate: "version", value: "b2c81c7" },
        { kind: "attribute", subject: "nlm-memory", predicate: "model", value: "gemma-4-26b-a4b-qat" },
      ],
    });
    expect(out.facts).toEqual([
      { kind: "attribute", subject: "nlm-memory", predicate: "model", value: "gemma-4-26b-a4b-qat" },
    ]);
  });

  it("drops facts whose value is a non-answer / null result (NLM #325)", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "attribute", subject: "acme-app", predicate: "status", value: "unknown number of open tasks" },
        { kind: "decision", subject: "acme-app-location", predicate: "decided-on", value: "ssh command executed but result not provided" },
        { kind: "attribute", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts.map((f) => f.value)).toEqual(["Hono"]);
  });

  it("drops facts with predicates outside the closed vocabulary (no 'other' escape hatch)", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "x", predicate: "color-of-the-bikeshed", value: "blue" },
        { kind: "decision", subject: "x", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts.map((f) => f.predicate)).toEqual(["framework"]);
  });

  it("PREDICATE_VOCABULARY does not include 'other'", () => {
    // Removed in Phase B.5 after pilot showed `other` was 43% of writes and
    // almost all slop. Off-vocab facts now get dropped by the coercer rather
    // than forced into a catch-all bucket.
    expect(PREDICATE_VOCABULARY).not.toContain("other");
  });

  it("drops facts missing required fields (subject, predicate, value)", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "", predicate: "framework", value: "Hono" },
        { kind: "decision", subject: "x", predicate: "", value: "Hono" },
        { kind: "decision", subject: "x", predicate: "framework", value: "" },
        { kind: "decision", subject: "good", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts).toEqual([
      { kind: "decision", subject: "good", predicate: "framework", value: "Hono" },
    ]);
  });

  it("drops facts with an invalid kind", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "garbage", subject: "x", predicate: "framework", value: "Hono" },
        { kind: "attribute", subject: "x", predicate: "framework", value: "Hono" },
      ],
    });
    expect(out.facts.map((f) => f.kind)).toEqual(["attribute"]);
  });

  it("clamps sourceQuote to 500 chars and trims whitespace", () => {
    const long = " ".repeat(10) + "a".repeat(600) + " ".repeat(10);
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "x", predicate: "framework", value: "Hono", sourceQuote: long },
      ],
    });
    expect(out.facts[0]?.sourceQuote).toBe("a".repeat(500));
  });

  it("omits sourceQuote when blank or non-string", () => {
    const out = coerceClassifyResult({
      ...baseFields(),
      facts: [
        { kind: "decision", subject: "a", predicate: "framework", value: "v", sourceQuote: "   " },
        { kind: "decision", subject: "b", predicate: "framework", value: "v", sourceQuote: 42 },
      ],
    });
    expect(out.facts[0]?.sourceQuote).toBeUndefined();
    expect(out.facts[1]?.sourceQuote).toBeUndefined();
  });
});

describe("CLASSIFIER_SYSTEM_PROMPT", () => {
  it("includes the facts field in the requested JSON shape", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"facts"');
  });

  it("inlines the predicate vocabulary so the LLM sees the closed list", () => {
    for (const p of PREDICATE_VOCABULARY) {
      expect(CLASSIFIER_SYSTEM_PROMPT).toContain(p);
    }
  });
});
