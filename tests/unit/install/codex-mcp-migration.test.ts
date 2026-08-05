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
