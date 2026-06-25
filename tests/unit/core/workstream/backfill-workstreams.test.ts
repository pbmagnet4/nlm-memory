import { it, expect } from "vitest";
import { backfillWorkstreams } from "@core/workstream/backfill-workstreams.js";
import { decideWorkstreamByName } from "@core/workstream/name-match.js";

it("binds named sessions, abstains on none", async () => {
  const ws = [{ id: "ws_nlm", label: "NLM" }];
  const names = new Map<string, string | null>([["s1", "NLM"], ["s2", null]]);
  const bound: Array<[string, string]> = [];
  const res = await backfillWorkstreams({
    listSessions: async () => [{ sessionId: "s1", content: "a" }, { sessionId: "s2", content: "b" }],
    nameSession: async (id: string) => names.get(id) ?? null,
    decide: (named: string | null) => decideWorkstreamByName(named, ws, new Map()),
    setBinding: async (s: string, w: string) => { bound.push([s, w]); },
  });
  expect(res).toEqual({ considered: 2, bound: 1, skipped: 1 });
  expect(bound).toEqual([["s1", "ws_nlm"]]);
});
