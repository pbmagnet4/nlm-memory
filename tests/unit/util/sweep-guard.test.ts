import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateSweep, guardSweep } from "../../../src/core/util/sweep-guard.js";

describe("sweep guard (property style)", () => {
  let tmp: string;
  let auditPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sweep-"));
    auditPath = join(tmp, "sub", "sweep-audit.jsonl");
    delete process.env["NLM_SWEEP_OVERRIDE"];
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const sizes = [0, 1, 5, 10, 11, 25, 100, 1000];
  const lines = () =>
    existsSync(auditPath)
      ? readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  it("never allows crossing the share or floor without override, for every size and touch count", () => {
    for (const total of sizes) {
      for (let touching = 0; touching <= total; touching += Math.max(1, Math.floor(total / 20))) {
        const d = evaluateSweep({ sweep: "s", actor: "t", targetTotal: total, touching });
        const bound = total >= 10 && touching > 0 && (touching / total > 0.8 || total - touching < 1);
        expect(d.allowed).toBe(!bound);
        const forced = evaluateSweep({ sweep: "s", actor: "t", targetTotal: total, touching, override: true });
        expect(forced.allowed).toBe(true);
        expect(forced.overridden).toBe(bound);
      }
    }
  });

  it("honours custom share and floor", () => {
    expect(evaluateSweep({ sweep: "s", actor: "t", targetTotal: 100, touching: 50, maxShare: 0.4 }).allowed).toBe(false);
    expect(evaluateSweep({ sweep: "s", actor: "t", targetTotal: 100, touching: 90, maxShare: 1, minRemaining: 20 }).allowed).toBe(false);
  });

  it("writes exactly one audit line per call, with the right mode", () => {
    let n = 0;
    for (const total of sizes) {
      for (const touching of [0, Math.floor(total / 2), total]) {
        for (const dryRun of [true, false]) {
          const d = guardSweep({ sweep: "s", actor: "t", targetTotal: total, touching, dryRun, auditPath });
          n++;
          expect(lines()).toHaveLength(n);
          const last = lines()[n - 1];
          expect(last.mode).toBe(dryRun ? "dry-run" : d.allowed ? "applied" : "refused");
          expect(last.touching).toBe(touching);
          expect(last.targetTotal).toBe(total);
          expect(typeof last.ts).toBe("string");
        }
      }
    }
  });

  it("dry run reports the verdict but is never mode applied", () => {
    const d = guardSweep({ sweep: "s", actor: "t", targetTotal: 100, touching: 95, dryRun: true, auditPath });
    expect(d.mode).toBe("dry-run");
    expect(d.allowed).toBe(false);
  });

  it("env override allows and records it", () => {
    process.env["NLM_SWEEP_OVERRIDE"] = "1";
    const d = guardSweep({ sweep: "s", actor: "t", targetTotal: 100, touching: 100, auditPath });
    delete process.env["NLM_SWEEP_OVERRIDE"];
    expect(d.mode).toBe("applied");
    expect(lines()[0].overridden).toBe(true);
  });
});
