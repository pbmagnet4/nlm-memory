// Spike (T1612): unit tests for workstream wiki pages + Borges guard + flag.
import { describe, expect, it } from "vitest";
import type { Workstream } from "../../../../src/core/workstream/model.js";
import type { Fact, Session } from "../../../../src/shared/types.js";
import {
  BORGES_LIMIT,
  buildWorkstreamIndex,
  buildWorkstreamPage,
  checkBorgesGuard,
  isWorkstreamWikiEnabled,
  MIN_SESSIONS,
  workstreamSourceBytes,
} from "../../../../src/core/wiki/workstream-pages.js";

const workstream = (label: string): Workstream => ({
  id: `ws_${label}`,
  label,
  status: "active",
  mergedInto: null,
  createdAt: "2026-11-01T09:00:00Z",
  updatedAt: "2026-11-01T09:00:00Z",
  lastSessionAt: "2026-11-01T11:00:00Z",
  scope: null,
});

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  runtime: "spike-test",
  runtimeSessionId: id,
  startedAt: "2026-11-01T10:00:00Z",
  endedAt: "2026-11-01T11:00:00Z",
  durationMin: 60,
  label: `Session ${id}`,
  summary: `summary ${id}`,
  status: "closed",
  transcriptKind: "spike",
  transcriptPath: null,
  body: `body ${id}`,
  entities: [],
  decisions: [],
  open: [],
  ...overrides,
});

const fact = (id: string, kind: Fact["kind"], value: string, sid: string): Fact => ({
  id,
  kind,
  subject: "spike-subject",
  predicate: "spike-predicate",
  value,
  sourceSessionId: sid,
  sourceQuote: null,
  createdAt: "2026-11-01T10:00:00Z",
  supersededBy: null,
  confidence: 0.9,
  retiredAt: null,
});

describe("isWorkstreamWikiEnabled", () => {
  it("is off by default", () => {
    expect(isWorkstreamWikiEnabled({})).toBe(false);
  });
  it("is on for 1/true only", () => {
    expect(isWorkstreamWikiEnabled({ NLM_WIKI_WORKSTREAM: "1" })).toBe(true);
    expect(isWorkstreamWikiEnabled({ NLM_WIKI_WORKSTREAM: "true" })).toBe(true);
    expect(isWorkstreamWikiEnabled({ NLM_WIKI_WORKSTREAM: "yes" })).toBe(false);
    expect(isWorkstreamWikiEnabled({ NLM_WIKI_WORKSTREAM: "" })).toBe(false);
  });
});

describe("buildWorkstreamPage", () => {
  it(`returns null below the ${MIN_SESSIONS}-session threshold`, () => {
    const s = session("s1", { decisions: ["decided x"] });
    expect(buildWorkstreamPage({ workstream: workstream("w"), sessions: [s], facts: [] })).toBeNull();
  });
  it("returns null when there is nothing worth saying", () => {
    const sessions = [session("s1"), session("s2")];
    expect(buildWorkstreamPage({ workstream: workstream("w"), sessions, facts: [] })).toBeNull();
  });
  it("renders decisions, open loops, key facts, and session links", () => {
    const sessions = [
      session("s1", { decisions: ["use postgres"] }),
      session("s2", { open: ["pick a cache"] }),
    ];
    const facts = [fact("f1", "attribute", "ttl 60s", "s2")];
    const page = buildWorkstreamPage({ workstream: workstream("billing"), sessions, facts });
    expect(page).not.toBeNull();
    expect(page!.relPath).toBe("ws-billing.md");
    expect(page!.content).toContain("## Decisions");
    expect(page!.content).toContain("use postgres");
    expect(page!.content).toContain("## Open loops");
    expect(page!.content).toContain("pick a cache");
    expect(page!.content).toContain("## Key facts");
    expect(page!.content).toContain("ttl 60s");
    expect(page!.content).toContain("`session:s1`");
    expect(page!.content).toContain("`session:s2`");
    expect(page!.content).not.toMatch(/https?:\/\//);
  });
  it("excludes superseded facts from the page", () => {
    const sessions = [session("s1", { decisions: ["keep me"] }), session("s2")];
    const stale: Fact = { ...fact("f9", "decision", "stale choice", "s1"), supersededBy: "f1" };
    const page = buildWorkstreamPage({ workstream: workstream("w"), sessions, facts: [stale] });
    expect(page!.content).not.toContain("stale choice");
  });
});

describe("buildWorkstreamIndex", () => {
  it("lists every page with a stable relPath", () => {
    const page = buildWorkstreamPage({
      workstream: workstream("billing"),
      sessions: [session("s1", { decisions: ["d"] }), session("s2")],
      facts: [],
    })!;
    const index = buildWorkstreamIndex([{ workstream: workstream("billing"), page }], "2026-11-09");
    expect(index.relPath).toBe("ws-index.md");
    expect(index.content).toContain("billing");
  });
});

describe("checkBorgesGuard", () => {
  it(`passes below the ${BORGES_LIMIT}x limit and fails at/above it`, () => {
    expect(checkBorgesGuard(499, 1000).pass).toBe(true);
    expect(checkBorgesGuard(500, 1000).pass).toBe(false);
    expect(checkBorgesGuard(900, 1000).pass).toBe(false);
  });
  it("fails on empty source", () => {
    expect(checkBorgesGuard(0, 0).pass).toBe(false);
  });
  it("source bytes grow with session content", () => {
    const a = workstreamSourceBytes([session("s1")]);
    const b = workstreamSourceBytes([session("s1", { body: "x".repeat(1000) })]);
    expect(b).toBeGreaterThan(a);
  });
});
