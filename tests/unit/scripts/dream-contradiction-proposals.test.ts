/**
 * Deterministic tests for the contradiction-findings → NxtWiki proposals
 * renderer (T1627). Synthetic findings only — no live corpus rows in
 * fixtures, no DB, no models.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowMatches,
  draftFilename,
  parseAllow,
  parseArgs,
  queueFor,
  renderDraft,
  selectFindings,
  writeDrafts,
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
      "--labeled-by=Reviewer A (2026-11-09)",
      "--out-dir=proposals",
    ]);
    expect(args.input).toBe("reports/dream-contradiction-dryrun.json");
    expect(args.allow).toEqual(["fact_aaaa1111"]);
    expect(args.labeledBy).toBe("Reviewer A (2026-11-09)");
    expect(args.outDir).toBe("proposals");
  });

  it("defaults out-dir, empty allow renders nothing", () => {
    const args = parseArgs(["--input=r.json", "--labeled-by=Reviewer A"]);
    expect(args.allow).toEqual([]);
    expect(args.outDir).toBe(`${process.cwd()}/proposals`);
  });

  it("refuses to run without an explicit labeler: no default attribution", () => {
    expect(() => parseArgs(["--input=r.json"])).toThrow(/--labeled-by/);
    expect(() => parseArgs(["--input=r.json", "--labeled-by=  "])).toThrow(/--labeled-by/);
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

  it("throws on short, bare-prefix, or empty allow entries", () => {
    const id = "fact_aaaa1111-0000-4000-8000-000000000000";
    expect(() => allowMatches(id, ["fact_"])).toThrow();
    expect(() => allowMatches(id, ["fact_aaa"])).toThrow();
    expect(() => allowMatches(id, [""])).toThrow();
  });

  it("matches a valid 13-char prefix and an exact full id", () => {
    const id = "fact_aaaa1111-0000-4000-8000-000000000000";
    expect(allowMatches(id, ["fact_aaaa1111"])).toBe(true);
    expect(allowMatches(id, [id])).toBe(true);
  });

  it("excludes non-matching ids under valid-length entries", () => {
    expect(
      allowMatches("fact_cccc3333-0000-4000-8000-000000000000", ["fact_aaaa1111"]),
    ).toBe(false);
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
    const body = renderDraft(finding(), META, "Reviewer A (2026-11-09)")!;
    expect(body).toContain("# Proposed:");
    expect(body).toContain("synthetic-widget");
    expect(body).toContain("fact_aaaa1111-0000-4000-8000-000000000000");
    expect(body).toContain("lifecycle_stage: building");
    expect(body).toContain("cc_synthetic000-0000-4000-8000-000000000000");
    expect(body).toContain("synthetic-judge-v1");
    expect(body).toContain("500");
    expect(body).toContain("TP");
    expect(body).toContain("Reviewer A (2026-11-09)");
    expect(body.toLowerCase()).toContain("adopt");
    expect(body.toLowerCase()).toContain("drop");
  });

  it("returns null when a grounding field is missing", () => {
    expect(renderDraft(finding({ evidenceQuote: "" }), META, "x")).toBeNull();
    expect(renderDraft(finding({ sourceSessionId: "" }), META, "x")).toBeNull();
    expect(renderDraft(finding({ value: "" }), META, "x")).toBeNull();
  });

  it("refuses a blank labeler instead of rendering an unattributed TP label", () => {
    expect(() => renderDraft(finding(), META, "")).toThrow(/labeler/);
    expect(() => renderDraft(finding(), META, "   ")).toThrow(/labeler/);
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

describe("writeDrafts", () => {
  it("throws on same-path collisions before writing either file", () => {
    const outDir = mkdtempSync(join(tmpdir(), "proposals-collision-"));
    const rows = [
      finding({ factId: "fact_aaaa1111-0000-4000-8000-000000000000" }),
      finding({ factId: "fact_aaaa1111-1111-4000-8000-000000000000" }),
    ];
    expect(() => writeDrafts(rows, META, { outDir, labeledBy: "x" })).toThrow();
    expect(existsSync(join(outDir, "Operations", "synthetic-widget--aaaa1111.md"))).toBe(
      false,
    );
  });

  it("skips existing files byte-identical and counts the skip", () => {
    const outDir = mkdtempSync(join(tmpdir(), "proposals-skip-"));
    const dir = join(outDir, "Operations");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "synthetic-widget--aaaa1111.md");
    const sentinel = "human-edited draft — do not clobber\n";
    writeFileSync(path, sentinel);
    const result = writeDrafts([finding()], META, { outDir, labeledBy: "x" });
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([path]);
    expect(readFileSync(path, "utf-8")).toBe(sentinel);
  });

  it("writes fresh paths normally", () => {
    const outDir = mkdtempSync(join(tmpdir(), "proposals-fresh-"));
    const result = writeDrafts([finding()], META, {
      outDir,
      labeledBy: "Reviewer A (2026-11-09)",
    });
    expect(result.skipped).toEqual([]);
    expect(result.written).toHaveLength(1);
    const body = readFileSync(result.written[0]!, "utf-8");
    expect(body).toContain("fact_aaaa1111-0000-4000-8000-000000000000");
    expect(body).toContain("TP");
  });
});
