import { describe, expect, it } from "vitest";
import { isOurStdioTable, removeNlmMcpTables } from "../../../src/install/codex.js";

const OURS = `[mcp_servers.other]
command = "x"

[mcp_servers.nlm-memory]
command = "node"
args = ["/p/nlm.js", "mcp"]

[mcp_servers.nlm-memory.env]
NLM_FORMAT = "toon"

[mcp_servers.after]
command = "y"
`;

describe("codex un-sentineled stdio migration", () => {
  it("recognizes the shape this installer used to emit", () => {
    expect(isOurStdioTable(OURS)).toBe(true);
  });

  it("refuses when the table is already http", () => {
    expect(isOurStdioTable(`[mcp_servers.nlm-memory]\nurl = "http://x/mcp"\n`)).toBe(false);
  });

  it("refuses when the user added keys we never wrote", () => {
    expect(isOurStdioTable(`[mcp_servers.nlm-memory]\ncommand = "node"\nstartup_timeout_ms = 30000\n`)).toBe(false);
  });

  it("refuses a deliberate wrapper that happens to use the same keys", () => {
    // A shell script that sets env then execs nlm. Same key names as ours, but
    // migrating it away would destroy a setup the user built on purpose.
    expect(isOurStdioTable(
      '[mcp_servers.nlm-memory]\ncommand = "/usr/local/bin/my-nlm-wrapper.sh"\nargs = ["mcp"]\n',
    )).toBe(false);
  });

  it("refuses when args do not carry the mcp subcommand", () => {
    expect(isOurStdioTable('[mcp_servers.nlm-memory]\ncommand = "nlm"\nargs = ["serve"]\n')).toBe(false);
  });

  it("accepts both shapes this installer has emitted", () => {
    // current: bare `nlm mcp`
    expect(isOurStdioTable('[mcp_servers.nlm-memory]\ncommand = "nlm"\nargs = ["mcp"]\n')).toBe(true);
    // older / hand-written: node running the built entrypoint
    expect(isOurStdioTable(
      '[mcp_servers.nlm-memory]\ncommand = "node"\nargs = ["/p/nlm-memory/dist/cli/nlm.js", "mcp"]\n',
    )).toBe(true);
  });

  it("refuses when there is no table at all", () => {
    expect(isOurStdioTable(`[mcp_servers.other]\ncommand = "x"\n`)).toBe(false);
  });

  it("removes the table and its dotted sub-tables, keeping neighbours", () => {
    const out = removeNlmMcpTables(OURS);
    expect(out).not.toContain("nlm-memory");
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("[mcp_servers.after]");
    expect(out).toContain('command = "y"');
  });
});
