// tests/unit/install/mcp-block.test.ts
//
// Pins the single MCP config shape every runtime installer writes.
//
// WHY: `nlm connect <runtime>` used to emit a stdio block for every surface,
// so each session spawned its own process that opened the SQLite corpus
// directly. The daemon already mounts the whole MCP surface at POST /mcp,
// stateless and token-scoped to a team, so HTTP is the better default on every
// runtime that supports it. These tests pin the default, the escape hatch, and
// the stdio-detection used to migrate installs made before the flip.

import { describe, expect, it, afterEach } from "vitest";
import { buildMcpBlock, codexMcpToml, isStdioBlock, mcpEndpointUrl, piMcpEntry } from "../../../src/install/mcp-block.js";

const ENV_KEYS = ["NLM_MCP_TOKEN", "NLM_PORT"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildMcpBlock — http (the default)", () => {
  it("emits a bearer-authed loopback block", () => {
    process.env["NLM_MCP_TOKEN"] = "tok_abc";
    process.env["NLM_PORT"] = "3940";
    expect(buildMcpBlock({ transport: "http" })).toEqual({
      type: "http",
      url: "http://127.0.0.1:3940/mcp",
      headers: { Authorization: "Bearer tok_abc" },
    });
  });

  it("writes the token literally, since MCP config files do not expand ${VAR}", () => {
    process.env["NLM_MCP_TOKEN"] = "tok_literal";
    const b = buildMcpBlock({ transport: "http" }) as { headers: Record<string, string> };
    expect(b.headers["Authorization"]).toBe("Bearer tok_literal");
    expect(b.headers["Authorization"]).not.toContain("$");
  });

  it("refuses rather than writing a block that would 401 at runtime", () => {
    delete process.env["NLM_MCP_TOKEN"];
    expect(() => buildMcpBlock({ transport: "http" })).toThrow(/NLM_MCP_TOKEN is not set/);
  });

  it("honors an explicit port over the environment", () => {
    process.env["NLM_MCP_TOKEN"] = "t";
    process.env["NLM_PORT"] = "3940";
    const b = buildMcpBlock({ transport: "http", port: "4111" }) as { url: string };
    expect(b.url).toBe("http://127.0.0.1:4111/mcp");
  });

  it("uses 127.0.0.1, never localhost", () => {
    expect(mcpEndpointUrl("3940")).toBe("http://127.0.0.1:3940/mcp");
    expect(mcpEndpointUrl("3940")).not.toContain("localhost");
  });
});

describe("buildMcpBlock — stdio (the escape hatch)", () => {
  it("emits the legacy spawn block", () => {
    expect(buildMcpBlock({ transport: "stdio", nlmBinPath: "/n/nlm.js", nodeExecPath: "/usr/bin/node" }))
      .toEqual({ command: "/usr/bin/node", args: ["/n/nlm.js", "mcp"] });
  });

  it("does not require a token, which is its whole point", () => {
    delete process.env["NLM_MCP_TOKEN"];
    expect(() => buildMcpBlock({ transport: "stdio", nlmBinPath: "/n", nodeExecPath: "/node" })).not.toThrow();
  });

  it("throws on a missing path rather than emitting a broken block", () => {
    expect(() => buildMcpBlock({ transport: "stdio" })).toThrow(/requires nlmBinPath and nodeExecPath/);
  });
});

describe("isStdioBlock — drives in-place migration", () => {
  it("detects the legacy shape", () => {
    expect(isStdioBlock({ command: "/usr/bin/node", args: ["/n/nlm.js", "mcp"] })).toBe(true);
  });

  it("does not flag an already-migrated http block", () => {
    expect(isStdioBlock({ type: "http", url: "http://127.0.0.1:3940/mcp", headers: {} })).toBe(false);
  });

  it("does not flag a url-bearing block that omits an explicit type", () => {
    expect(isStdioBlock({ url: "http://127.0.0.1:3940/mcp" })).toBe(false);
  });

  it("is safe on absent or malformed entries", () => {
    for (const v of [undefined, null, "string", 42, {}, []]) {
      expect(isStdioBlock(v)).toBe(false);
    }
  });
});

describe("codexMcpToml — env-var indirection, no secret on disk", () => {
  it("emits a streamable-http table naming the token env var", () => {
    process.env["NLM_PORT"] = "3940";
    const toml = codexMcpToml({ transport: "http" });
    expect(toml).toContain('[mcp_servers.nlm-memory]');
    expect(toml).toContain('url = "http://127.0.0.1:3940/mcp"');
    expect(toml).toContain('bearer_token_env_var = "NLM_MCP_TOKEN"');
  });

  it("never writes the token value itself", () => {
    process.env["NLM_MCP_TOKEN"] = "super_secret_value";
    expect(codexMcpToml({ transport: "http" })).not.toContain("super_secret_value");
  });

  it("still emits the legacy spawn table under --stdio", () => {
    const toml = codexMcpToml({ transport: "stdio" });
    expect(toml).toContain('command = "nlm"');
    expect(toml).not.toContain("url =");
  });
});

describe("piMcpEntry — bearer auth pinned explicitly", () => {
  it("sets auth: bearer so the adapter does not auto-detect OAuth", () => {
    process.env["NLM_PORT"] = "3940";
    expect(piMcpEntry({ transport: "http" })).toEqual({
      url: "http://127.0.0.1:3940/mcp",
      auth: "bearer",
      bearerTokenEnv: "NLM_MCP_TOKEN",
    });
  });

  it("never writes the token value itself", () => {
    process.env["NLM_MCP_TOKEN"] = "super_secret_value";
    expect(JSON.stringify(piMcpEntry({ transport: "http" }))).not.toContain("super_secret_value");
  });

  it("emits a stdio entry under --stdio", () => {
    expect(piMcpEntry({ transport: "stdio", nlmBinPath: "/n/nlm.js", nodeExecPath: "/node" }))
      .toEqual({ type: "stdio", command: "/node", args: ["/n/nlm.js", "mcp"] });
  });
});
