/**
 * Deterministic tests for the contradiction-findings → NxtWiki proposals
 * renderer (T1627). Synthetic findings only — no live corpus rows in
 * fixtures, no DB, no models.
 */
import { describe, expect, it } from "vitest";
import {
  allowMatches,
  draftFilename,
  parseAllow,
  parseArgs,
  queueFor,
  renderDraft,
  selectFindings,
  type ProposalFinding,
  type RunMeta,
} from "../../../scripts/eval/dream-contradiction-proposals.js";

const META: RunMeta = {
  generatedAt: "2026-11-09T17:33:26.307Z",
  model: "synthetic-judge-v1",
  sampleSize: 500,
  seed: 2,
};

function finding(over: Partial<ProposalFinding> = {}): ProposalFinding {
  return {
    factId: "fact_aaaa1111-0000-4000-8000-000000000000",
    subject: "synthetic-widget",
    predicate: "status",
    value: "live on public domain",
    sourceSessionId: "cc_synthetic000-0000-4000-8000-000000000000",
    verdict: "contradicted",
    evidenceQuote: "lifecycle_stage: building",
    model: "synthetic-judge-v1",
    ...over,
  };
}

describe("parseArgs", () => {
  it("parses input, allow list, labeled-by, and out-dir", () => {
    const args = parseArgs([
      "--input=reports/dream-contradiction-dryrun.json",
      "--allow=[\"fact_aaaa1111\"]",
      "--labeled-by=Edward Chalupa (2026-11-09)",
      "--out-dir=proposals",
    ]);
    expect(args.input).toBe("reports/dream-contradiction-dryrun.json");
    expect(args.allow).toEqual(["fact_aaaa1111"]);
    expect(args.labeledBy).toBe("Edward Chalupa (2026-11-09)");
    expect(args.outDir).toBe("proposals");
  });

  it("defaults out-dir and labeled-by, empty allow renders nothing", () => {
    const args = parseArgs(["--input=r.json"]);
    expect(args.allow).toEqual([]);
    expect(args.labeledBy).toBe("");
    expect(args.outDir).toBe(`${process.cwd()}/proposals`);
  });
});

describe("parseAllow", () => {
  it("accepts a JSON list of id strings", () => {
    expect(parseAllow('["fact_aaaa1111", "fact_bbbb2222"]')).toEqual([
      "fact_aaaa1111",
      "fact_bbbb2222",
    ]);
  });

  it("rejects non-list or non-string payloads as empty", () => {
    expect(parseAllow('{"fact_aaaa1111": true}')).toEqual([]);
    expect(parseAllow("fact_aaaa1111")).toEqual([]);
    expect(parseAllow("")).toEqual([]);
  });
});

describe("allowMatches", () => {
  it("matches exact ids and short-id prefixes", () => {
    expect(
      allowMatches("fact_aaaa1111-0000-4000-8000-000000000000", ["fact_aaaa1111"]),
    ).toBe(true);
    expect(
      allowMatches("fact_aaaa1111-0000-4000-8000-000000000000", [
        "fact_aaaa1111-0000-4000-8000-000000000000",
      ]),
    ).toBe(true);
  });

  it("never matches across different ids", () => {
    expect(allowMatches("fact_aaaa1111-2222", ["fact_bbbb2222"])).toBe(false);
    expect(allowMatches("fact_aaaa1111-2222", [])).toBe(false);
  });
});

describe("queueFor", () => {
  it("routes agent-like subjects to Agents/", () => {
    expect(queueFor("neuromarketing-analyst")).toBe("Agents");
  });

  it("defaults unclear subjects to Operations/", () => {
    expect(queueFor("journey-mode-fallback")).toBe("Operations");
    expect(queueFor("knxt-fm-deployment")).toBe("Operations");
  });
});

describe("draftFilename", () => {
  it("names drafts by sanitized subject plus the short fact id", () => {
    expect(draftFilename(finding())).toBe("synthetic-widget--aaaa1111.md");
  });
});

describe("renderDraft", () => {
  it("renders fact, evidence, provenance, human label, and guidance", () => {
    const body = renderDraft(finding(), META, "Edward Chalupa (2026-11-09)")!;
    expect(body).toContain("# Proposed:");
    expect(body).toContain("synthetic-widget");
    expect(body).toContain("fact_aaaa1111-0000-4000-8000-000000000000");
    expect(body).toContain("lifecycle_stage: building");
    expect(body).toContain("cc_synthetic000-0000-4000-8000-000000000000");
    expect(body).toContain("synthetic-judge-v1");
    expect(body).toContain("500");
    expect(body).toContain("TP");
    expect(body).toContain("Edward Chalupa (2026-11-09)");
    expect(body.toLowerCase()).toContain("adopt");
    expect(body.toLowerCase()).toContain("drop");
  });

  it("returns null when a grounding field is missing", () => {
    expect(renderDraft(finding({ evidenceQuote: "" }), META, "x")).toBeNull();
    expect(renderDraft(finding({ sourceSessionId: "" }), META, "x")).toBeNull();
    expect(renderDraft(finding({ value: "" }), META, "x")).toBeNull();
  });
});

describe("selectFindings", () => {
  it("keeps only allowlisted contradicted findings with grounding", () => {
    const keep = finding();
    const rows = selectFindings(
      {
        findings: [
          keep,
          finding({
            factId: "fact_bbbb2222-0000-4000-8000-000000000000",
            verdict: "contradicted",
          }),
          finding({
            factId: "fact_cccc3333-0000-4000-8000-000000000000",
            verdict: "still-true",
          }),
          finding({
            factId: "fact_dddd4444-0000-4000-8000-000000000000",
            verdict: "contradicted",
            evidenceQuote: "",
          }),
        ],
      },
      ["fact_aaaa1111", "fact_cccc3333", "fact_dddd4444"],
    );
    expect(rows.map((f) => f.factId)).toEqual([keep.factId]);
  });

  it("renders nothing when the allow list is empty", () => {
    expect(selectFindings({ findings: [finding()] }, [])).toEqual([]);
  });
});
