import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceRow } from "../../../../src/core/sources/source-registry.js";
import type { SessionChunk, TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";
import {
  adapterForCurrentSession,
  findCurrentSession,
  runtimeAdapterNames,
  sessionIdFromEnvironment,
} from "../../../../src/core/transcript/current-session.js";

function chunk(over: Partial<SessionChunk>): SessionChunk {
  return {
    id: "cc_x",
    runtime: "claude-code",
    runtimeSessionId: "x",
    sourcePath: "/t.jsonl",
    startedAt: "2026-10-09T10:00:00.000Z",
    endedAt: "2026-10-09T11:00:00.000Z",
    durationMin: 60,
    turnCount: 20,
    byteRange: [0, 1],
    projectDir: "/repo",
    gitBranch: "main",
    text: "hello",
    label: "",
    ...over,
  };
}

function adapter(name: string, sessions: SessionChunk[], seen: { since?: Date | undefined }[] = []): TranscriptAdapter {
  return {
    name,
    runtimeVersion: "1",
    transcriptKind: "jsonl",
    detect: () => ({ adapterName: name, enabled: true, path: null, hint: null }),
    discover: async (opts) => {
      seen.push({ since: opts?.since });
      return sessions.map((s) => s.sourcePath);
    },
    parseSession: async (path) => sessions.find((s) => s.sourcePath === path) ?? null,
  };
}

describe("findCurrentSession", () => {
  const older = chunk({ runtimeSessionId: "a", sourcePath: "/a", endedAt: "2026-10-09T09:00:00.000Z" });
  const newer = chunk({ runtimeSessionId: "b", sourcePath: "/b", endedAt: "2026-10-09T12:00:00.000Z" });
  const elsewhere = chunk({ runtimeSessionId: "c", sourcePath: "/c", projectDir: "/other", endedAt: "2026-10-09T13:00:00.000Z" });

  it("returns the newest session in the requested project", async () => {
    const res = await findCurrentSession({ adapters: [adapter("claude-code", [older, newer, elsewhere])], cwd: "/repo" });
    expect(res?.session.runtimeSessionId).toBe("b");
    expect(res?.selection).toBe("latest-in-project");
    expect(res?.adapterName).toBe("claude-code");
  });

  it("an exact session id wins over recency and project, and skips the since window", async () => {
    const seen: { since?: Date | undefined }[] = [];
    const res = await findCurrentSession({
      adapters: [adapter("claude-code", [older, newer], seen)],
      sessionId: "a",
      cwd: "/elsewhere",
      since: new Date("2026-10-09T00:00:00.000Z"),
    });
    expect(res?.session.runtimeSessionId).toBe("a");
    expect(res?.selection).toBe("exact-session-id");
    expect(seen[0]?.since).toBeUndefined();
  });

  it("returns null for an unknown session id rather than guessing", async () => {
    const res = await findCurrentSession({ adapters: [adapter("claude-code", [newer])], sessionId: "zzz" });
    expect(res).toBeNull();
  });

  it("an adapter that throws does not hide another adapter's sessions", async () => {
    const broken: TranscriptAdapter = { ...adapter("codex", []), discover: async () => { throw new Error("boom"); } };
    const res = await findCurrentSession({ adapters: [broken, adapter("claude-code", [newer])], cwd: "/repo" });
    expect(res?.session.runtimeSessionId).toBe("b");
  });
});

describe("runtimeAdapterNames", () => {
  it("maps aliases to adapter names", () => {
    expect(runtimeAdapterNames("claude", {})).toEqual(["claude-code"]);
    expect(runtimeAdapterNames("hermes", {})).toEqual(["hermes-agent", "hermes"]);
    expect(runtimeAdapterNames("muse", {})).toEqual(["muse"]);
  });

  it("auto reads the runtime from its session env var, else means every adapter", () => {
    expect(runtimeAdapterNames("auto", { CODEX_THREAD_ID: "t" })).toEqual(["codex"]);
    expect(runtimeAdapterNames("auto", {})).toBeUndefined();
  });

  it("rejects an unknown runtime", () => {
    expect(() => runtimeAdapterNames("vim", {})).toThrow(/unsupported runtime vim/);
  });
});

describe("sessionIdFromEnvironment", () => {
  it("prefers NXT_SESSION_ID, then the requested runtime's own var", () => {
    expect(sessionIdFromEnvironment(["codex"], { NXT_SESSION_ID: "n", CODEX_SESSION_ID: "c" })).toBe("n");
    expect(sessionIdFromEnvironment(["codex"], { CLAUDE_SESSION_ID: "cl", CODEX_SESSION_ID: "c" })).toBe("c");
  });

  it("reads Claude Code's CLAUDE_CODE_SESSION_ID", () => {
    expect(sessionIdFromEnvironment(["claude-code"], { CLAUDE_CODE_SESSION_ID: "cc" })).toBe("cc");
    expect(runtimeAdapterNames("auto", { CLAUDE_CODE_SESSION_ID: "cc" })).toEqual(["claude-code"]);
  });

  it("ignores another runtime's session id", () => {
    expect(sessionIdFromEnvironment(["codex"], { CLAUDE_SESSION_ID: "cl" })).toBeUndefined();
  });
});


describe("active Codex profile", () => {
  const source: SourceRow = {
    id: 1, tenantId: "default", kind: "codex", name: "Codex",
    pathOrUrl: "/missing/registered-store", runtimeLabel: "codex/1.0",
    parseConfig: {}, enabled: true, token: null, hasToken: false,
    createdAt: "", updatedAt: "",
  };

  it("finds the exact session in CODEX_HOME without changing registered sources", async () => {
    const home = mkdtempSync(join(tmpdir(), "nlm-codex-profile-"));
    try {
      const sessions = join(home, "sessions", "2026", "05", "29");
      mkdirSync(sessions, { recursive: true });
      copyFileSync(resolve("tests/fixtures/codex/standard_session.jsonl"), join(sessions, "rollout-profile.jsonl"));
      const active = adapterForCurrentSession(source, { CODEX_HOME: home });
      const result = await findCurrentSession({ adapters: [active!], sessionId: "019e69aa-c9f7-7363-89bd-245cb8d62905" });
      expect(result?.selection).toBe("exact-session-id");
      expect(result?.session.sourcePath).toContain(home);
      expect(source.pathOrUrl).toBe("/missing/registered-store");
      expect(await findCurrentSession({ adapters: [active!], sessionId: "other-profile-id" })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves the registered store when CODEX_HOME is absent", async () => {
    const registered = adapterForCurrentSession(source, {});
    expect(await registered!.discover()).toEqual([]);
  });
});
