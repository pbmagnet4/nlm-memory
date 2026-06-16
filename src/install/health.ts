/**
 * Install/runtime health checks for `nlm doctor`.
 *
 * The existing doctor checks DB integrity invariants (I1-I6). These checks
 * cover the OTHER half a public user hits: is the daemon up and current, is the
 * MCP token present, are the Claude Code / Codex runtimes wired, and is there a
 * stale `nlm-memory-ts` plugin left over from a pre-rename install.
 *
 * `evaluateInstallHealth` is pure: it takes a fully-gathered `InstallProbe` and
 * returns verdicts. All IO (filesystem reads, daemon ping) happens in the
 * gatherer at the CLI boundary, so the rules are unit-testable without a daemon
 * or a real home directory.
 */

export type HealthStatus = "ok" | "warn" | "fail";

export interface HealthCheck {
  readonly id: string;
  readonly status: HealthStatus;
  readonly detail: string;
  /** Exact command to run to resolve a warn/fail. Omitted when status is ok. */
  readonly fix?: string;
}

export interface InstallProbe {
  readonly daemon: {
    readonly reachable: boolean;
    /** Version string reported by /api/health, or null if unreachable. */
    readonly version: string | null;
    /** Version this binary expects (package.json). */
    readonly expectedVersion: string;
  };
  readonly env: {
    readonly path: string;
    readonly exists: boolean;
    /** Whether NLM_MCP_TOKEN resolved (from env file or process env). Never the value. */
    readonly hasMcpToken: boolean;
  };
  readonly claudeCode: {
    readonly configPath: string;
    readonly mcpConfigured: boolean;
  };
  readonly codex: {
    readonly configPath: string;
    readonly configPresent: boolean;
    readonly mcpConfigured: boolean;
    /** A pre-rename `nlm-memory-ts` plugin/marketplace entry is still present. */
    readonly staleNlmMemoryTs: boolean;
  };
}

export function evaluateInstallHealth(probe: InstallProbe): HealthCheck[] {
  return [
    daemonReachable(probe),
    daemonVersion(probe),
    mcpToken(probe),
    claudeCodeWiring(probe),
    codexStaleName(probe),
    codexWiring(probe),
  ];
}

function daemonReachable(p: InstallProbe): HealthCheck {
  if (p.daemon.reachable) {
    return { id: "daemon", status: "ok", detail: "daemon reachable" };
  }
  return {
    id: "daemon",
    status: "fail",
    detail: "daemon unreachable",
    fix: "nlm start",
  };
}

function daemonVersion(p: InstallProbe): HealthCheck {
  if (!p.daemon.reachable || p.daemon.version === null) {
    return { id: "daemon-version", status: "warn", detail: "daemon version unknown (not running)" };
  }
  if (p.daemon.version === p.daemon.expectedVersion) {
    return { id: "daemon-version", status: "ok", detail: `running ${p.daemon.version}` };
  }
  return {
    id: "daemon-version",
    status: "warn",
    detail: `daemon ${p.daemon.version} != installed ${p.daemon.expectedVersion}`,
    fix: "nlm restart",
  };
}

function mcpToken(p: InstallProbe): HealthCheck {
  if (p.env.hasMcpToken) {
    return { id: "mcp-token", status: "ok", detail: "NLM_MCP_TOKEN present" };
  }
  return {
    id: "mcp-token",
    status: "warn",
    detail: `NLM_MCP_TOKEN not set (${p.env.exists ? p.env.path : "no .env file"})`,
    fix: "nlm setup",
  };
}

function claudeCodeWiring(p: InstallProbe): HealthCheck {
  if (p.claudeCode.mcpConfigured) {
    return { id: "claude-code", status: "ok", detail: "MCP server configured" };
  }
  return {
    id: "claude-code",
    status: "warn",
    detail: `no nlm MCP block in ${p.claudeCode.configPath}`,
    fix: "nlm connect claude-code",
  };
}

function codexStaleName(p: InstallProbe): HealthCheck {
  if (!p.codex.staleNlmMemoryTs) {
    return { id: "codex-stale", status: "ok", detail: "no stale nlm-memory-ts entry" };
  }
  return {
    id: "codex-stale",
    status: "fail",
    detail: "stale nlm-memory-ts plugin entry in Codex config",
    fix: "nlm connect codex --repair",
  };
}

function codexWiring(p: InstallProbe): HealthCheck {
  // Codex is optional. Only warn when its config exists but lacks the MCP block;
  // a user with no Codex config at all isn't misconfigured, just not using it.
  if (!p.codex.configPresent) {
    return { id: "codex", status: "ok", detail: "Codex not configured (optional)" };
  }
  if (p.codex.mcpConfigured) {
    return { id: "codex", status: "ok", detail: "MCP server configured" };
  }
  return {
    id: "codex",
    status: "warn",
    detail: `Codex config present but no nlm MCP block (${p.codex.configPath})`,
    fix: "nlm connect codex",
  };
}
