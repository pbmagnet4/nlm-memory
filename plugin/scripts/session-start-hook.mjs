#!/usr/bin/env node

// src/hook/session-start-hook.ts
import { pathToFileURL } from "node:url";

// src/core/hook/hook-log.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function logPath() {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}
function appendHookLog(entry) {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}
`, "utf8");
  } catch {
  }
}

// src/core/hook/memo.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function stateDir() {
  return process.env["NLM_HOOK_STATE_DIR"] ?? join2(homedir2(), ".nlm", "hook-state");
}
function memoPath(conversationId) {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join2(stateDir(), `${safe}.json`);
}
function loadSurfaced(conversationId) {
  try {
    const path = memoPath(conversationId);
    if (!existsSync(path)) return /* @__PURE__ */ new Set();
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
    return new Set(parsed.filter((x) => typeof x === "string"));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function recordSurfaced(conversationId, ids) {
  try {
    const merged = loadSurfaced(conversationId);
    for (const id of ids) merged.add(id);
    mkdirSync2(stateDir(), { recursive: true });
    writeFileSync(memoPath(conversationId), JSON.stringify([...merged]), "utf8");
  } catch {
  }
}

// src/core/hook/pointer-block.ts
function formatPointerBlock(hits, facts = [], exemplars = []) {
  if (hits.length === 0 && facts.length === 0 && exemplars.length === 0) return "";
  const out = [];
  if (hits.length > 0) {
    out.push("## Possibly-relevant prior sessions (nlm-memory)");
    for (const h of hits) {
      const datePart = h.startedAt.slice(0, 10);
      if (h.summary) {
        out.push(`- ${h.id} \xB7 ${h.label} (${datePart}) \u2014 ${h.summary.slice(0, 120)}`);
      } else {
        out.push(`- ${h.id} \xB7 ${h.label} (${datePart})`);
      }
    }
  }
  if (facts.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Known facts about top entities");
    for (const f of facts) {
      const tag = f.corroborationCount > 1 ? ` [${f.corroborationCount} sessions]` : "";
      out.push(`- ${f.subject} ${f.predicate}: ${f.value}${tag}`);
    }
  }
  if (exemplars.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Related code exemplars (nlm-memory)");
    for (const e of exemplars) {
      const langPart = e.lang ? `${e.lang} \xB7 ` : "";
      out.push(`- [${e.outcome}] ${langPart}${e.repo} - ${e.taskContext.slice(0, 120)}`);
    }
  }
  const tools = exemplars.length > 0 ? "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved), recall_code (pull the full code for a related exemplar)." : "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).";
  out.push(tools);
  return out.join("\n");
}

// src/core/hook/select.ts
function selectHits(params) {
  const { hits, surfaced, scoreThreshold, perFireCap, perConversationCap } = params;
  const eligible = hits.filter(
    (h) => h.matchScore >= scoreThreshold && !surfaced.has(h.id)
  );
  const budget = Math.max(0, perConversationCap - surfaced.size);
  const limit = Math.min(perFireCap, budget);
  return eligible.slice(0, limit);
}

// src/llm/env-autoload.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { resolve } from "node:path";
var DEFAULT_SEARCH_PATHS = [
  "~/.nlm/.env",
  "./.env",
  "../.env",
  "../../.env"
];
function expandHome(p) {
  if (p.startsWith("~/")) return resolve(homedir3(), p.slice(2));
  return p;
}
function autoloadEnv(extraPaths = []) {
  const loaded = [];
  const paths = [...DEFAULT_SEARCH_PATHS, ...extraPaths];
  for (const raw of paths) {
    const path = expandHome(raw);
    if (!existsSync2(path)) continue;
    try {
      const content = readFileSync2(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eq = trimmed.indexOf("=");
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        if (key && process.env[key] === void 0) {
          process.env[key] = value;
        }
      }
      loaded.push(path);
    } catch {
      continue;
    }
  }
  return loaded;
}

// src/hook/hook-auth.ts
function hookAuthHeaders(extra = {}) {
  const token = process.env["NLM_MCP_TOKEN"];
  if (!token) return { ...extra };
  return { ...extra, authorization: `Bearer ${token}` };
}

// src/hook/score-floor.ts
function parseScoreFloor(raw) {
  if (raw === void 0) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

// src/hook/session-start-hook.ts
var SCORE_THRESHOLD = parseScoreFloor(process.env["NLM_RECALL_SCORE_FLOOR"]);
var PER_FIRE_CAP = 3;
var PER_CONVERSATION_CAP = 10;
var RECALL_LIMIT = 5;
var RECALL_TIMEOUT_MS = 2e3;
async function runHook(input, deps) {
  let hits = [];
  try {
    hits = await deps.recall(input.query, input.conversationId);
  } catch {
    hits = [];
  }
  const surfaced = loadSurfaced(input.conversationId);
  const selected = selectHits({
    hits,
    surfaced,
    scoreThreshold: SCORE_THRESHOLD,
    perFireCap: PER_FIRE_CAP,
    perConversationCap: PER_CONVERSATION_CAP
  });
  const block = formatPointerBlock(selected);
  const estTokens = Math.ceil(block.length / 4);
  appendHookLog({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    conversationId: input.conversationId,
    promptPreview: input.query,
    gate: "evaluate",
    hits: hits.map((h) => ({ id: h.id, score: h.matchScore })),
    wouldInject: selected.map((h) => h.id),
    estTokens,
    mode: deps.mode
  });
  if (deps.mode === "live" && selected.length > 0) {
    recordSurfaced(input.conversationId, selected.map((h) => h.id));
    return block;
  }
  return "";
}
function composeSessionStartOutput(failureModeBlock, recallBlock) {
  return [failureModeBlock, recallBlock].filter((s) => s.length > 0).join("\n\n");
}
async function fetchFailureModeBlock(repo) {
  if (!repo) return "";
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://localhost:${portValue}/api/signals/failure-modes?repo=${encodeURIComponent(repo)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: hookAuthHeaders({ "x-recall-source": "session-start-hook" }),
      signal: controller.signal
    });
    if (!res.ok) return "";
    const body = await res.json();
    return typeof body.block === "string" ? body.block : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
function buildQuery(workingDirectory, projectName) {
  const dirTail = workingDirectory.split("/").filter(Boolean).at(-1) ?? "";
  const parts = [dirTail, projectName].filter(Boolean);
  return parts.join(" ").trim() || "session start";
}
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", () => resolve2(data));
  });
}
async function recallOverHttp(query, conversationId) {
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://localhost:${portValue}/api/recall?q=${encodeURIComponent(query)}&mode=hybrid&limit=${RECALL_LIMIT}` + (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: hookAuthHeaders({
        "x-recall-source": "session-start-hook",
        "x-recall-runtime": "claude-code"
      }),
      signal: controller.signal
    });
    if (!res.ok) return [];
    let body;
    try {
      body = await res.json();
    } catch {
      return [];
    }
    return (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
      ...r.summary !== void 0 ? { summary: r.summary } : {}
    }));
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const workingDirectory = typeof payload.cwd === "string" ? payload.cwd : typeof payload.working_directory === "string" ? payload.working_directory : "";
    const projectName = typeof payload.project_name === "string" ? payload.project_name : "";
    const query = buildQuery(workingDirectory, projectName);
    const mode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
    const out = await runHook({ conversationId, query }, { mode, recall: (q, cid) => recallOverHttp(q, cid === "unknown" ? void 0 : cid) });
    const failureModes = mode === "live" ? await fetchFailureModeBlock(workingDirectory) : "";
    const combined = composeSessionStartOutput(failureModes, out);
    if (combined) process.stdout.write(combined);
  } catch {
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
export {
  composeSessionStartOutput,
  runHook
};
