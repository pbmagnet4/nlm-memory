/**
 * T1613 — dreaming control-plane HTTP surface.
 *
 * GET /api/dreaming reports the runtime settings snapshot plus the last-run
 * registry the pass registrations write into; POST patches the settings
 * through the settings module (all-or-nothing) and maps a rejected patch to
 * 400. Both routes 503 while the deployment does not wire the surface. The
 * settings are process-global module state — every test reseeds them to a
 * blank env first so nothing leaks between cases.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../../../src/http/app.js";
import {
  CONTRADICTION_APPLY_GATE,
  DEFAULT_CONTRADICTION_SAMPLE_SIZE,
  DEFAULT_DEDUP_SAMPLE_SIZE,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_PASS_CADENCE_MS,
  DEFAULT_PROMOTION_SAMPLE_SIZE,
  DEFAULT_PROMOTION_WINDOW_DAYS,
  getDreamSettings,
  reseedDreamSettings,
  resetLastRuns,
  updateDreamSettings,
} from "../../../src/core/dream/settings.js";
import { DEFAULT_DREAM_MODEL } from "../../../src/core/dream/judge.js";
import { MAX_PROMOTION_BYTES, MAX_PROMOTION_LINES, MIN_CORROBORATION } from "../../../src/core/dream/promotion.js";

function appWith(dreaming?: boolean) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) },
    store: {},
    ...(dreaming !== undefined ? { dreaming } : {}),
  } as never);
}

beforeEach(() => {
  reseedDreamSettings({});
  resetLastRuns();
});

describe("GET /api/dreaming", () => {
  it("returns the settings snapshot plus the last-run registry", async () => {
    updateDreamSettings({ contradiction: { enabled: true } });
    const res = await appWith(true).request("/api/dreaming");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, never>;
    expect(body.settings).toEqual({
      model: DEFAULT_DREAM_MODEL,
      contradiction: {
        enabled: true,
        cadenceMs: DEFAULT_PASS_CADENCE_MS,
        sampleSize: DEFAULT_CONTRADICTION_SAMPLE_SIZE,
        maxInFlight: DEFAULT_MAX_IN_FLIGHT,
        applyMode: "dry-run",
      },
      dedup: {
        enabled: false,
        cadenceMs: DEFAULT_PASS_CADENCE_MS,
        sampleSize: DEFAULT_DEDUP_SAMPLE_SIZE,
        applyMode: "dry-run",
      },
      promotion: {
        enabled: false,
        mode: "dry-run",
        sampleSize: DEFAULT_PROMOTION_SAMPLE_SIZE,
        windowDays: DEFAULT_PROMOTION_WINDOW_DAYS,
        maxLines: MAX_PROMOTION_LINES,
        maxBytes: MAX_PROMOTION_BYTES,
        minCorroboration: MIN_CORROBORATION,
      },
    });
    expect(body.lastRuns).toEqual({ contradiction: null, dedup: null, promotion: null });
  });

  it("503s when the surface is not wired", async () => {
    expect((await appWith().request("/api/dreaming")).status).toBe(503);
    expect((await appWith(false).request("/api/dreaming")).status).toBe(503);
  });
});

describe("POST /api/dreaming", () => {
  it("applies a valid patch to the runtime settings and returns the new snapshot", async () => {
    const res = await appWith(true).request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-mini", dedup: { enabled: true, applyMode: "apply" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { model: string; dedup: { enabled: boolean; applyMode: string } } };
    expect(body.settings.model).toBe("qwen-mini");
    expect(body.settings.dedup).toMatchObject({ enabled: true, applyMode: "apply" });
    // Applied to the runtime module the passes read, not just echoed back.
    expect(getDreamSettings().model).toBe("qwen-mini");
    expect(getDreamSettings().dedup.enabled).toBe(true);
  });

  it("400s on an unknown pass, leaving the settings untouched", async () => {
    const before = getDreamSettings();
    const res = await appWith(true).request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reflexion: { enabled: true } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown pass or setting/);
    expect(getDreamSettings()).toEqual(before);
  });

  it("400s on bad values (all-or-nothing) and on a non-object or malformed body", async () => {
    const before = getDreamSettings();
    const post = (body: unknown) =>
      appWith(true).request("/api/dreaming", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const badNumber = await post({ contradiction: { sampleSize: 0 } });
    expect(badNumber.status).toBe(400);
    expect(((await badNumber.json()) as { error: string }).error).toMatch(/positive integer/);

    const badMode = await post({ dedup: { applyMode: "on" } });
    expect(badMode.status).toBe(400);
    expect(((await badMode.json()) as { error: string }).error).toMatch(/dry-run.*apply/);

    // Partially-valid patch: the model must not stick when dedup rejects.
    const mixed = await post({ model: "should-not-apply", dedup: { enabled: "yes" } });
    expect(mixed.status).toBe(400);
    expect(getDreamSettings()).toEqual(before);

    const arrayBody = await post([1, 2]);
    expect(arrayBody.status).toBe(400);

    const malformed = await appWith(true).request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("400s a contradiction apply patch while the precision gate has not passed", async () => {
    const before = getDreamSettings();
    const res = await appWith(true).request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contradiction: { applyMode: "apply" } }),
    });
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toMatch(/precision gate/);
    expect(error).toContain(CONTRADICTION_APPLY_GATE.evidence);
    expect(getDreamSettings()).toEqual(before);
  });

  it("applies a promotion patch (T1729) — the pass switch, its mode and its knobs", async () => {
    const res = await appWith(true).request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promotion: { enabled: true, mode: "apply", minCorroboration: 3, maxLines: 50 } }),
    });
    expect(res.status).toBe(200);
    // Unlike the contradiction pass, promotion apply is not precision-gated.
    expect(getDreamSettings().promotion).toMatchObject({
      enabled: true,
      mode: "apply",
      minCorroboration: 3,
      maxLines: 50,
      sampleSize: DEFAULT_PROMOTION_SAMPLE_SIZE,
      windowDays: DEFAULT_PROMOTION_WINDOW_DAYS,
    });
  });

  it("400s a bad promotion patch and changes nothing", async () => {
    const before = getDreamSettings();
    const res = await appWith(true).request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "should-not-stick", promotion: { minCorroboration: 0 } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/promotion.minCorroboration must be a positive integer/);
    expect(getDreamSettings()).toEqual(before);
  });

  it("503s when the surface is not wired, without touching the settings", async () => {
    const before = getDreamSettings();
    const res = await appWith().request("/api/dreaming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-mini" }),
    });
    expect(res.status).toBe(503);
    expect(getDreamSettings()).toEqual(before);
  });
});

/**
 * T1641 — the daemon itself must wire the surface, otherwise the Dreaming
 * settings page 503s in the field even though the routes exist. nlm.ts builds
 * the createApp deps inline inside the `start` action, so the smallest seam
 * that proves the wiring without binding a socket or building the storage
 * stack is the deps literal itself: read the flag the daemon passes, then
 * build an app with it and expect 200. (Same source-scan seam already used by
 * tests/unit/core/mcp-no-ambient-attribution.test.ts.)
 */
function daemonDreamingFlag(): boolean {
  const src = readFileSync(new URL("../../../src/cli/nlm.ts", import.meta.url), "utf8");
  const start = src.indexOf("const app = createApp(");
  expect(start, "nlm.ts must build the daemon app through createApp").toBeGreaterThan(-1);
  const deps = src.slice(start, src.indexOf("\n    });", start));
  const flag = /\bdreaming:\s*(true|false)\b/.exec(deps);
  expect(flag, "the daemon's createApp deps must carry the dreaming flag").not.toBeNull();
  return flag![1] === "true";
}

describe("daemon app wiring", () => {
  it("passes dreaming: true, and an app built with the daemon's flag answers GET 200", async () => {
    const wired = daemonDreamingFlag();
    expect(wired).toBe(true);
    const res = await appWith(wired).request("/api/dreaming");
    expect(res.status).toBe(200);
  });
});
