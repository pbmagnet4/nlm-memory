import { describe, expect, it } from "vitest";
import { fixReportLines } from "../../../src/cli/doctor-fix-report.js";
import type { FixReport } from "../../../src/core/integrity/check-invariants.js";

const empty: FixReport = {
  deletedSelfLoops: 0,
  restoredToClosed: 0,
  deletedGhostEmbeddings: 0,
  repairedDangling: [],
  supersededConflicts: [],
  deletedOrphanChunkIds: [],
};

describe("fixReportLines", () => {
  it("prints each applied I5b repair with its outcome", () => {
    const lines = fixReportLines({
      ...empty,
      repairedDangling: [
        { tenantId: "t", subject: "svc", predicate: "port", factId: "f1", supersededBy: null, alsoSuperseded: ["f0"] },
        { tenantId: "t", subject: "svc", predicate: "host", factId: "f2", supersededBy: "f3", alsoSuperseded: [] },
      ],
    });
    expect(lines).toEqual([
      "  fixed I5b: t svc | port: f1 returned to active, superseded f0",
      "  fixed I5b: t svc | host: f2 now superseded by f3",
    ]);
  });

  it("does not claim nothing was repaired when only I5b repairs ran", () => {
    const lines = fixReportLines({
      ...empty,
      repairedDangling: [{ tenantId: "t", subject: "s", predicate: "p", factId: "f1", supersededBy: null, alsoSuperseded: [] }],
    });
    expect(lines.join("\n")).not.toContain("nothing to repair");
  });

  it("reports nothing to repair for an empty report", () => {
    expect(fixReportLines(empty)).toEqual(["  --fix: nothing to repair"]);
  });
});
