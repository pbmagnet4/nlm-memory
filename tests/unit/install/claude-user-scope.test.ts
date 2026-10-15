import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasNlmMcpServer } from "../../../src/install/claude-code.js";

describe("hasNlmMcpServer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-mcp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const withNlm = JSON.stringify({ mcpServers: { "nlm-memory": { type: "http", url: "http://localhost:1/mcp" } } });

  it("finds the server in the project-style .mcp.json", () => {
    expect(hasNlmMcpServer([write("mcp.json", withNlm), join(dir, "missing.json")])).toBe(true);
  });

  it("finds a user-scope registration in .claude.json when .mcp.json lacks it", () => {
    const mcp = write("mcp.json", JSON.stringify({ mcpServers: { other: {} } }));
    const user = write("claude.json", withNlm);
    expect(hasNlmMcpServer([mcp, user])).toBe(true);
  });

  it("is false when neither file registers it, or the files are missing or malformed", () => {
    const mcp = write("mcp.json", "{ not json");
    const user = write("claude.json", JSON.stringify({ mcpServers: { other: {} } }));
    expect(hasNlmMcpServer([mcp, user, join(dir, "absent.json")])).toBe(false);
  });
});
