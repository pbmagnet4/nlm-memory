/**
 * Single source of truth for the MCP server block every runtime installer
 * writes. One definition here, reused by claude-code / hermes / any future
 * surface, so a new adapter cannot silently ship a different shape.
 *
 * HTTP is the default transport. The daemon mounts the full MCP surface at
 * POST /mcp (src/http/app.ts), stateless — a fresh transport and server per
 * request, with the team resolved from the bearer token. That means one shared
 * process serves every session, and the corpus is reached over the network
 * rather than by each client opening the SQLite file directly.
 *
 * Stdio remains available via `--stdio`. Its one real advantage is that it
 * builds its own stack and therefore works with the daemon stopped; everything
 * else about it is worse (a process per session, N independent readers of the
 * same database, and no multi-tenancy — the stdio path is pinned to
 * DEFAULT_TEAM_ID while the HTTP path resolves the team from the token).
 */

import { DEFAULT_NLM_PORT } from "../shared/net.js";

export type McpTransport = "http" | "stdio";

/**
 * The env var every runtime reads the bearer token from. Runtimes that support
 * env indirection (Codex `bearer_token_env_var`, pi `bearerTokenEnv`) get the
 * name and never see the secret; the token only lands in a config file on
 * runtimes with no such option, which today means Claude Code's ~/.mcp.json.
 */
export const TOKEN_ENV_VAR = "NLM_MCP_TOKEN";

export interface McpBlockOptions {
  readonly transport: McpTransport;
  /** Required for stdio. Path to the nlm entrypoint. */
  readonly nlmBinPath?: string;
  /** Required for stdio. Node executable that runs it. */
  readonly nodeExecPath?: string;
  /** Bearer token for the HTTP transport. Falls back to NLM_MCP_TOKEN. */
  readonly token?: string;
  /** Daemon port. Falls back to NLM_PORT, then the shared default. */
  readonly port?: string;
}

export interface HttpMcpBlock {
  readonly type: "http";
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface StdioMcpBlock {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export type McpBlock = HttpMcpBlock | StdioMcpBlock;

export function mcpEndpointUrl(port?: string): string {
  const p = port ?? process.env["NLM_PORT"] ?? DEFAULT_NLM_PORT;
  // 127.0.0.1 rather than localhost: Node resolves localhost to IPv6 ::1
  // first, a measured per-connection penalty on a loopback-only daemon.
  return `http://127.0.0.1:${p}/mcp`;
}

/**
 * Build the block for one runtime. Throws on a missing prerequisite rather
 * than emitting a config that would fail at runtime — a connect command that
 * writes a broken block is worse than one that refuses.
 */
export function buildMcpBlock(opts: McpBlockOptions): McpBlock {
  if (opts.transport === "stdio") {
    if (!opts.nlmBinPath || !opts.nodeExecPath) {
      throw new Error("stdio transport requires nlmBinPath and nodeExecPath");
    }
    return { command: opts.nodeExecPath, args: [opts.nlmBinPath, "mcp"] };
  }

  const token = opts.token ?? process.env["NLM_MCP_TOKEN"];
  if (!token) {
    throw new Error(
      "NLM_MCP_TOKEN is not set — the /mcp endpoint requires a bearer token. " +
      "Run `nlm setup` to generate one, or connect with --stdio.",
    );
  }
  // The token is written literally: MCP config files do not expand ${VAR},
  // so a placeholder would reach the client as the literal string.
  return {
    type: "http",
    url: mcpEndpointUrl(opts.port),
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * Codex (~/.codex/config.toml) — reads the token from an env var, so nothing
 * secret is written to disk. Emitted as TOML text because the installer
 * manages a sentinel-bracketed region rather than parsing the file.
 */
export function codexMcpToml(opts: { transport: McpTransport; port?: string } = { transport: "http" }): string {
  if (opts.transport === "stdio") {
    return `[mcp_servers.nlm-memory]\ncommand = "nlm"\nargs = ["mcp"]\n`;
  }
  return (
    `[mcp_servers.nlm-memory]\n` +
    `url = "${mcpEndpointUrl(opts.port)}"\n` +
    `bearer_token_env_var = "${TOKEN_ENV_VAR}"\n`
  );
}

/**
 * pi (~/.pi/agent/mcp.json, read by pi-mcp-adapter) — also supports env
 * indirection via `bearerTokenEnv`. `auth: "bearer"` is set explicitly
 * because the adapter auto-detects OAuth when a url is present and auth is
 * unspecified, which would try to register an OAuth client against a daemon
 * that has none.
 */
export function piMcpEntry(opts: { transport: McpTransport; nlmBinPath?: string; nodeExecPath?: string; port?: string }): Record<string, unknown> {
  if (opts.transport === "stdio") {
    if (!opts.nlmBinPath || !opts.nodeExecPath) {
      throw new Error("stdio transport requires nlmBinPath and nodeExecPath");
    }
    return { type: "stdio", command: opts.nodeExecPath, args: [opts.nlmBinPath, "mcp"] };
  }
  return {
    url: mcpEndpointUrl(opts.port),
    auth: "bearer",
    bearerTokenEnv: TOKEN_ENV_VAR,
  };
}

/** True when an existing config block is the legacy stdio shape. */
export function isStdioBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  if (b["type"] === "http" || typeof b["url"] === "string") return false;
  return typeof b["command"] === "string";
}
