/**
 * Learner recall end-to-end (sqlite): enroll + record through the real stores,
 * then resolve concepts through pickRelatedConcepts the way the recall hook
 * does. Closes the fakes-only gap in the M4 unit tests — real SQL, real
 * summary derivation, real picker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { pickRelatedConcepts } from "../../src/core/recall/related-concepts.js";
import type { RecallHit } from "../../src/shared/types.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("learner recall (sqlite end-to-end)", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-learner-recall-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "test.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seedCourse(): Promise<void> {
    await storage.learners.initLearner("team_local", { id: "alex", label: "Alex" });
    await storage.workstreams.create("team_local", { id: "ws_1", label: "Course", scope: null });
    await storage.learners.enroll("team_local", {
      learnerId: "alex", courseId: "calculus", workstreamId: "ws_1",
      planRef: "p", planRevision: 1, planFingerprint: "fp",
    });
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    await storage.sessions.setWorkstreamBinding("team_local", "s1", "ws_1", "operator", null);
  }

  it("resolves ranked concepts for a bound session", async () => {
    await seedCourse();
    await storage.learners.recordEvent("team_local", "alex", "calculus", {
      id: "ev-1", date: "2026-01-15", covered: ["math.chain-rule"],
      attempts: [{
        concept: "math.chain-rule", task: "Differentiate (3x+1)^2.", response: "wrong.",
        result: "incorrect", help: "none", kind: "application",
      }],
      interpretation: "", nextStep: "Compare rates.",
    });
    const rows = await pickRelatedConcepts(
      "team_local",
      [{ id: "s1" } as RecallHit],
      { learners: storage.learners, sessions: storage.sessions },
    );
    expect(rows).toEqual([
      { concept: "math.chain-rule", status: "practicing", attemptCount: 1, nextStep: "Compare rates." },
    ]);
  });

  it("returns [] when the session has no bound enrollment", async () => {
    const rows = await pickRelatedConcepts(
      "team_local",
      [{ id: "s_nothing" } as RecallHit],
      { learners: storage.learners, sessions: storage.sessions },
    );
    expect(rows).toEqual([]);
  });
});
