/**
 * fireAlert tests. Verifies the skip-when-unset no-network contract,
 * the CloudEvents-shaped envelope, the retry-once behavior, and the
 * never-throws guarantee under 5xx / timeout / rejection.
 *
 * No real network: every test injects a fetch stub.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireAlert } from "../../../../src/core/alerts/fire-alert.js";
import type { AlertEvent } from "../../../../src/core/alerts/types.js";

const EVENT: AlertEvent = {
  type: "nlm.drift.version_behind",
  data: { current: "0.5.7", latest: "0.5.8", since: "2026-07-20T00:00:00.000Z" },
};

describe("fireAlert", () => {
  beforeEach(() => {
    delete process.env["NLM_ALERT_WEBHOOK"];
    delete process.env["NLM_ALERT_WEBHOOK_TOKEN"];
  });

  afterEach(() => {
    delete process.env["NLM_ALERT_WEBHOOK"];
    delete process.env["NLM_ALERT_WEBHOOK_TOKEN"];
  });

  it("makes zero fetch calls when NLM_ALERT_WEBHOOK is unset", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await fireAlert(EVENT, { fetchImpl });

    expect(calls).toBe(0);
  });

  it("POSTs a CloudEvents-shaped envelope when the webhook is set", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await fireAlert(EVENT, {
      fetchImpl,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(capturedUrl).toBe("https://example.test/hook");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body["specversion"]).toBe("1.0");
    expect(body["type"]).toBe("nlm.drift.version_behind");
    expect(body["time"]).toBe("2026-07-22T12:00:00.000Z");
    expect(typeof body["id"]).toBe("string");
    expect(typeof body["source"]).toBe("string");
    expect(body["data"]).toEqual(EVENT.data);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });

  it("adds Authorization: Bearer when NLM_ALERT_WEBHOOK_TOKEN is set", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    process.env["NLM_ALERT_WEBHOOK_TOKEN"] = "secret-token";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await fireAlert(EVENT, { fetchImpl });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret-token");
  });

  it("retries once on a failing response, then gives up silently", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    await expect(fireAlert(EVENT, { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("does not retry a second time once the first retry succeeds", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 500 : 200 });
    }) as typeof fetch;

    await fireAlert(EVENT, { fetchImpl });

    expect(calls).toBe(2);
  });

  it("never throws when fetch rejects (e.g. timeout/offline)", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = "https://example.test/hook";
    const fetchImpl = (async () => {
      throw new TypeError("network error");
    }) as typeof fetch;

    await expect(fireAlert(EVENT, { fetchImpl })).resolves.toBeUndefined();
  });
});
