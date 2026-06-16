import { describe, expect, it } from "vitest";
import { evaluateInstallHealth } from "../../../src/install/health.js";
import type { InstallProbe } from "../../../src/install/health.js";

function baseProbe(overrides: Partial<InstallProbe> = {}): InstallProbe {
  return {
    daemon: { reachable: true, version: "0.12.0", expectedVersion: "0.12.0" },
    env: { path: "/home/u/.nlm/.env", exists: true, hasMcpToken: true },
    claudeCode: { configPath: "/home/u/.mcp.json", mcpConfigured: true },
    codex: {
      configPath: "/home/u/.codex/config.toml",
      configPresent: false,
      mcpConfigured: false,
      staleNlmMemoryTs: false,
    },
    ...overrides,
  };
}

function byId(probe: InstallProbe) {
  return new Map(evaluateInstallHealth(probe).map((c) => [c.id, c]));
}

describe("evaluateInstallHealth", () => {
  it("reports all-ok for a healthy install", () => {
    const checks = evaluateInstallHealth(baseProbe());
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.every((c) => c.fix === undefined)).toBe(true);
  });

  it("fails daemon and suggests nlm start when unreachable", () => {
    const c = byId(baseProbe({ daemon: { reachable: false, version: null, expectedVersion: "0.12.0" } }));
    expect(c.get("daemon")?.status).toBe("fail");
    expect(c.get("daemon")?.fix).toBe("nlm start");
    // version check degrades to warn (unknown) rather than fail
    expect(c.get("daemon-version")?.status).toBe("warn");
  });

  it("warns on daemon/installed version drift with nlm restart", () => {
    const c = byId(
      baseProbe({ daemon: { reachable: true, version: "0.11.0", expectedVersion: "0.12.0" } }),
    );
    expect(c.get("daemon-version")?.status).toBe("warn");
    expect(c.get("daemon-version")?.fix).toBe("nlm restart");
  });

  it("warns when the MCP token is absent without leaking a value", () => {
    const c = byId(baseProbe({ env: { path: "/home/u/.nlm/.env", exists: true, hasMcpToken: false } }));
    expect(c.get("mcp-token")?.status).toBe("warn");
    expect(c.get("mcp-token")?.fix).toBe("nlm setup");
  });

  it("warns when Claude Code MCP block is missing", () => {
    const c = byId(baseProbe({ claudeCode: { configPath: "/home/u/.mcp.json", mcpConfigured: false } }));
    expect(c.get("claude-code")?.status).toBe("warn");
    expect(c.get("claude-code")?.fix).toBe("nlm connect claude-code");
  });

  it("fails on a stale nlm-memory-ts Codex entry and points to --repair", () => {
    const c = byId(
      baseProbe({
        codex: {
          configPath: "/home/u/.codex/config.toml",
          configPresent: true,
          mcpConfigured: true,
          staleNlmMemoryTs: true,
        },
      }),
    );
    expect(c.get("codex-stale")?.status).toBe("fail");
    expect(c.get("codex-stale")?.fix).toBe("nlm connect codex --repair");
  });

  it("treats absent Codex config as ok (optional runtime)", () => {
    const c = byId(baseProbe());
    expect(c.get("codex")?.status).toBe("ok");
  });

  it("warns when Codex config is present but unwired", () => {
    const c = byId(
      baseProbe({
        codex: {
          configPath: "/home/u/.codex/config.toml",
          configPresent: true,
          mcpConfigured: false,
          staleNlmMemoryTs: false,
        },
      }),
    );
    expect(c.get("codex")?.status).toBe("warn");
    expect(c.get("codex")?.fix).toBe("nlm connect codex");
  });
});
