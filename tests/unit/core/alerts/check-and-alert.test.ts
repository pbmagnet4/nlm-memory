/**
 * check-and-alert integration tests — wires the real transition logic,
 * the real (temp-dir-redirected) state file, and a stubbed fetch
 * through checkDriftAndAlert / checkEmbedderAndAlert. Verifies a fired
 * transition POSTs to the webhook and persists state, and that an
 * unset webhook still updates state with zero network calls.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDriftAndAlert, checkEmbedderAndAlert, checkIngestLagAndAlert } from "../../../../src/core/alerts/check-and-alert.js";
import type { IngestLagReport } from "../../../../src/core/health/ingest-lag.js";
import { markWarm, resetWarmupState } from "../../../../src/core/health/warmup-state.js";
import type { AlertState } from "../../../../src/core/alerts/alert-state.js";

describe("checkDriftAndAlert", () => {
  let tmp: string;
  let statePath: string;
  let updateCachePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-alert-"));
    statePath = join(tmp, "alert-state.json");
    updateCachePath = join(tmp, "update-check.json");
    delete process.env["NLM_ALERT_WEBHOOK"];
    delete process.env["NLM_DISABLE_UPDATE_CHECK"];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env["NLM_ALERT_WEBHOOK"];
    delete process.env["NLM_DISABLE_UPDATE_CHECK"];
  });

  it("fires the webhook on the false→true drift edge and persists state", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    let posts = 0;
    let lastBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "https://example.test/hook") {
        posts += 1;
        lastBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(null, { status: 200 });
      }
      // registry lookup
      return new Response(JSON.stringify({ version: "0.9.9" }), { status: 200 });
    }) as typeof fetch;

    await checkDriftAndAlert({
      currentVersion: "0.5.0",
      fetchImpl,
      statePath,
      updateCheckDeps: { cachePath: updateCachePath },
    });

    expect(posts).toBe(1);
    expect(lastBody?.["type"]).toBe("nlm.drift.version_behind");
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as AlertState;
    expect(persisted.drift.behindSince).not.toBeNull();
  });

  it("makes zero webhook calls when NLM_ALERT_WEBHOOK is unset, but still persists state", async () => {
    let posts = 0;
    const fetchImpl = (async (url: string) => {
      if (typeof url === "string" && url.includes("example.test")) posts += 1;
      return new Response(JSON.stringify({ version: "0.9.9" }), { status: 200 });
    }) as typeof fetch;

    await checkDriftAndAlert({
      currentVersion: "0.5.0",
      fetchImpl,
      statePath,
      updateCheckDeps: { cachePath: updateCachePath },
    });

    expect(posts).toBe(0);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as AlertState;
    expect(persisted.drift.behindSince).not.toBeNull();
  });

  it("does not re-fire on a second call within the grace window", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    let posts = 0;
    const fetchImpl = (async (url: string) => {
      if (url === "https://example.test/hook") {
        posts += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ version: "0.9.9" }), { status: 200 });
    }) as typeof fetch;

    await checkDriftAndAlert({ currentVersion: "0.5.0", fetchImpl, statePath, updateCheckDeps: { cachePath: updateCachePath } });
    await checkDriftAndAlert({ currentVersion: "0.5.0", fetchImpl, statePath, updateCheckDeps: { cachePath: updateCachePath } });

    expect(posts).toBe(1);
  });
});

describe("checkEmbedderAndAlert", () => {
  let tmp: string;
  let statePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-alert-emb-"));
    statePath = join(tmp, "alert-state.json");
    resetWarmupState();
    delete process.env["NLM_ALERT_WEBHOOK"];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetWarmupState();
    delete process.env["NLM_ALERT_WEBHOOK"];
  });

  it("fires only after the 2nd consecutive not-ready check", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    let posts = 0;
    const fetchImpl = (async () => {
      posts += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    // warmupSnapshot().ready is false by default (resetWarmupState) — no
    // markWarm calls, so every check below observes not-ready.

    await checkEmbedderAndAlert({ fetchImpl, statePath });
    expect(posts).toBe(0);

    await checkEmbedderAndAlert({ fetchImpl, statePath });
    expect(posts).toBe(1);
  });

  it("makes zero webhook calls once ready, with no prior not-ready streak", async () => {
    markWarm("fts5");
    markWarm("textEmbedder");
    let posts = 0;
    const fetchImpl = (async () => {
      posts += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await checkEmbedderAndAlert({ fetchImpl, statePath });

    expect(posts).toBe(0);
  });
});

describe("checkIngestLagAndAlert", () => {
  const report = (lagging: boolean): IngestLagReport => ({
    adapters: {},
    last_success_at: null,
    last_progress_at: null,
    timeouts_1h: 0,
    errors_1h: 0,
    lagging,
    summary: "412 pending, oldest 3d, 0 ok/1h",
  });

  it("posts nlm.health.ingest_lagging on the second lagging check and persists state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-alert-"));
    const statePath = join(tmp, "alert-state.json");
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    const bodies: Array<{ type: string; data: { current: string; latest: string } }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await checkIngestLagAndAlert(async () => report(true), { statePath, fetchImpl });
      expect(bodies).toHaveLength(0);
      await checkIngestLagAndAlert(async () => report(true), { statePath, fetchImpl });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.type).toBe("nlm.health.ingest_lagging");
      expect(bodies[0]?.data).toMatchObject({ current: "412 pending, oldest 3d, 0 ok/1h", latest: "caught up" });
      await checkIngestLagAndAlert(async () => report(false), { statePath, fetchImpl });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.data.current).toBe("caught up");
    } finally {
      delete process.env["NLM_ALERT_WEBHOOK"];
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
