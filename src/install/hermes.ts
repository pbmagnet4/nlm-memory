/**
 * `nlm connect hermes` / `nlm disconnect hermes` — writes the nlm-memory
 * MCP server entry into ~/.hermes/config.yaml.
 *
 * Uses yaml's Document API (parseDocument / doc.setIn / doc.toString) to
 * preserve any comments the user has written in their config file. Round-
 * tripping through parse+stringify would silently destroy comments.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Document as YamlDocument, parseDocument as parseYamlDocument } from "yaml";
import { buildMcpBlock, isStdioBlock, type McpTransport } from "./mcp-block.js";

export interface ConnectHermesOptions {
  readonly nlmBinPath: string;
  readonly nodeExecPath: string;
  readonly dryRun?: boolean;
  /** Defaults to "http" — see mcp-block.ts for why. */
  readonly transport?: McpTransport;
  readonly token?: string;
  readonly port?: string;
}

export interface ConnectHermesReport {
  readonly configPath: string;
  readonly alreadyPresent: boolean;
  readonly written: boolean;
  readonly dryRun: boolean;
  readonly transport: McpTransport;
  /** True when an existing stdio block was rewritten to HTTP in place. */
  readonly migratedFromStdio: boolean;
}

export interface DisconnectHermesReport {
  readonly configPath: string;
  readonly removed: boolean;
  readonly dryRun: boolean;
}

export function hermesConfigPath(): string {
  return process.env["NLM_HERMES_CONFIG"] ?? join(homedir(), ".hermes", "config.yaml");
}

function readDocument(path: string): YamlDocument {
  if (!existsSync(path)) return new YamlDocument();
  try {
    return parseYamlDocument(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid YAML. Fix or remove it, then re-run \`nlm connect hermes\`.`);
  }
}

export function connectHermes(opts: ConnectHermesOptions): ConnectHermesReport {
  const configPath = hermesConfigPath();
  const doc = readDocument(configPath);
  const alreadyPresent = doc.getIn(["mcp_servers", "nlm-memory"]) !== undefined;
  // toJS() so the shape check sees a plain object, not a YAMLMap node.
  const existing = alreadyPresent
    ? ((doc.toJS() as { mcp_servers?: Record<string, unknown> })?.mcp_servers ?? {})["nlm-memory"]
    : undefined;
  const transport: McpTransport = opts.transport ?? "http";
  // Re-running connect on an install predating the HTTP default rewrites the
  // stale stdio block rather than leaving it, so existing users are carried
  // over instead of silently keeping a process-per-session config forever.
  const migratedFromStdio =
    transport === "http" && alreadyPresent && isStdioBlock(existing);

  // Built before the dry-run branch so a missing token fails the same way in
  // both modes — a dry run that "succeeds" then errors for real is a trap.
  const block = buildMcpBlock({
    transport,
    nlmBinPath: opts.nlmBinPath,
    nodeExecPath: opts.nodeExecPath,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.port ? { port: opts.port } : {}),
  });

  if (!opts.dryRun) {
    doc.setIn(["mcp_servers", "nlm-memory"], block);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, doc.toString(), "utf8");
  }

  return {
    configPath,
    alreadyPresent,
    written: !opts.dryRun,
    dryRun: opts.dryRun ?? false,
    transport,
    migratedFromStdio,
  };
}

export function disconnectHermes(opts?: { dryRun?: boolean }): DisconnectHermesReport {
  const configPath = hermesConfigPath();
  const doc = readDocument(configPath);

  if (doc.getIn(["mcp_servers", "nlm-memory"]) === undefined) {
    return { configPath, removed: false, dryRun: opts?.dryRun ?? false };
  }

  if (!opts?.dryRun) {
    doc.deleteIn(["mcp_servers", "nlm-memory"]);
    writeFileSync(configPath, doc.toString(), "utf8");
  }

  return { configPath, removed: true, dryRun: opts?.dryRun ?? false };
}
