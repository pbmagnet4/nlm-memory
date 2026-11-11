/**
 * T1729 — dreaming settings persistence.
 *
 * Covers the three rules the Dreaming page depends on:
 *  - load order at startup: the stored row wins, env is the fallback (fresh
 *    install, unreadable row, or a row this module refuses to read);
 *  - updateDreamSettings writes the whole document through the attached store;
 *  - the contradiction APPLY gate is not something a stored row can walk past:
 *    a row saying "apply" loads as dry-run while the gate has not passed.
 *
 * The store is the real SqliteDreamSettingsStore over migrated databases, so
 * the JSON round trip and the migration are covered too.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "@core/storage/sqlite-storage.js";
import {
  attachDreamSettingsStore,
  CONTRADICTION_APPLY_GATE,
  DEFAULT_CONTRADICTION_SAMPLE_SIZE,
  DEFAULT_PASS_CADENCE_MS,
  dreamSettingsFromStored,
  dreamSettingsStoreAttached,
  flushedDreamSettingsWrite,
  getDreamSettings,
  loadStoredDreamSettings,
  reseedDreamSettings,
  updateDreamSettings,
} from "@core/dream/settings.js";
import { DEFAULT_DREAM_MODEL } from "@core/dream/judge.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../migrations");

/** A store over a throwaway migrated database, plus its cleanup handle. */
async function openStore() {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-dream-settings-"));
  const storage = SqliteStorage.create({ dbPath: join(tmp, "d.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  return {
    tmp,
    storage,
    store: storage.dreamSettings,
    close: async () => {
      await storage.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let logs: string[] = [];
const log = (msg: string) => {
  logs.push(msg);
};

beforeEach(() => {
  reseedDreamSettings({});
  attachDreamSettingsStore(null);
  logs = [];
});

afterEach(() => {
  attachDreamSettingsStore(null);
});

describe("stored dream settings — shape and gate", () => {
  it("an absent row is the env seed, untouched", () => {
    const { settings, clampedApply } = dreamSettingsFromStored(null, {});
    expect(clampedApply).toBe(false);
    expect(settings.contradiction.sampleSize).toBe(DEFAULT_CONTRADICTION_SAMPLE_SIZE);
  });

  it("a stored value wins over env; a field the row omits falls back to env, then defaults", () => {
    const { settings } = dreamSettingsFromStored(
      { model: "stored-model", promotion: { enabled: true }, dedup: { sampleSize: 40 } },
      { NLM_DREAM_MODEL: "env-model", NLM_DREAM_DEDUP_SAMPLE: "99", NLM_DREAM_CONTRADICTION_SAMPLE: "11" },
    );
    expect(settings.model).toBe("stored-model");
    expect(settings.promotion.enabled).toBe(true);
    expect(settings.dedup.sampleSize).toBe(40);
    // Not in the row at all → env still seeds it.
    expect(settings.contradiction.sampleSize).toBe(11);
  });

  it("a row from an older build (missing a whole pass) still loads", () => {
    const { settings } = dreamSettingsFromStored({ model: "old-build", dedup: { enabled: true } }, {});
    expect(settings.promotion).toEqual(getDreamSettings().promotion);
    expect(settings.promotion.enabled).toBe(false);
  });

  it("an unknown key or a bad shape is a DreamSettingsError, not a silent accept", () => {
    expect(() => dreamSettingsFromStored({ reflexion: { enabled: true } }, {})).toThrow(/unknown pass or setting/);
    expect(() => dreamSettingsFromStored({ promotion: { mode: "on" } }, {})).toThrow(/promotion.mode/);
    expect(() => dreamSettingsFromStored("apply-everything", {})).toThrow(/stored document must be an object/);
  });

  it("refuses a row that says contradiction apply while the gate has not passed", () => {
    const { settings, clampedApply } = dreamSettingsFromStored({ contradiction: { applyMode: "apply" } }, {});
    expect(clampedApply).toBe(true);
    expect(settings.contradiction.applyMode).toBe("dry-run");
    expect(CONTRADICTION_APPLY_GATE.passed).toBe(false);
    // Everything else in the same row is still honored.
  });

  it("accepts a stored apply row when the gate has passed", () => {
    const passed = { passed: true, evidence: "T1609 relabel precision 12/12 (2026-11-10)" };
    const { settings, clampedApply } = dreamSettingsFromStored({ contradiction: { applyMode: "apply" } }, {}, passed);
    expect(clampedApply).toBe(false);
    expect(settings.contradiction.applyMode).toBe("apply");
  });

  it("leaves an env-requested apply alone: env seeding is the operator's opt-in", () => {
    const { settings, clampedApply } = dreamSettingsFromStored(
      { contradiction: { enabled: true } },
      { NLM_DREAM_CONTRADICTION_APPLY: "1" },
    );
    expect(clampedApply).toBe(false);
    expect(settings.contradiction.applyMode).toBe("apply");
  });

  it("a stored dedup/promotion apply is not the contradiction gate's business", () => {
    const { settings } = dreamSettingsFromStored({ dedup: { applyMode: "apply" }, promotion: { mode: "apply" } }, {});
    expect(settings.dedup.applyMode).toBe("apply");
    expect(settings.promotion.mode).toBe("apply");
  });
});

describe("loadStoredDreamSettings — startup load order", () => {
  it("no row: env seeds, and the store stays row-free (binding alone never writes)", async () => {
    const s = await openStore();
    try {
      const settings = await loadStoredDreamSettings(s.store, { env: { NLM_DREAM_MODEL: "env-only" }, logger: log });
      expect(settings.model).toBe("env-only");
      expect(await s.store.load()).toBeNull();
      expect(logs).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("a stored row wins over env, and survives as the live settings", async () => {
    const s = await openStore();
    try {
      await s.store.save({ model: "stored", contradiction: { sampleSize: 7 } });
      const settings = await loadStoredDreamSettings(s.store, { env: { NLM_DREAM_MODEL: "env" }, logger: log });
      expect(settings.model).toBe("stored");
      expect(settings.contradiction.sampleSize).toBe(7);
      expect(getDreamSettings()).toEqual(settings);

      // A restart with nothing in env still reads the row.
      expect(await loadStoredDreamSettings(s.store, { env: {}, logger: log })).toMatchObject({
        model: "stored",
        contradiction: { sampleSize: 7 },
      });
    } finally {
      await s.close();
    }
  });

  it("an unreadable row falls back to env and says so", async () => {
    const s = await openStore();
    try {
      const db = s.storage.rawDb();
      db.prepare("INSERT INTO dream_settings (id, settings, updated_at) VALUES (1, ?, '2026-11-13')").run("{not json");
      const settings = await loadStoredDreamSettings(s.store, { env: { NLM_DREAM_MODEL: "env-fallback" }, logger: log });
      expect(settings.model).toBe("env-fallback");
      expect(logs.join("\n")).toMatch(/stored settings unreadable/);
    } finally {
      await s.close();
    }
  });

  it("a row this module refuses to read falls back to env and says so", async () => {
    const s = await openStore();
    try {
      await s.store.save({ dedup: { sampleSize: "many" } });
      const settings = await loadStoredDreamSettings(s.store, { env: {}, logger: log });
      expect(settings.dedup.sampleSize).toBe(200);
      expect(logs.join("\n")).toMatch(/stored settings invalid/);
    } finally {
      await s.close();
    }
  });

  it("a stored contradiction apply row loads as dry-run (the gate survives)", async () => {
    const s = await openStore();
    try {
      await s.store.save({ contradiction: { enabled: true, applyMode: "apply", sampleSize: 9 } });
      const settings = await loadStoredDreamSettings(s.store, { env: {}, logger: log });
      expect(settings.contradiction).toMatchObject({ enabled: true, applyMode: "dry-run", sampleSize: 9 });
      expect(getDreamSettings().contradiction.applyMode).toBe("dry-run");
      expect(logs.join("\n")).toMatch(/running dry-run/);
      expect(logs.join("\n")).toContain(CONTRADICTION_APPLY_GATE.evidence);
    } finally {
      await s.close();
    }
  });
});

describe("updateDreamSettings — write-through", () => {
  it("writes the whole document through the attached store", async () => {
    const s = await openStore();
    try {
      await loadStoredDreamSettings(s.store, { env: {}, logger: log });
      expect(dreamSettingsStoreAttached()).toBe(true);
      updateDreamSettings({ model: "written", promotion: { enabled: true, minCorroboration: 3 } });
      await flushedDreamSettingsWrite();
      const stored = (await s.store.load()) as Record<string, unknown>;
      expect(Object.keys(stored).sort()).toEqual(["contradiction", "dedup", "model", "promotion"]);
      expect(stored).toMatchObject({ model: "written", promotion: { enabled: true, minCorroboration: 3 } });

      // Restart: reopen the database and load again — the edit survives.
      attachDreamSettingsStore(null);
      const reloaded = await loadStoredDreamSettings(s.store, { env: {}, logger: log });
      expect(reloaded.model).toBe("written");
      expect(reloaded.promotion).toMatchObject({ enabled: true, minCorroboration: 3 });
    } finally {
      await s.close();
    }
  });

  it("serialized writes: the row ends up holding the newest document", async () => {
    const writes: unknown[] = [];
    const slow = { load: () => Promise.resolve(null), save: (doc: unknown) => new Promise<void>((r) => setTimeout(() => { writes.push(doc); r(); }, 5)) };
    await loadStoredDreamSettings(slow, { env: {}, logger: log });
    updateDreamSettings({ model: "one" });
    updateDreamSettings({ model: "two" });
    await flushedDreamSettingsWrite();
    expect(writes.map((w) => (w as { model: string }).model)).toEqual(["one", "two"]);
    expect(getDreamSettings().model).toBe("two");
  });

  it("a store whose write rejects surfaces through the flush, and the lane keeps going", async () => {
    let n = 0;
    const flaky = {
      load: () => Promise.resolve(null),
      save: (doc: unknown) => (++n === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve(void 0)),
    };
    await loadStoredDreamSettings(flaky, { env: {}, logger: log });
    updateDreamSettings({ model: "first" });
    await expect(flushedDreamSettingsWrite()).rejects.toThrow(/disk full/);
    // The failed write does not poison the chain.
    updateDreamSettings({ model: "second" });
    await expect(flushedDreamSettingsWrite()).resolves.toBeUndefined();
  });

  it("with no store attached nothing is written and nothing throws", async () => {
    reseedDreamSettings({});
    expect(dreamSettingsStoreAttached()).toBe(false);
    expect(updateDreamSettings({ model: "memory-only" }).model).toBe("memory-only");
    await expect(flushedDreamSettingsWrite()).resolves.toBeUndefined();
  });

  it("the gate still refuses apply through the write-through path", async () => {
    const s = await openStore();
    try {
      await loadStoredDreamSettings(s.store, { env: {}, logger: log });
      expect(() => updateDreamSettings({ contradiction: { applyMode: "apply" } })).toThrow(/precision gate/);
      await flushedDreamSettingsWrite();
      expect(await s.store.load()).toBeNull();
    } finally {
      await s.close();
    }
  });
});

describe("dream settings defaults stay the documented ones", () => {
  it("blank env → the documented model and cadence", () => {
    expect(reseedDreamSettings({})).toMatchObject({
      model: DEFAULT_DREAM_MODEL,
      contradiction: { cadenceMs: DEFAULT_PASS_CADENCE_MS },
    });
  });
});
