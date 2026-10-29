import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertionKey, attributeFacts, parseProperties, sessionPropertyReferences } from "../../../../src/core/properties/model.js";
import { locateSourceAnchor } from "../../../../src/core/facts/source-anchor.js";
import { repositoryProperty } from "../../../../src/core/properties/repository.js";
import type { Fact } from "../../../../src/shared/types.js";
const catalog = parseProperties([{ slug: "nxtseo", label: "NxtSEO" }, { slug: "nxtads", label: "NxtAds" }]);
const fact: Fact = { id: "f", kind: "attribute", subject: "api", predicate: "port", value: "3940", sourceSessionId: "s", sourceQuote: "NxtSEO uses port 3940", createdAt: "2026-01-01", supersededBy: null, confidence: 1 };
describe("property evidence", () => {
  it("requires a verified literal and abstains on comparative evidence", () => {
    expect(attributeFacts([fact], catalog, [])[0]?.property).toBeUndefined();
    const verified = { ...fact, sourceAnchor: { status: "verified" as const, start: 0, end: 22, bodyVersion: "version" } };
    expect(attributeFacts([verified], catalog, [], true, null, fact.sourceQuote)[0]?.property?.slug).toBe("nxtseo");
    expect(attributeFacts([{ ...verified, sourceQuote: "NxtSEO and NxtAds use this API" }], catalog, [], true, null, "[user] NxtSEO and NxtAds use this API")[0]?.property).toBeUndefined();
  });
  it("does not trust an unquoted subject label from a mixed component discussion", () => {
    expect(attributeFacts([{ ...fact, subject: "nxtseo", sourceQuote: null, value: "8799" }], catalog, [])[0]?.property).toBeUndefined();
  });
  it("abstains when the verified quote names a different owner than the subject", () => {
    const conflicting = { ...fact, subject: "nxtseo", sourceQuote: "NxtAds uses port 3940", sourceAnchor: { status: "verified" as const, start: 0, end: 20, bodyVersion: "version" } };
    expect(attributeFacts([conflicting], catalog, [], true, null, `[user] ${conflicting.sourceQuote}`)[0]?.property).toBeUndefined();
  });
  it.each(["~/.nxtseo/cache", "NXTSEO_BRIDGE_META_ROBOTS", "io.nxtseo.worker", "bridge/nxtseo-file.php"])("does not infer ownership from namespace fragments: %s", (quote) => {
    const embedded = { ...fact, sourceQuote: quote, sourceAnchor: { status: "verified" as const, start: 0, end: quote.length, bodyVersion: "version" } };
    expect(attributeFacts([embedded], catalog, [], true, null, `[user] ${quote}`)[0]?.property).toBeUndefined();
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

// Fictional reproductions of the T1130 failure classes (issue #57). No private session content.
describe("property inference regressions", () => {
  const fictional = parseProperties([{ slug: "orbit-notes", label: "Orbit Notes" }, { slug: "pillar", label: "Pillar" }, { slug: "kestrel", label: "Kestrel" }]);
  const grounded = (body: string, quote: string, over: Partial<Fact> = {}): Fact => ({ id: "g", kind: "attribute", subject: "component", predicate: "behaviour", value: "v",
    sourceSessionId: "s", sourceQuote: quote, sourceAnchor: locateSourceAnchor(body, quote), createdAt: "2026-01-01", supersededBy: null, confidence: 1, ...over });
  const owner = (body: string, quote: string, over: Partial<Fact> = {}) => attributeFacts([grounded(body, quote, over)], fictional, [], true, null, body)[0]?.property;
  it("attributes a single unambiguous owner from a plain verified quote", () => {
    const body = "[user] Pillar stores drafts in SQLite.";
    expect(owner(body, "Pillar stores drafts in SQLite")).toEqual({ slug: "pillar", source: "source-quote", evidence: "Pillar stores drafts in SQLite" });
  });
  it.each([
    "Orbit Notes must install Pillar before first launch",
    "The desktop shell must install Pillar before first launch",
    "Orbit Notes depends on the Kestrel plugin for sync",
    "Packaging requires Kestrel to be present",
  ])("abstains on owner versus dependency: %s", (quote) => {
    expect(owner(`[user] ${quote}.`, quote)).toBeUndefined();
  });
  it("abstains when the fact value, not the quote, carries the dependency", () => {
    expect(owner("[user] The sync runs every five minutes.", "The sync runs every five minutes", { value: "install Pillar first" })).toBeUndefined();
  });
  it.each([
    "Orbit Notes dev server listens on localhost:4123",
    "Kestrel launch agent is io.example.kestrel-sync",
    "Kestrel task worktree lives at ~/worktrees/kestrel-t12",
    "Set KESTREL_SYNC_TOKEN before starting Kestrel",
    "Pillar reads settings from ./config/pillar.toml",
  ])("abstains on runtime namespace context: %s", (quote) => {
    expect(owner(`[user] ${quote}.`, quote)).toBeUndefined();
  });
  it.each([
    ["fenced transcript", "[user] Label the transcript below for ownership.\n```\n[assistant] Pillar stores drafts in SQLite.\n```\n\n[assistant] Labelled."],
    ["blockquoted transcript", "[user] Label this excerpt for ownership:\n> Pillar stores drafts in SQLite.\n\n[assistant] Labelled."],
    ["agents preamble", "[user] # AGENTS.md\nPillar stores drafts in SQLite.\n\n[user] Fix the login button."],
    ["environment listing", "[user] <environment_context>\nPillar stores drafts in SQLite.\n</environment_context>\n\n[user] Fix the login button."],
    ["tool result", "[assistant] [tool_use: Read]\n\n[user] [tool_result: transcript excerpt:\nPillar stores drafts in SQLite.\n]\n\n[assistant] Labelled."],
    ["tool action", "[assistant] [tool_action: grep Pillar stores drafts in SQLite.]\n\n[assistant] Done."],
  ])("never takes ownership from a quoted evaluation input: %s", (_, body) => {
    expect(owner(body, "Pillar stores drafts in SQLite")).toBeUndefined();
  });
  it("abstains when the source body is unavailable to check the quote region", () => {
    const body = "[user] Pillar stores drafts in SQLite.";
    expect(attributeFacts([grounded(body, "Pillar stores drafts in SQLite")], fictional, [], true, null)[0]?.property).toBeUndefined();
  });
  it("attributes each fact of a mixed-project session independently and never cross-assigns", () => {
    const body = "[user] Pillar stores drafts in SQLite. Kestrel syncs every five minutes. The editor autosaves often.";
    const facts = [
      grounded(body, "Pillar stores drafts in SQLite", { id: "a", subject: "Pillar" }),
      grounded(body, "Kestrel syncs every five minutes", { id: "b", subject: "storage" }),
      grounded(body, "Kestrel syncs every five minutes", { id: "c", subject: "Pillar", predicate: "interval" }),
      grounded(body, "The editor autosaves often", { id: "d", subject: "editor" }),
    ];
    expect(attributeFacts(facts, fictional, [], true, null, body).map((f) => f.property?.slug ?? null)).toEqual(["pillar", "kestrel", null, null]);
  });
  it("never attributes from the subject alone while inference is on", () => {
    const body = "[user] Drafts are stored in SQLite.";
    const { sourceAnchor: _, ...unquoted } = grounded(body, "Drafts are stored in SQLite");
    expect(attributeFacts([{ ...unquoted, subject: "Pillar", sourceQuote: null }], fictional, [], true, null, body)[0]?.property).toBeUndefined();
    expect(owner(body, "Drafts are stored in SQLite", { subject: "Pillar" })).toBeUndefined();
    expect(owner("[user] Pillar stores drafts in SQLite.", "Pillar stores drafts in SQLite", { subject: "Pillar" })?.source).toBe("source-quote");
  });
  it("ignores session entities whose only evidence lies inside quoted or preamble regions", () => {
    const body = [
      "[user] # AGENTS.md\nWorkspace projects: Orbit Notes.",
      "[user] <environment_context>\nKestrel\n</environment_context>",
      "[user] Compare these two transcripts.\n```\n[assistant] Kestrel syncs every five minutes.\n```\n> Orbit Notes stores drafts.",
      "[user] [tool_result: label card: Kestrel session about Kestrel sync]",
      "[assistant] Pillar now stores drafts in SQLite.",
    ].join("\n\n");
    expect(sessionPropertyReferences(["Orbit Notes", "Pillar", "Kestrel"], fictional, body)).toEqual([{ slug: "pillar", evidence: "Pillar" }]);
    expect(sessionPropertyReferences(["Pillar"], fictional, "[user] Fix the login button.")).toEqual([]);
    expect(sessionPropertyReferences(["Pillar"], fictional, null)).toEqual([]);
  });
});
