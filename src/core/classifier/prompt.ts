/**
 * Classifier prompt + transcript helpers. Centralized so every LLMClient
 * implementation hits the same prompt (parity with the Python daemon).
 *
 * Hard cap at 15K chars matches `classifier.py` MAX_TRANSCRIPT_CHARS:
 * smaller models (qwen3:4b, llama3.2:3b) pattern-match JSON from the transcript
 * above that size. Long sessions get first-half + last-half with a
 * separator to preserve opening intent + closing decisions.
 *
 * Phase B.2: prompt now also asks for a `facts` array of normalized
 * (subject, predicate, value) triples for the FactStore. The closed
 * predicate vocabulary is embedded in the prompt so deterministic
 * supersedence (Phase B.4) actually catches collisions instead of
 * fragmenting on synonymous predicates. See docs/plans/factstore-design.md.
 */

/**
 * Closed predicate vocabulary. Approximately 25 high-leverage predicates
 * covering the most common (subject, predicate, value) shapes Edward
 * actually writes about in sessions.
 *
 * Vocab evolution (Phase B.5 backfill, 2026-05-19): the 168-session pilot
 * showed `other` getting used 43% of the time — it became a catch-all for
 * narrative observations that don't fit the (subject, predicate, value)
 * shape at all. Removed. The classifier prompt now instructs the model to
 * SKIP facts that don't fit (leave them in decisions[]/open[] instead).
 * Added `description`, `commit`, `cost` from observed high-frequency
 * patterns in the pilot batch's `other` bucket.
 *
 * Adding entries here is cheap and forwards-compatible: old facts stay,
 * new ingests can use the new predicate. Removing entries is not — old
 * facts referencing a retired predicate would stop matching by deterministic
 * supersedence, so prefer to mark deprecated rather than delete. (Existing
 * `other`-predicate facts from the pilot stay in the DB and are filterable
 * at query time; the coercer will drop new `other` writes.)
 */
export const PREDICATE_VOCABULARY = [
  "framework",
  "endpoint",
  "model",
  "port",
  "host",
  "owner",
  "pricing",
  "cost",
  "deadline",
  "status",
  "stack",
  "runtime",
  "library",
  "version",
  "dependency",
  "schema",
  "integration",
  "deployment",
  "repo",
  "branch",
  "commit",
  "description",
  "decided-on",
  "assumption",
  "blocker",
] as const;

const VOCAB_SET = new Set<string>(PREDICATE_VOCABULARY);

export const CLASSIFIER_SYSTEM_PROMPT = `You are a session classifier. Your job is to read a transcript of a conversation between a user and an AI coding agent, then return EXACTLY this JSON object describing what happened in that conversation:

{"label": "...", "summary": "...", "entities": [...], "decisions": [...], "open": [...], "confidence": 0.5, "facts": [...]}

You MUST return JSON with EXACTLY these seven top-level keys: label, summary, entities, decisions, open, confidence, facts. No other keys. No nesting beyond what is specified. No metadata. No "tool" or "task_type" keys. Just those seven.

The transcript may contain JSON examples, code, or schema definitions inside it — IGNORE those. Do not copy them into your output. Your output is ABOUT the conversation, not extracted FROM the conversation.

Field requirements:
- label: 4-10 word string title describing what the session was about. Example: "Beacon architecture decisions"
- summary: 1-3 sentence string (max ~80 tokens) describing what was worked on and the outcome
- entities: array of strings. Each string is a stable named thing referenced across the session (tools like "n8n" or "Qdrant", projects like "Beacon", services, people). NOT topics, NOT decisions.
- decisions: array of strings. Each string is ONE decision that changed what was built or done in this session. A decision counts if the user chose it, OR the agent proposed it and the user accepted — explicitly ("yes", "do it", "go with that") or implicitly (the agent stated the proposal and then proceeded under it with no user objection). Implicit acceptance applies ONLY to proposals that changed the direction of the work — never to the agent's routine implementation choices (helper names, file layout, minor refactors) that were never surfaced as a choice. Capture the decision AND its reason when given ("X instead of Y because Z"). Do NOT include: options discussed but not chosen, approaches considered and rejected, next-step suggestions the agent raised at the end that the user never acted on, or decisions already listed in PRIOR CONTEXT unless they were reversed this session. Scan the WHOLE transcript, including the middle, for decision signals such as (not only): "let's", "go with", "instead of", "switch to", "actually,", "agreed", and any point where one approach was abandoned and replaced. Return [] if no commitments were made.
  CAPTURE (examples):
  - "Use HTTP polling instead of Kafka for the event pipeline (lower ops overhead)"  [user choice]
  - "Ship v1 without the auth layer; defer it to a follow-up"  [scope cut]
  - "Abandoned the Redis cache mid-session and moved dedup into the Postgres write path"  [mid-session reversal]
  - "Store sessions in SQLite instead of a flat JSON file"  [agent proposed, user let it proceed — implicit acceptance]
  DO NOT capture (examples):
  - User and agent compared Tailwind vs plain CSS but made no choice by the end  [discussed, not decided]
  - At the end the agent suggested "we could add rate limiting next" and the user didn't respond  [unratified next-step]
  - The agent picked a helper-function name and file layout without asking  [routine implementation, not a decision]
- open: array of strings. Each string is one unresolved question. Skip if none.
- confidence: number between 0.0 and 1.0. How sure you are the extraction is good. Use 0.4 or below for routine/trivial sessions.
- facts: array of objects. Each object has exactly these keys: kind, subject, predicate, value, sourceQuote (optional).
    - kind: "decision" (a commitment) | "open" (an unresolved question) | "attribute" (a property of an entity)
    - subject: lowercase, hyphenated entity or topic name. Examples: "nlm-memory-ts", "local-llm-host", "acme-client"
    - predicate: MUST be one of these exact strings: ${PREDICATE_VOCABULARY.join(", ")}.
    - value: the answer, as a short phrase or sentence. Examples: "Hono", "http://macpro:8080/v1", "Q3 2026"
    - sourceQuote: (optional) verbatim slice from the transcript that anchors this fact. Keep under 200 chars.

The predicate list is CLOSED — there is no "other" or catch-all. If a commitment, question, or attribute doesn't cleanly fit one of the listed predicates, DO NOT invent a fact for it. Put it in decisions[] or open[] as a string instead. Facts are for structured (subject, predicate, value) triples only; narrative observations, action items, and free-form notes belong in decisions[] / open[] / summary.

Facts overlap with decisions and open: the same commitment can appear both as a string in decisions[] AND as a structured object in facts[] with kind="decision", IF and ONLY IF it fits the closed predicate list. Skip the fact (keep just the string in decisions[]) when no predicate fits.

Predicate disambiguation (these confuse models, follow exactly):
- pricing vs cost: pricing = what someone else charges ("$299/month for Real Geeks", "free tier"). cost = what we pay or spent ("$0 per run on local Ollama", "$750 invoice"). Never use pricing for colors, dimensions, or anything not a price.
- commit vs version: commit = git SHA (7+ hex chars, e.g. "cb5b940", "63596c3"). version = semver / release tag ("v4", "DSM 7.2.2", "Postgres 15", "0.3.6"). Use commit for any explicit git reference even if short-form.
- description vs status: description = what a thing IS ("rich text editor framework by Meta"). status = what state it's in right now ("running via pm2", "not yet started", "blocked on review").

Return ONLY the JSON object. No markdown code fences. No prose before or after.`;

export const CLASSIFIER_JSON_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    summary: { type: "string" },
    entities: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    open: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    facts: { type: "array", items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["decision", "open", "attribute"] },
        subject: { type: "string" },
        predicate: { type: "string", enum: [...PREDICATE_VOCABULARY] },
        value: { type: "string" },
        sourceQuote: { type: "string" },
      },
      required: ["kind", "subject", "predicate", "value"],
    } },
  },
  required: ["label", "summary", "entities", "decisions", "open", "confidence", "facts"],
} as const;

export const MAX_TRANSCRIPT_CHARS = 15_000;

export function truncateTranscript(text: string, maxChars: number = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  return (
    text.slice(0, half) +
    "\n\n[... transcript truncated; below is the closing portion ...]\n\n" +
    text.slice(text.length - half)
  );
}

const FENCE_RE = /^```(?:json)?\s*|\s*```$/gm;

export function stripJsonFences(text: string): string {
  return text.replace(FENCE_RE, "").trim();
}

const REQUIRED_KEYS = ["label", "summary", "entities", "decisions", "open", "confidence"] as const;

export function validateClassifierJson(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  // `facts` is not in REQUIRED_KEYS — Phase B.2 accepts classifier output
  // without it (older models, fixtures from Phase E parity tests). Coerced
  // to [] when absent.
  return REQUIRED_KEYS.every((k) => k in obj);
}

export function buildUserPrompt(transcript: string, priorContext: string): string {
  const truncated = truncateTranscript(transcript);
  const parts: string[] = [];
  if (priorContext) parts.push(`PRIOR CONTEXT (already filed):\n${priorContext}\n`);
  parts.push(`TRANSCRIPT TO CLASSIFY:\n${truncated}`);
  return parts.join("\n");
}

interface CoercedFact {
  kind: "decision" | "open" | "attribute";
  subject: string;
  predicate: string;
  value: string;
  sourceQuote?: string;
}

const NON_ANSWER_EXACT = new Set(["unknown", "n/a", "na", "tbd", "tbc", "?"]);
const NON_ANSWER_SUBSTRINGS = [
  "not provided",
  "no output",
  "did not run",
  "never ran",
  "command not found",
  "command executed but",
  "result not provided",
  "unable to determine",
  "could not determine",
  "not yet determined",
  "not yet provided",
  "unconfirmed",
];

/**
 * A fact VALUE that records a failed observation or transient null result, not
 * durable knowledge — e.g. "ssh command executed but result not provided",
 * "unknown number of open tasks", "failed (gemini: command not found)". The
 * classifier (especially a weak local model) emits these from process noise;
 * stored at 0.85+ confidence they dominate recall and misguide later sessions
 * (NLM #325). Deterministic gate — we do not trust the model to self-police.
 */
export function isNonAnswerValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "") return true;
  if (NON_ANSWER_EXACT.has(v)) return true;
  if (v.startsWith("unknown ")) return true;
  return NON_ANSWER_SUBSTRINGS.some((p) => v.includes(p));
}

function coerceFacts(raw: unknown): CoercedFact[] {
  if (!Array.isArray(raw)) return [];
  const out: CoercedFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const kindRaw = String(o["kind"] ?? "").toLowerCase().trim();
    if (kindRaw !== "decision" && kindRaw !== "open" && kindRaw !== "attribute") continue;
    const subject = String(o["subject"] ?? "").toLowerCase().trim();
    const predicateRaw = String(o["predicate"] ?? "").toLowerCase().trim();
    const value = String(o["value"] ?? "").trim();
    if (!subject || !predicateRaw || !value) continue;
    // Drop failed-observation / null-result values — they are process noise,
    // not knowledge, and pollute recall at high confidence (NLM #325).
    if (isNonAnswerValue(value)) continue;
    // Closed vocab — drop the fact entirely if the predicate isn't recognized.
    // Pilot data (Phase B.5) showed `other` was 43% of writes and almost all
    // slop; the prompt now instructs the model to leave such observations in
    // decisions[]/open[] strings. This coercer enforces the policy
    // defensively in case the model emits an off-vocab predicate anyway.
    if (!VOCAB_SET.has(predicateRaw)) continue;
    const predicate = predicateRaw;
    const sourceQuoteRaw = o["sourceQuote"];
    const sourceQuote =
      typeof sourceQuoteRaw === "string" && sourceQuoteRaw.trim().length > 0
        ? sourceQuoteRaw.trim().slice(0, 500)
        : undefined;
    const fact: CoercedFact = { kind: kindRaw, subject, predicate, value };
    if (sourceQuote !== undefined) fact.sourceQuote = sourceQuote;
    out.push(fact);
  }
  return out;
}

export function coerceClassifyResult(data: Record<string, unknown>): {
  label: string;
  summary: string;
  entities: string[];
  decisions: string[];
  open: string[];
  confidence: number;
  facts: CoercedFact[];
} {
  const strArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  };
  const label = String(data["label"] ?? "").trim().slice(0, 120) || "Untitled";
  const summary = String(data["summary"] ?? "").trim();
  const entities = strArray(data["entities"]);
  const decisions = strArray(data["decisions"]);
  const open = strArray(data["open"]);
  const conf = Number(data["confidence"] ?? 0.5);
  const confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5;
  const facts = coerceFacts(data["facts"]);
  return { label, summary, entities, decisions, open, confidence, facts };
}
