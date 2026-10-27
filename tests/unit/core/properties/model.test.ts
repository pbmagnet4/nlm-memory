import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertionKey, attributeFacts, parseProperties } from "../../../../src/core/properties/model.js";
import { repositoryProperty } from "../../../../src/core/properties/repository.js";
import type { Fact } from "../../../../src/shared/types.js";
const catalog = parseProperties([{ slug: "nxtseo", label: "NxtSEO" }, { slug: "nxtads", label: "NxtAds" }]);
const fact: Fact = { id: "f", kind: "attribute", subject: "api", predicate: "port", value: "3940", sourceSessionId: "s", sourceQuote: "NxtSEO uses port 3940", createdAt: "2026-01-01", supersededBy: null, confidence: 1 };
describe("property evidence", () => {
  it("requires a verified literal and abstains on comparative evidence", () => {
    expect(attributeFacts([fact], catalog, [])[0]?.property).toBeUndefined();
    const verified = { ...fact, sourceAnchor: { status: "verified" as const, start: 0, end: 22, bodyVersion: "version" } };
    expect(attributeFacts([verified], catalog, [])[0]?.property?.slug).toBe("nxtseo");
    expect(attributeFacts([{ ...verified, sourceQuote: "NxtSEO and NxtAds use this API" }], catalog, [])[0]?.property).toBeUndefined();
  });
  it("does not trust an unquoted subject label from a mixed component discussion", () => {
    expect(attributeFacts([{ ...fact, subject: "nxtseo", sourceQuote: null, value: "8799" }], catalog, [])[0]?.property).toBeUndefined();
  });
  it("abstains when the verified quote names a different owner than the subject", () => {
    const conflicting = { ...fact, subject: "nxtseo", sourceQuote: "NxtAds uses port 3940", sourceAnchor: { status: "verified" as const, start: 0, end: 20, bodyVersion: "version" } };
    expect(attributeFacts([conflicting], catalog, [])[0]?.property).toBeUndefined();
  });
  it.each(["~/.nxtseo/cache", "NXTSEO_BRIDGE_META_ROBOTS", "io.nxtseo.worker", "bridge/nxtseo-file.php"])("does not infer ownership from namespace fragments: %s", (quote) => {
    const embedded = { ...fact, sourceQuote: quote, sourceAnchor: { status: "verified" as const, start: 0, end: quote.length, bodyVersion: "version" } };
    expect(attributeFacts([embedded], catalog, [])[0]?.property).toBeUndefined();
  });
  it("strips unvalidated automatic attribution when inference is disabled", () => {
    const inherited = { ...fact, property: { slug: "nxtseo", source: "subject" as const, evidence: "nxtseo" } };
    expect(attributeFacts([inherited], catalog, [], false)[0]?.property).toBeUndefined();
    expect(attributeFacts([{ ...inherited, property: { ...inherited.property, source: "explicit" } }], catalog, [], false)[0]?.property?.slug).toBe("nxtseo");
  });
  it("does not apply an old correction to duplicated assertions", () => {
    const corrected = attributeFacts([fact, { ...fact, id: "f2" }], catalog, [{ sourceIdentity: "runtime:id", assertionKey: assertionKey(fact), slug: "nxtseo" }]);
    expect(corrected.every((f) => f.property === undefined)).toBe(true);
  });
  it("recognizes a task worktree through the common git repository", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-repo-property-")); const repo = join(tmp, "repo"); const worktree = join(tmp, "task");
    try {
      execFileSync("git", ["init", "--quiet", repo]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", worktree]);
      const properties = parseProperties([{ slug: "project", label: "Project", repositories: [repo] }]);
      expect(repositoryProperty(worktree, properties)).toBe("project");
      const unrelatedParent = join(tmp, "unrelated-parent"); const nested = join(unrelatedParent, "nested");
      mkdirSync(unrelatedParent);
      execFileSync("git", ["init", "--quiet", nested]);
      expect(repositoryProperty(nested, parseProperties([{ slug: "parent", label: "Parent", repositories: [unrelatedParent] }]))).toBeNull();
      expect(repositoryProperty(worktree, [...properties, { ...properties[0]!, slug: "ambiguous" }])).toBeNull();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
