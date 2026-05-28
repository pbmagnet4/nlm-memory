/**
 * Claude Code SubagentStart hook entrypoint for NLM.
 *
 * Fires when Claude Code dispatches a subagent (Agent tool). Subagents have
 * their own session IDs but are invisible to NLM's session corpus today.
 * This hook captures the parent→subagent link so NLM can correlate subagent
 * transcripts back to the dispatching conversation when SessionEnd fires.
 *
 * Capture-only. No recall injection — subagents inherit context from their
 * dispatch prompt; additional recall would pollute their narrow task scope.
 *
 * Daemon endpoint: POST localhost:3940/api/hook/subagent-start
 * This endpoint does NOT exist yet in the daemon — the hook ships fail-soft
 * (swallows errors). The daemon-side handler is a follow-up task.
 *
 * Payload: { parent_conversation_id, subagent_session_id, subagent_description, ts }
 *
 * Fail-open by design: any error yields a clean exit with no output.
 */
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const POST_TIMEOUT_MS = 1500;
export async function runSubagentStart(input, portValue = process.env["NLM_PORT"] ?? "3940") {
    const payload = {
        parent_conversation_id: input.parentConversationId,
        subagent_session_id: input.subagentSessionId,
        subagent_description: input.subagentDescription,
        ts: new Date().toISOString(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
        const res = await fetch(`http://localhost:${portValue}/api/hook/subagent-start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        return {
            parentConversationId: input.parentConversationId,
            subagentSessionId: input.subagentSessionId,
            posted: res.ok,
        };
    }
    catch {
        // Endpoint absent or daemon down — fail soft, never block subagent dispatch.
        return {
            parentConversationId: input.parentConversationId,
            subagentSessionId: input.subagentSessionId,
            posted: false,
        };
    }
    finally {
        clearTimeout(timer);
    }
}
function logPath() {
    return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}
function logResult(result) {
    try {
        const path = logPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({
            ts: new Date().toISOString(),
            kind: "subagent-start",
            parentConversationId: result.parentConversationId,
            subagentSessionId: result.subagentSessionId,
            posted: result.posted,
        })}\n`, "utf8");
    }
    catch {
        // Telemetry failure must never break the hook.
    }
}
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => resolve(data));
    });
}
async function main() {
    try {
        const raw = await readStdin();
        const payload = JSON.parse(raw);
        const subagentSessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
        const parentConversationId = typeof payload.parent_session_id === "string" ? payload.parent_session_id : "unknown";
        const subagentDescription = typeof payload.description === "string" ? payload.description : "";
        const result = await runSubagentStart({
            parentConversationId,
            subagentSessionId,
            subagentDescription,
        });
        logResult(result);
    }
    catch {
        // Fail open — never block subagent dispatch.
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
//# sourceMappingURL=subagent-start-hook.js.map