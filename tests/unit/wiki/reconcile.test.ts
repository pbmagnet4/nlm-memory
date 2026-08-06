import { describe, it, expect } from "vitest";
import { planReconcile } from "@core/wiki/reconcile.js";

const a = { relPath: "a.md", content: "A" };
const b = { relPath: "b.md", content: "B" };

describe("planReconcile", () => {
  it("writes everything when the tree is empty", () => {
    const plan = planReconcile([a, b], [], new Map());
    expect(plan.toWrite.map((f) => f.relPath)).toEqual(["a.md", "b.md"]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it("writes nothing when every file is byte-identical", () => {
    const plan = planReconcile([a, b], ["a.md", "b.md"], new Map([["a.md", "A"], ["b.md", "B"]]));
    expect(plan.toWrite).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it("rewrites only the file whose content changed", () => {
    const plan = planReconcile([a, b], ["a.md", "b.md"], new Map([["a.md", "A"], ["b.md", "STALE"]]));
    expect(plan.toWrite.map((f) => f.relPath)).toEqual(["b.md"]);
    expect(plan.unchanged).toBe(1);
  });

  it("removes a page that no longer qualifies", () => {
    const plan = planReconcile([a], ["a.md", "gone.md"], new Map([["a.md", "A"], ["gone.md", "X"]]));
    expect(plan.toRemove).toEqual(["gone.md"]);
  });

  it("removes everything when the corpus produces no pages", () => {
    const plan = planReconcile([], ["a.md", "b.md"], new Map());
    expect([...plan.toRemove].sort()).toEqual(["a.md", "b.md"]);
    expect(plan.toWrite).toEqual([]);
  });
});
