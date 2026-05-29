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
export function hermesConfigPath() {
    return process.env["NLM_HERMES_CONFIG"] ?? join(homedir(), ".hermes", "config.yaml");
}
function readDocument(path) {
    if (!existsSync(path))
        return new YamlDocument();
    try {
        return parseYamlDocument(readFileSync(path, "utf8"));
    }
    catch {
        throw new Error(`${path} is not valid YAML. Fix or remove it, then re-run \`nlm connect hermes\`.`);
    }
}
export function connectHermes(opts) {
    const configPath = hermesConfigPath();
    const doc = readDocument(configPath);
    const alreadyPresent = doc.getIn(["mcp_servers", "nlm-memory"]) !== undefined;
    if (!opts.dryRun) {
        doc.setIn(["mcp_servers", "nlm-memory"], {
            command: opts.nodeExecPath,
            args: [opts.nlmBinPath, "mcp"],
        });
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, doc.toString(), "utf8");
    }
    return { configPath, alreadyPresent, written: !opts.dryRun, dryRun: opts.dryRun ?? false };
}
export function disconnectHermes(opts) {
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
//# sourceMappingURL=hermes.js.map