import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { Session } from "../../../src/shared/types.js";

function appWith(opts: {
  session?: Session | null;
  workstreamId?: string | null;
  enrollments?: { learnerId: string; courseId: string; status: "active" | "completed" }[];
  events?: { id: string; date: string; covered: string[]; attempts: never[]; interpretation: string; nextStep: string }[];
  wired?: boolean;
}) {
  const wired = opts.wired ?? true;
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
    store: {
      getById: async () => (opts.session === undefined ? ({ id: "s1" }) as Session : opts.session),
    } as never,
    ...(wired
      ? {
          learnerRecall: {
            learners: {
              listEnrollmentsByWorkstreams: async () =>
                (opts.enrollments ?? []).map((e, i) => ({
                  id: `enr_${i}`, learnerId: e.learnerId, courseId: e.courseId,
                  workstreamId: opts.workstreamId ?? null, planRef: "p", planRevision: 1,
                  planFingerprint: "fp", status: e.status, completionHistory: [],
                  createdAt: "t", updatedAt: "t",
                })),
              listEvents: async () =>
                (opts.events ?? []).map((e) => ({ ...e, createdAt: `${e.date}T00:00:00Z` })),
            },
            sessions: {
              getWorkstreamIds: async () => new Map([["s1", opts.workstreamId ?? null]]),
            },
          },
        }
      : {}),
  } as never);
}

describe("GET /api/learner/by-session/:id", () => {
  it("returns enrollments and ranked concepts for a bound session", async () => {
    const app = appWith({
      workstreamId: "ws_1",
      enrollments: [{ learnerId: "alex", courseId: "calculus", status: "active" }],
      events: [
        { id: "ev-1", date: "2026-01-15", covered: ["math.chain-rule"], attempts: [], interpretation: "", nextStep: "Keep going." },
      ],
    });
    const res = await app.request("/api/learner/by-session/s1", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enrollments: { learnerId: string; courseId: string; status: string }[];
      concepts: { concept: string; status: string; attemptCount: number; nextStep: string | null }[];
    };
    expect(body.enrollments).toEqual([{ learnerId: "alex", courseId: "calculus", status: "active" }]);
    expect(body.concepts).toEqual([
      { concept: "math.chain-rule", status: "exposed", attemptCount: 0, nextStep: "Keep going." },
    ]);
  });

  it("returns empty arrays when nothing is bound (UI hides the section)", async () => {
    const app = appWith({ workstreamId: null });
    const res = await app.request("/api/learner/by-session/s1", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enrollments: [], concepts: [] });
  });

  it("404s for an unknown session", async () => {
    const app = appWith({ session: null, workstreamId: "ws_1" });
    const res = await app.request("/api/learner/by-session/nope", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(404);
  });

  it("404s when learner recall is not wired", async () => {
    const app = appWith({ wired: false });
    const res = await app.request("/api/learner/by-session/s1", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(404);
  });
});
