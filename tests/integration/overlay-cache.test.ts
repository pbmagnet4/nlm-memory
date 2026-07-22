import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { writeAction } from "../../src/core/actions/actions-log.js";
import { openQuestionId } from "../../src/core/actions/overlay.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SESSION_ID = "sess_cache_1";
const OPEN_TEXT = "Should we use pgvector?";

describe("overlay cache invalidation (sqlite)", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-overlaycache-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "t.db"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: SESSION_ID, open: [OPEN_TEXT] }));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a resolve_open action becomes visible after invalidateOverlayCache", async () => {
    const before = await storage.sessions.getByIds("team_local", [SESSION_ID]);
    expect(before[0]?.open?.some((q) => q === OPEN_TEXT)).toBe(true);
    writeAction(storage.sessions.rawDb(), "team_local", {
      kind: "resolve_open",
      subjectType: "open_question",
      subjectId: openQuestionId(SESSION_ID, OPEN_TEXT),
    });
    storage.sessions.invalidateOverlayCache();
    const after = await storage.sessions.getByIds("team_local", [SESSION_ID]);
    expect(after[0]?.open?.some((q) => q === OPEN_TEXT)).toBe(false);
  });

  it("the cache is live: a write without invalidation stays hidden until invalidated", async () => {
    await storage.sessions.getByIds("team_local", [SESSION_ID]); // populate cache
    writeAction(storage.sessions.rawDb(), "team_local", {
      kind: "resolve_open",
      subjectType: "open_question",
      subjectId: openQuestionId(SESSION_ID, OPEN_TEXT),
    });
    const stale = await storage.sessions.getByIds("team_local", [SESSION_ID]);
    expect(stale[0]?.open?.some((q) => q === OPEN_TEXT)).toBe(true); // cache still active
    storage.sessions.invalidateOverlayCache();
    const fresh = await storage.sessions.getByIds("team_local", [SESSION_ID]);
    expect(fresh[0]?.open?.some((q) => q === OPEN_TEXT)).toBe(false);
  });

  it("the cache expires after 30s without explicit invalidation (TTL backstop)", async () => {
    vi.useFakeTimers();
    try {
      await storage.sessions.getByIds("team_local", [SESSION_ID]); // populate cache
      writeAction(storage.sessions.rawDb(), "team_local", {
        kind: "resolve_open",
        subjectType: "open_question",
        subjectId: openQuestionId(SESSION_ID, OPEN_TEXT),
      });
      const stale = await storage.sessions.getByIds("team_local", [SESSION_ID]);
      expect(stale[0]?.open?.some((q) => q === OPEN_TEXT)).toBe(true);
      vi.advanceTimersByTime(31_000);
      const fresh = await storage.sessions.getByIds("team_local", [SESSION_ID]);
      expect(fresh[0]?.open?.some((q) => q === OPEN_TEXT)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
