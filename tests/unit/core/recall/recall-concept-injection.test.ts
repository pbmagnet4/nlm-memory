// tests/unit/core/recall/recall-concept-injection.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../../../src/core/recall/recall-service.js";
import type { LearnerStore } from "../../../../src/ports/learner-store.js";
import { makeSession } from "../../../fixtures/sessions.js";

// Minimal store + llm so keyword recall returns one hit.
const store = {
  keywordSearch: async () => [{ sessionId: "s1", score: 1 }],
  semanticSearch: async () => [],
  resolveSuccessors: async () => new Map(),
  getByIds: async () => [makeSession({ id: "s1", label: "L", summary: "S" })],
  getWorkstreamIds: async () => new Map([["s1", "ws_1"]]),
} as never;
const llm = { embed: async () => ({ vector: new Float32Array(768), model: "m" }) } as never;

function learnerDeps(): { learners: LearnerStore; sessions: { getWorkstreamIds: (t: string, ids: ReadonlyArray<string>) => Promise<Map<string, string | null>> } } {
  return {
    learners: {
      listEnrollmentsByWorkstreams: async () => [{
        id: "enr_1", learnerId: "alex", courseId: "calculus", workstreamId: "ws_1",
        planRef: "p", planRevision: 1, planFingerprint: "fp",
        status: "active", completionHistory: [], createdAt: "t", updatedAt: "t",
      }],
      listEvents: async () => [{
        id: "ev-1", date: "2026-01-15", covered: ["math.chain-rule"], attempts: [],
        interpretation: "", nextStep: "Keep going.", createdAt: "t",
      }],
    } as unknown as LearnerStore,
    sessions: { getWorkstreamIds: async () => new Map([["s1", "ws_1"]]) },
  };
}

describe("RecallService learner-concept injection", () => {
  const prev = process.env["NLM_HOOK_INJECT_CONCEPTS"];
  beforeEach(() => { delete process.env["NLM_HOOK_INJECT_CONCEPTS"]; });
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_HOOK_INJECT_CONCEPTS"];
    else process.env["NLM_HOOK_INJECT_CONCEPTS"] = prev;
  });

  it("attaches relatedConcepts when opted in", async () => {
    const svc = new RecallService({ store, llm, learnerDeps: learnerDeps() });
    const res = await svc.search("team_local", { query: "chain rule", mode: "keyword", withRelatedConcepts: true });
    expect(res.relatedConcepts).toBeDefined();
    expect(res.relatedConcepts!.map((c) => [c.concept, c.status])).toEqual([["math.chain-rule", "exposed"]]);
  });

  it("omits relatedConcepts when not opted in", async () => {
    const svc = new RecallService({ store, llm, learnerDeps: learnerDeps() });
    const res = await svc.search("team_local", { query: "chain rule", mode: "keyword" });
    expect(res.relatedConcepts).toBeUndefined();
  });

  it("omits relatedConcepts when the kill switch is off", async () => {
    process.env["NLM_HOOK_INJECT_CONCEPTS"] = "0";
    const svc = new RecallService({ store, llm, learnerDeps: learnerDeps() });
    const res = await svc.search("team_local", { query: "chain rule", mode: "keyword", withRelatedConcepts: true });
    expect(res.relatedConcepts).toBeUndefined();
  });

  it("omits relatedConcepts when deps are not wired", async () => {
    const svc = new RecallService({ store, llm });
    const res = await svc.search("team_local", { query: "chain rule", mode: "keyword", withRelatedConcepts: true });
    expect(res.relatedConcepts).toBeUndefined();
  });
});
