import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PACKAGE_TEMPLATES_DIR = resolve(__dirname, "../../templates");

const MARKER_BEGIN = "<!-- nlm-agent-contract:begin -->";
const MARKER_END = "<!-- nlm-agent-contract:end -->";

export const VALID_AGENTS = ["claude-code", "generic"] as const;
export type AgentName = (typeof VALID_AGENTS)[number];

export interface InitCommandDeps {
  readonly agent: string;
  readonly write?: string | undefined;
  readonly force?: boolean | undefined;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly templatesDir?: string | undefined;
}

export function runInitCommand(deps: InitCommandDeps): void {
  const { agent, write, force, stdout, stderr } = deps;
  const templatesDir = deps.templatesDir ?? PACKAGE_TEMPLATES_DIR;

  if (!(VALID_AGENTS as readonly string[]).includes(agent)) {
    stderr(
      `nlm init: unknown agent "${agent}". Valid values: ${VALID_AGENTS.join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const content = readFileSync(
    resolve(templatesDir, "agent-contract", `${agent}.md`),
    "utf8",
  );

  if (!write) {
    stdout(content);
    return;
  }

  const existing = existsSync(write) ? readFileSync(write, "utf8") : "";

  if (existing.includes(MARKER_BEGIN)) {
    if (!force) {
      stderr(
        `nlm init: ${write} already contains the nlm-agent-contract block.\n` +
          `Re-run with --force to replace it in place.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const beginIdx = existing.indexOf(MARKER_BEGIN);
    const endIdx = existing.indexOf(MARKER_END);
    if (endIdx === -1 || endIdx < beginIdx) {
      stderr(
        `nlm init: begin marker found but end marker is missing in ${write}. ` +
          `Remove the markers manually and re-run.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    writeFileSync(
      write,
      `${before}${MARKER_BEGIN}\n${content}\n${MARKER_END}${after}`,
      "utf8",
    );
    stderr(`nlm init: replaced nlm-agent-contract block in ${write}\n`);
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    write,
    `${existing}${separator}\n${MARKER_BEGIN}\n${content}\n${MARKER_END}\n`,
    "utf8",
  );
  stderr(`nlm init: appended nlm-agent-contract block to ${write}\n`);
}
