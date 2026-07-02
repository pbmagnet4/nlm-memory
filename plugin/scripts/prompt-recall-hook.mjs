#!/usr/bin/env node

// src/hook/prompt-recall-hook.ts
import { pathToFileURL } from "node:url";

// src/core/hook/gate.ts
var LEADING_FILLER = /^(please|can you|could you|would you|will you|i need you to|i'd like you to|i want you to|i would like you to|help me|let's|lets|hey|ok|okay)\b[\s,]*/i;
var GENERATIVE_OPENER = /^(write|draft|create|compose|generate|brainstorm|design|outline|sketch|invent|rename|come up with)\b/i;
var HARNESS_TAGS = [
  "ide_selection",
  "ide_opened_file",
  "ide_closed_file",
  "ide_diagnostics",
  "ide_recently_modified_file",
  "task-notification",
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr"
];
var HARNESS_BLOCK = new RegExp(
  `<(${HARNESS_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?(?:</\\1>|$)`,
  "gi"
);
var ACK_ONLY = /^(yes|yep|yeah|sure|ok|okay|k|thanks|thank you|ty|done|nice|cool|great|perfect|continue|next|go|go ahead|do it|yes please|sounds good|good|got it|right|correct)\W*$/i;
function contentWordCount(s) {
  const m = s.match(/[A-Za-z0-9]{2,}/g);
  return m ? m.length : 0;
}
function classifyPrompt(prompt) {
  let p = prompt.replace(HARNESS_BLOCK, " ").replace(/\s+/g, " ").trim();
  if (contentWordCount(p) === 0) return "skip";
  if (ACK_ONLY.test(p)) return "skip";
  for (let i = 0; i < 3 && LEADING_FILLER.test(p); i++) {
    p = p.replace(LEADING_FILLER, "");
  }
  p = p.trim();
  if (contentWordCount(p) === 0) return "skip";
  return GENERATIVE_OPENER.test(p) ? "generative" : "evaluate";
}

// src/hook/recent-context.ts
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
var DEFAULT_MAX_TURNS = 3;
var DEFAULT_MAX_BYTES = 64 * 1024;
var DEFAULT_PER_TURN_CHARS = 400;
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "you",
  "your",
  "i",
  "we",
  "our",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "how",
  "why",
  "when",
  "where",
  "who",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "please",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "so",
  "now",
  "then",
  "here",
  "there",
  "just",
  "also",
  "as",
  "at",
  "by",
  "if",
  "my",
  "me",
  "us",
  "ok",
  "okay",
  "yes",
  "no",
  "not",
  "up",
  "out",
  "go",
  "get",
  "got",
  "make",
  "made",
  "give",
  "tell",
  "want",
  "need",
  "think",
  "know",
  "let",
  "lets",
  "about",
  "from",
  "into"
]);
function topicalWordCount(s) {
  const tokens = s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  return tokens.filter((t) => !STOPWORDS.has(t)).length;
}
function textOf(message) {
  if (typeof message !== "object" || message === null) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(
      (b) => typeof b === "object" && b !== null && b.type === "text"
    ).map((b) => b.text).join(" ");
  }
  return "";
}
function tailRead(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function recentConversationContext(transcriptPath, opts = {}) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return "";
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const perTurnChars = opts.perTurnChars ?? DEFAULT_PER_TURN_CHARS;
    const lines = tailRead(transcriptPath, opts.maxBytes ?? DEFAULT_MAX_BYTES).split("\n");
    const turns = [];
    for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type !== "user" && evt.type !== "assistant") continue;
      const text = textOf(evt.message).trim();
      if (!text) continue;
      turns.unshift(text.slice(0, perTurnChars));
    }
    return turns.join(" ").trim();
  } catch {
    return "";
  }
}

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
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
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
    if (!existsSync2(path)) return /* @__PURE__ */ new Set();
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
function medianScore(hits) {
  if (hits.length === 0) return 0;
  const sorted = hits.map((h) => h.matchScore).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function selectHits(params) {
  const { hits, surfaced, scoreThreshold, perFireCap, perConversationCap, relativeFloor = 0 } = params;
  const relCut = relativeFloor > 0 ? relativeFloor * medianScore(hits) : 0;
  const eligible = hits.filter(
    (h) => h.matchScore >= scoreThreshold && h.matchScore >= relCut && !surfaced.has(h.id)
  );
  const budget = Math.max(0, perConversationCap - surfaced.size);
  const limit = Math.min(perFireCap, budget);
  return eligible.slice(0, limit);
}

// src/llm/env-autoload.ts
import { readFileSync as readFileSync2, existsSync as existsSync3 } from "node:fs";
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
    if (!existsSync3(path)) continue;
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

// src/core/hook/query-extract.ts
var STOPWORDS2 = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "dare",
  "ought",
  "yes",
  "no",
  "not",
  "please",
  "thank",
  "thanks",
  "ok",
  "okay",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "if",
  "so",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "from",
  "with",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "now",
  "also",
  "get",
  "let",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "any",
  "much",
  "many",
  "sounds",
  "good",
  "great",
  "sure",
  "right",
  "well",
  "done",
  "nice",
  "cool",
  "perfect",
  "exactly",
  "proceed",
  "continue",
  "go",
  "ahead",
  "next",
  "help"
]);
var MIN_CONTENT_WORDS = 2;
var MIN_WORD_LEN = 3;
var SYSTEM_MESSAGE_PREFIX = /^<(task-notification|command-name|command-message|command-args|local-command-stdout|local-command-caveat|output-file|system-reminder)\b/;
function extractRecallQuery(prompt) {
  if (SYSTEM_MESSAGE_PREFIX.test(prompt.trim())) return null;
  const tokens = prompt.trim().split(/\s+/).map((t) => t.replace(/^[^\w-]+|[^\w-]+$/g, "")).filter((t) => t.length >= MIN_WORD_LEN);
  const contentWords = tokens.filter((t) => !STOPWORDS2.has(t.toLowerCase()));
  if (contentWords.length < MIN_CONTENT_WORDS) return null;
  return contentWords.join(" ");
}

// src/hook/hook-helpers.ts
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", () => resolve2(data));
  });
}
async function fetchWithTimeout(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function hookModeFromEnv() {
  return process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
}

// src/hook/recall-over-http.ts
var RECALL_LIMIT = 5;
var RECALL_TIMEOUT_MS = 2e3;
async function recallOverHttp(prompt, runtime, conversationId, mode = "keyword") {
  const query = extractRecallQuery(prompt);
  if (query === null) return { hits: [], facts: [], exemplars: [] };
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = (
    // 127.0.0.1, not localhost: each hook is a fresh process with no connection
    // reuse, and Node resolves localhost to IPv6 ::1 first — a measured ~50-300ms
    // per-fire connect penalty vs ~3ms on the explicit IPv4 loopback.
    `http://127.0.0.1:${portValue}/api/recall?q=${encodeURIComponent(query)}&mode=${mode}&limit=${RECALL_LIMIT}&withFacts=true&withExemplars=true` + (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : "")
  );
  try {
    const extra = { "x-recall-source": "hook" };
    if (runtime) extra["x-recall-runtime"] = runtime;
    const res = await fetchWithTimeout(url, { headers: hookAuthHeaders(extra) }, RECALL_TIMEOUT_MS);
    if (!res.ok) return { hits: [], facts: [], exemplars: [] };
    let body;
    try {
      body = await res.json();
    } catch {
      return { hits: [], facts: [], exemplars: [] };
    }
    const hits = (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
      ...r.summary !== void 0 ? { summary: r.summary } : {}
    }));
    const facts = (body.relatedFacts ?? []).map((f) => ({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      corroborationCount: f.corroborationCount
    }));
    const exemplars = (body.relatedExemplars ?? []).map((e) => ({
      outcome: e.outcome,
      lang: e.lang,
      repo: e.repo,
      taskContext: e.taskContext
    }));
    return { hits, facts, exemplars };
  } catch {
    return { hits: [], facts: [], exemplars: [] };
  }
}

// src/hook/score-floor.ts
function parseScoreFloor(raw) {
  if (raw === void 0) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}
function parseRelativeFloor(raw, fallback) {
  if (raw === void 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

// src/hook/recall-gate.ts
var RECALL_GATE_MODEL = "qwen3.5:4b";
var RECALL_GATE_SYSTEM = `You are a recall GATE protecting against off-topic memory injection. Given a USER PROMPT and a CANDIDATE prior-session context, answer irrelevant ONLY when the candidate is CLEARLY about a completely different topic, project, or task than the prompt (e.g. the prompt is about debugging a website and the candidate is about a trading pipeline). If there is ANY plausible topical connection, or you are at all unsure, answer relevant. Dropping a useful memory is worse than keeping a marginal one. You do NOT see the assistant's answer. Output {"gate":"relevant"|"irrelevant"}.`;
var GATE_FORMAT = { type: "object", properties: { gate: { type: "string", enum: ["relevant", "irrelevant"] } }, required: ["gate"] };
var GATE_OPTS = { temperature: 0, top_p: 1, top_k: 0, presence_penalty: 0, frequency_penalty: 0 };
function parseRecallGateMode(env = process.env) {
  const v = env["NLM_HOOK_RECALL_GATE"]?.trim();
  return v === "shadow" || v === "live" ? v : void 0;
}
var GATE_TIMEOUT_MS = 4e3;
function makeOllamaGate(url, model = RECALL_GATE_MODEL, timeoutMs = GATE_TIMEOUT_MS) {
  return async (prompt, candidate) => {
    try {
      const r = await fetchWithTimeout(
        `${url}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            think: false,
            // Keep the gate model resident between fires so only the first fire
            // pays the cold-load; subsequent gates are ~1 judge call.
            keep_alive: "15m",
            format: GATE_FORMAT,
            options: GATE_OPTS,
            messages: [
              { role: "system", content: RECALL_GATE_SYSTEM },
              { role: "user", content: `USER PROMPT:
${prompt}

CANDIDATE CONTEXT:
${candidate}` }
            ]
          })
        },
        timeoutMs
      );
      const d = await r.json();
      const v = JSON.parse(d.message?.content ?? "{}").gate;
      return v === "irrelevant" ? "irrelevant" : "relevant";
    } catch {
      return "relevant";
    }
  };
}

// src/hook/prompt-recall-hook.ts
var SCORE_THRESHOLD = parseScoreFloor(process.env["NLM_RECALL_SCORE_FLOOR"]);
var RELATIVE_FLOOR = parseRelativeFloor(process.env["NLM_RECALL_REL_FLOOR"], 0.9);
var PER_FIRE_CAP = 3;
var PER_CONVERSATION_CAP = 10;
var PROMPT_PREVIEW_CHARS = 200;
function parseHookDeadline(raw) {
  if (raw === void 0) return 4e3;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 4e3;
}
var HOOK_DEADLINE_MS = parseHookDeadline(process.env["NLM_HOOK_DEADLINE_MS"]);
async function withDeadline(p, ms, fallback) {
  if (ms <= 0) return fallback;
  let timer;
  const timeout = new Promise((resolve2) => {
    timer = setTimeout(() => resolve2(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function hookRuntimeFromEnv(env = process.env) {
  const raw = env["NLM_HOOK_RUNTIME"]?.trim();
  return raw ? raw : "claude-code";
}
function promptRecallEnabled(env = process.env) {
  return env["NLM_HOOK_PROMPT_RECALL"]?.trim().toLowerCase() !== "off";
}
function buildRecallQuery(input, env = process.env) {
  if (env["NLM_HOOK_CONTEXT_RECALL"] !== "1") return input.prompt;
  if (!input.transcriptPath) return input.prompt;
  const minWords = Number.parseInt(env["NLM_HOOK_CONTEXT_MIN_WORDS"] ?? "3", 10);
  if (topicalWordCount(input.prompt) >= minWords) return input.prompt;
  const context = recentConversationContext(input.transcriptPath);
  return context ? `${context} ${input.prompt}` : input.prompt;
}
function normalizeRecall(raw) {
  if (Array.isArray(raw)) return { hits: raw, facts: [] };
  return raw;
}
async function runHook(input, deps) {
  const gate = classifyPrompt(input.prompt);
  const preview = input.prompt.slice(0, PROMPT_PREVIEW_CHARS);
  if (gate === "generative" || gate === "skip") {
    appendHookLog({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      conversationId: input.conversationId,
      promptPreview: preview,
      gate,
      hits: [],
      wouldInject: [],
      estTokens: 0,
      mode: deps.mode
    });
    return "";
  }
  const deadline = Date.now() + (deps.deadlineMs ?? HOOK_DEADLINE_MS);
  let fetched = { hits: [], facts: [] };
  try {
    fetched = normalizeRecall(
      await withDeadline(deps.recall(buildRecallQuery(input)), deadline - Date.now(), { hits: [], facts: [] })
    );
  } catch {
    fetched = { hits: [], facts: [] };
  }
  const hits = fetched.hits;
  const surfaced = loadSurfaced(input.conversationId);
  const selected = selectHits({
    hits,
    surfaced,
    scoreThreshold: SCORE_THRESHOLD,
    relativeFloor: RELATIVE_FLOOR,
    perFireCap: PER_FIRE_CAP,
    perConversationCap: PER_CONVERSATION_CAP
  });
  let gateDecisions;
  let injected = selected;
  if (deps.recallGate && selected.length > 0) {
    const g = deps.recallGate;
    const toGate = g.maxCandidates ? selected.slice(0, g.maxCandidates) : selected;
    const remaining = deadline - Date.now();
    const gateFallback = toGate.map((h) => ({ id: h.id, gate: "relevant" }));
    if (remaining <= 0) {
      gateDecisions = gateFallback;
    } else {
      gateDecisions = await withDeadline(
        Promise.all(toGate.map(async (h) => ({ id: h.id, gate: await g.judge(input.prompt, `${h.label}
${h.summary ?? ""}`) }))),
        remaining,
        gateFallback
      );
    }
    if (g.mode === "live") {
      const drop = new Set(gateDecisions.filter((d) => d.gate === "irrelevant").map((d) => d.id));
      injected = selected.filter((h) => !drop.has(h.id));
    }
  }
  const block = formatPointerBlock(injected, fetched.facts, fetched.exemplars);
  const estTokens = Math.ceil(block.length / 4);
  appendHookLog({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    conversationId: input.conversationId,
    promptPreview: preview,
    gate,
    hits: hits.map((h) => ({ id: h.id, score: h.matchScore })),
    wouldInject: injected.map((h) => h.id),
    estTokens,
    mode: deps.mode,
    ...gateDecisions ? { gateDecisions } : {}
  });
  if (deps.mode === "live" && injected.length > 0) {
    recordSurfaced(input.conversationId, injected.map((h) => h.id));
    return block;
  }
  return "";
}
async function main() {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const conversationId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : void 0;
    if (!prompt) return;
    if (!promptRecallEnabled()) return;
    const mode = hookModeFromEnv();
    const runtime = hookRuntimeFromEnv();
    const gateMode = parseRecallGateMode();
    const gateUrl = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";
    const gateTopN = Math.max(1, Number.parseInt(process.env["NLM_HOOK_RECALL_GATE_TOPN"] ?? "1", 10) || 1);
    const out = await runHook(
      { prompt, conversationId, ...transcriptPath ? { transcriptPath } : {} },
      {
        mode,
        recall: (q) => recallOverHttp(q, runtime, conversationId === "unknown" ? void 0 : conversationId),
        ...gateMode ? { recallGate: { mode: gateMode, judge: makeOllamaGate(gateUrl), maxCandidates: gateTopN } } : {}
      }
    );
    if (out) process.stdout.write(out);
  } catch {
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
export {
  buildRecallQuery,
  hookRuntimeFromEnv,
  parseHookDeadline,
  promptRecallEnabled,
  runHook
};
