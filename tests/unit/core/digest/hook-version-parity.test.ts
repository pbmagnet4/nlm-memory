/**
 * Hook version parity — the gap the liveness canary structurally cannot cover.
 *
 * checkHookLiveness asks "did hooks fire?". It cannot ask "did the RIGHT hooks
 * fire?", so hooks executing stale code from a different install pass it
 * cleanly. That is not hypothetical: on 2026-08-14 the five Claude Code hooks
 * had been running a 9-day-old 0.21.0 build out of a dev checkout while the
 * daemon served 0.21.3. Every check was green the entire time, because firing
 * and being-current are different properties.
 *
 * This asserts the second one. It reads the most recent live fire rather than
 * scanning the window: that self-clears one hook fire after an upgrade (no
 * multi-day false positive from pre-upgrade entries), while hooks that really
 * are stale keep reporting the old version — or no version at all, if they
 * predate the stamp entirely.
 */

import { describe, expect, it } from "vitest";
import { checkHookVersionParity } from "@core/digest/hook-version-parity.js";

const EXPECTED = "0.21.4";

function entry(over: Record<string, unknown> = {}) {
  return { ts: "2026-08-14T10:00:00.000Z", mode: "live", v: EXPECTED, ...over };
}

describe("checkHookVersionParity", () => {
  it("passes when the newest live fire matches the expected version", () => {
    expect(checkHookVersionParity([entry()], EXPECTED)).toBeNull();
  });

  it("warns when the newest live fire reports a different version", () => {
    const alert = checkHookVersionParity([entry({ v: "0.21.0" })], EXPECTED);
    expect(alert).toContain("0.21.0");
    expect(alert).toContain(EXPECTED);
  });

  it("warns when the newest live fire carries no version at all", () => {
    // Pre-stamp hooks. This is exactly the 9-day-stale case.
    const alert = checkHookVersionParity([entry({ v: undefined })], EXPECTED);
    expect(alert).toBeTruthy();
    expect(alert).toMatch(/version/i);
  });

  it("judges by the NEWEST live fire, not the oldest", () => {
    const log = [
      entry({ ts: "2026-08-01T10:00:00.000Z", v: "0.21.0" }), // stale, older
      entry({ ts: "2026-08-14T10:00:00.000Z", v: EXPECTED }), // current, newer
    ];
    expect(checkHookVersionParity(log, EXPECTED)).toBeNull();
  });

  it("self-clears after an upgrade: one current fire outweighs older unstamped ones", () => {
    const log = [
      entry({ ts: "2026-08-13T10:00:00.000Z", v: undefined }),
      entry({ ts: "2026-08-14T10:00:00.000Z", v: EXPECTED }),
    ];
    expect(checkHookVersionParity(log, EXPECTED)).toBeNull();
  });

  it("ignores shadow-mode fires — only live tells you what production runs", () => {
    const log = [
      entry({ ts: "2026-08-14T11:00:00.000Z", mode: "shadow", v: "0.0.1" }),
      entry({ ts: "2026-08-14T10:00:00.000Z", mode: "live", v: EXPECTED }),
    ];
    expect(checkHookVersionParity(log, EXPECTED)).toBeNull();
  });

  it("is silent on an empty log — that is liveness's job, not parity's", () => {
    expect(checkHookVersionParity([], EXPECTED)).toBeNull();
  });

  it("is silent when no expected version is known", () => {
    expect(checkHookVersionParity([entry({ v: "0.21.0" })], undefined)).toBeNull();
  });

  it("ignores entries with unparseable timestamps rather than throwing", () => {
    const log = [entry({ ts: "not-a-date", v: "0.0.1" }), entry({ v: EXPECTED })];
    expect(checkHookVersionParity(log, EXPECTED)).toBeNull();
  });
});
