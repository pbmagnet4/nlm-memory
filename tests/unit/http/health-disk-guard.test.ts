/**
 * GET /api/health diskGuard block (T1772 Part 3): present when the daemon
 * wires the guard, null when it doesn't; reads are never gated regardless.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";

function appWith(diskGuard?: () => unknown) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) },
    store: {},
    ...(diskGuard ? { diskGuard } : {}),
  } as never);
}

const SNAPSHOT = { free: 1024, threshold: 2048, tripped: true, checkedAt: 1731312000000 };

describe("GET /api/health diskGuard", () => {
  it("exposes the last guard snapshot", async () => {
    const res = await appWith(() => SNAPSHOT).request("/api/health");
    const body = (await res.json()) as { status: string; diskGuard: unknown };
    expect(body.status).toBe("ok");
    expect(body.diskGuard).toEqual(SNAPSHOT);
  });

  it("reports null when no guard is wired (and health still answers)", async () => {
    const res = await appWith().request("/api/health");
    const body = (await res.json()) as { diskGuard: unknown };
    expect(body.diskGuard).toBeNull();
  });
});
