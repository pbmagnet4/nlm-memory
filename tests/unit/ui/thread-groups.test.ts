import { describe, expect, it } from "vitest";
import { groupByReplaceChain } from "../../../src/ui/lib/thread-groups.js";
import type { DatasetSession } from "../../../src/ui/lib/dataset.js";

function makeSession(overrides: Partial<DatasetSession> & { id: string }): DatasetSession {
  return {
    date: "2026-06-10",
    started_at: "2026-06-10T10:00:00.000Z",
    ended_at: "2026-06-10T11:00:00.000Z",
    label: `Session ${overrides.id}`,
    summary: "",
    entities: [],
    decisions: [],
    decision_ids: [],
    open: [],
    open_questions: [],
    status: "closed",
    duration_min: 60,
    runtime: "claude-code",
    ...overrides,
  };
}

describe("groupByReplaceChain", () => {
  it("chain of 3 replaced + 1 live yields one group with 3 earlier versions", () => {
    // v1 → replaced by v2 → replaced by v3 → replaced by v4 (live)
    const v1 = makeSession({ id: "v1", status: "replaced", replaced_by: "v2", started_at: "2026-06-01T10:00:00.000Z" });
    const v2 = makeSession({ id: "v2", status: "replaced", replaces: "v1", replaced_by: "v3", started_at: "2026-06-02T10:00:00.000Z" });
    const v3 = makeSession({ id: "v3", status: "replaced", replaces: "v2", replaced_by: "v4", started_at: "2026-06-03T10:00:00.000Z" });
    const v4 = makeSession({ id: "v4", status: "closed", replaces: "v3", started_at: "2026-06-04T10:00:00.000Z" });

    const items = groupByReplaceChain([v1, v2, v3, v4]);

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe("group");
    if (item.kind !== "group") return;

    expect(item.group.live.id).toBe("v4");
    expect(item.group.earlier).toHaveLength(3);
    // Earlier versions are sorted oldest first.
    expect(item.group.earlier.map((s) => s.id)).toEqual(["v1", "v2", "v3"]);
  });

  it("superseded sessions are NOT grouped — they pass through as individual groups", () => {
    const live = makeSession({ id: "live1", status: "closed" });
    const sup = makeSession({ id: "sup1", status: "superseded" });
    const items = groupByReplaceChain([live, sup]);

    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("group");
    expect(items[1]!.kind).toBe("group");
    if (items[1]!.kind !== "group") return;
    expect(items[1]!.group.live.id).toBe("sup1");
    expect(items[1]!.group.earlier).toHaveLength(0);
  });

  it("orphan replaced session (no live successor in filtered set) renders ungrouped", () => {
    // v1 was replaced by v2 but v2 is not in the list (e.g. filtered out).
    const v1 = makeSession({ id: "v1", status: "replaced", replaced_by: "v2" });
    const items = groupByReplaceChain([v1]);

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("orphan");
    if (items[0]!.kind !== "orphan") return;
    expect(items[0]!.session.id).toBe("v1");
  });

  it("single live session with no predecessors yields one group with empty earlier", () => {
    const s = makeSession({ id: "s1", status: "closed" });
    const items = groupByReplaceChain([s]);

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("group");
    if (items[0]!.kind !== "group") return;
    expect(items[0]!.group.live.id).toBe("s1");
    expect(items[0]!.group.earlier).toHaveLength(0);
  });

  it("mixed list: replaced chain + superseded + live all in one call", () => {
    const old1 = makeSession({ id: "old1", status: "replaced", replaced_by: "current", started_at: "2026-05-01T00:00:00.000Z" });
    const current = makeSession({ id: "current", status: "closed", replaces: "old1", started_at: "2026-05-10T00:00:00.000Z" });
    const sup = makeSession({ id: "sup1", status: "superseded", started_at: "2026-05-05T00:00:00.000Z" });

    const items = groupByReplaceChain([old1, current, sup]);

    // old1 is subsumed into current's group; sup passes through as its own group.
    expect(items).toHaveLength(2);

    const groupItem = items.find((i) => i.kind === "group" && i.group.live.id === "current");
    expect(groupItem).toBeDefined();
    if (!groupItem || groupItem.kind !== "group") return;
    expect(groupItem.group.earlier).toHaveLength(1);
    expect(groupItem.group.earlier[0]!.id).toBe("old1");

    const supItem = items.find((i) => i.kind === "group" && i.group.live.id === "sup1");
    expect(supItem).toBeDefined();
    if (!supItem || supItem.kind !== "group") return;
    expect(supItem.group.earlier).toHaveLength(0);
  });

  it("preserves output ordering of non-replaced sessions from input", () => {
    const a = makeSession({ id: "a", status: "closed", started_at: "2026-06-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", status: "closed", started_at: "2026-06-02T00:00:00.000Z" });
    const c = makeSession({ id: "c", status: "closed", started_at: "2026-06-03T00:00:00.000Z" });

    const items = groupByReplaceChain([c, a, b]);
    const ids = items.filter((i) => i.kind === "group").map((i) => (i.kind === "group" ? i.group.live.id : ""));
    expect(ids).toEqual(["c", "a", "b"]);
  });
});
