/**
 * Alert-state persistence tests — the JSON file on disk outlives deploys,
 * so a state written by an older build must still load with today's
 * defaults filled in (T1867 added `embedderCold.lastFiredAt`).
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_ALERT_STATE,
  readAlertState,
  writeAlertState,
} from "../../../../src/core/alerts/alert-state.js";

const dir = mkdtempSync(join(tmpdir(), "nlm-alert-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function path(name: string): string {
  return join(dir, name);
}

describe("readAlertState", () => {
  it("defaults lastFiredAt for an embedder state written before T1867", async () => {
    const file = path("legacy.json");
    writeFileSync(
      file,
      JSON.stringify({
        embedderCold: { notReadyStreak: 4, since: "2026-11-12T00:00:00.000Z" },
      }),
      "utf8",
    );

    const state = await readAlertState(file);
    expect(state.embedderCold).toEqual({
      notReadyStreak: 4,
      since: "2026-11-12T00:00:00.000Z",
      lastFiredAt: null,
    });
    // Untouched sections fall back to their defaults too.
    expect(state.drift).toEqual(DEFAULT_ALERT_STATE.drift);
  });

  it("round-trips lastFiredAt", async () => {
    const file = path("roundtrip.json");
    await writeAlertState(file, {
      ...DEFAULT_ALERT_STATE,
      embedderCold: {
        notReadyStreak: 2,
        since: "2026-11-12T00:00:00.000Z",
        lastFiredAt: "2026-11-12T06:00:00.000Z",
      },
    });

    expect(await readAlertState(file)).toMatchObject({
      embedderCold: { lastFiredAt: "2026-11-12T06:00:00.000Z" },
    });
    expect(JSON.parse(readFileSync(file, "utf8")).embedderCold.lastFiredAt).toBe(
      "2026-11-12T06:00:00.000Z",
    );
  });

  it("falls back to defaults when the file is missing or corrupt", async () => {
    expect(await readAlertState(path("does-not-exist.json"))).toEqual(DEFAULT_ALERT_STATE);

    const file = path("corrupt.json");
    writeFileSync(file, "{not json", "utf8");
    expect(await readAlertState(file)).toEqual(DEFAULT_ALERT_STATE);
  });
});
