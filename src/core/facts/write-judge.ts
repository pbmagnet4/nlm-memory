/**
 * Write-time fact judge (T734 / E3).
 *
 * When a new fact lands, retrieve up to five existing active facts that share
 * its (subject, predicate) or are its nearest neighbours by embedding, and ask
 * the classifier lane to choose one of:
 *
 *   KEEP_BOTH      both facts stand (the safe default)
 *   SKIP_NEW       the new fact restates an existing one
 *   SUPERSEDE_OLD  the new fact replaces one existing fact
 *
 * Nothing is ever deleted or overwritten: both outcomes go through
 * `markSuperseded`, so the loser stays in the table with `superseded_by` set.
 * Any failure, malformed reply or ambiguity collapses to KEEP_BOTH.
 *
 * NLM_FACT_JUDGE=off|shadow|on (default off). `shadow` appends each decision to
 * a jsonl log and changes nothing; `on` also applies SKIP_NEW and SUPERSEDE_OLD,
 * after the sweep guard confirms the batch does not mutate too large a share.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isTransientLLMError } from "@core/classifier/transient-error.js";
import { sharedClassifyLimiter, type Limiter } from "@core/classifier/inflight-limiter.js";
import { stripJsonFences } from "@core/classifier/prompt.js";
import { composeFactEmbedText } from "@core/facts/embed-backfill.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { guardSweep } from "@core/util/sweep-guard.js";
import type { FactStore } from "@ports/fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { Fact } from "@shared/types.js";

export type JudgeMode = "off" | "shadow" | "on";
export type JudgeAction = "KEEP_BOTH" | "SKIP_NEW" | "SUPERSEDE_OLD";

export const MAX_CANDIDATES = 5;
const DEFAULT_MAX_SHARE = 0.5;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

export function judgeModeFromEnv(env: NodeJS.ProcessEnv = process.env): JudgeMode {
  const raw = (env["NLM_FACT_JUDGE"] ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

export function judgeLogPath(): string {
  return process.env["NLM_FACT_JUDGE_LOG"] ?? tenantStatePath(DEFAULT_TEAM_ID, "fact-judge.jsonl");
}

export interface JudgeDecision {
  readonly action: JudgeAction;
  /** Existing fact the action refers to; null for KEEP_BOTH. */
  readonly targetId: string | null;
  readonly reason: string;
}

export interface JudgeOutcome {
  readonly newId: string;
  readonly decision: JudgeDecision;
  readonly candidateIds: ReadonlyArray<string>;
  /** Set when the decision is a forced KEEP_BOTH (why the model's answer was not used). */
  readonly fallback: string | null;
  readonly latencyMs: number;
}

export const JUDGE_SYSTEM_PROMPT = `You maintain a memory store of facts, each a (subject, predicate, value) triple. A NEW fact has arrived. Compare it with the EXISTING facts and choose exactly one action:

KEEP_BOTH: both can be true at the same time, or they describe different things, or you are unsure. This is the default.
SKIP_NEW: the new fact says the same thing as one existing fact (same subject, same predicate, same meaning). Nothing new is learned.
SUPERSEDE_OLD: the new fact states a newer value for the same single-valued attribute of the same subject, so one existing fact is now out of date.

Rules:
- Only SUPERSEDE_OLD when subject and predicate refer to the same attribute and the values cannot both be current. Different facets, lists, parallel items, or merely related facts are KEEP_BOTH.
- Never pick an action to tidy the store. When in doubt, KEEP_BOTH.
- "target" is the label (e1, e2, ...) of the existing fact SKIP_NEW or SUPERSEDE_OLD refers to; null for KEEP_BOTH.

Reply with one JSON object and nothing else:
{"action":"KEEP_BOTH"|"SKIP_NEW"|"SUPERSEDE_OLD","target":"e1"|null,"reason":"<one short sentence>"}`;

const label = (i: number): string => `e${i + 1}`;
const line = (f: Pick<Fact, "subject" | "predicate" | "value">): string => `${f.subject} | ${f.predicate} | ${f.value}`;

export function buildJudgePrompt(fresh: Fact, candidates: ReadonlyArray<Fact>): string {
  const existing = candidates.map((c, i) => `${label(i)} (${c.createdAt.slice(0, 10)}): ${line(c)}`).join("\n");
  return `NEW (${fresh.createdAt.slice(0, 10)}): ${line(fresh)}\n\nEXISTING:\n${existing}`;
}

const ACTIONS: ReadonlySet<string> = new Set<JudgeAction>(["KEEP_BOTH", "SKIP_NEW", "SUPERSEDE_OLD"]);

/** Strict parse of the model reply. Returns null on anything but a valid decision. */
export function parseJudgeReply(raw: string, candidates: ReadonlyArray<Fact>): JudgeDecision | null {
  const text = stripJsonFences(raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const action = typeof o["action"] === "string" ? o["action"].trim().toUpperCase() : "";
  if (!ACTIONS.has(action)) return null;
  const reason = typeof o["reason"] === "string" ? o["reason"].trim().slice(0, 300) : "";
  if (action === "KEEP_BOTH") return { action, targetId: null, reason };
  const target = typeof o["target"] === "string" ? o["target"].trim().toLowerCase() : "";
  const idx = candidates.findIndex((_, i) => label(i) === target);
  if (idx < 0) return null;
  return { action: action as JudgeAction, targetId: candidates[idx]!.id, reason };
}

const keepBoth = (reason: string): JudgeDecision => ({ action: "KEEP_BOTH", targetId: null, reason });

export interface JudgeDeps {
  readonly llm: LLMClient;
  readonly limiter?: Limiter;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Ask the model about one new fact. Never throws; every failure is a forced KEEP_BOTH. */
export async function judgeFact(deps: JudgeDeps, fresh: Fact, candidates: ReadonlyArray<Fact>): Promise<JudgeOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const candidateIds = candidates.map((c) => c.id);
  const done = (decision: JudgeDecision, fallback: string | null): JudgeOutcome => ({
    newId: fresh.id,
    decision,
    candidateIds,
    fallback,
    latencyMs: now() - t0,
  });
  if (candidates.length === 0) return done(keepBoth("no candidates"), null);
  if (!deps.llm.complete) return done(keepBoth("no chat lane"), "llm client has no complete()");

  const limiter = deps.limiter ?? sharedClassifyLimiter();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const prompt = buildJudgePrompt(fresh, candidates);
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await limiter.run(() => deps.llm.complete!(JUDGE_SYSTEM_PROMPT, prompt));
      const decision = parseJudgeReply(raw, candidates);
      if (decision) return done(decision, null);
      return done(keepBoth("unparseable reply"), "invalid reply");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (!isTransientLLMError(e) || attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  return done(keepBoth("llm error"), `llm error: ${lastError.slice(0, 200)}`);
}

export type JudgeStore = Pick<FactStore, "list" | "getByIds" | "semanticSearch" | "markSuperseded">;

const isActive = (f: Fact): boolean => f.supersededBy === null && (f.retiredAt ?? null) === null;

export interface CandidateOptions {
  readonly embedder?: LLMClient | undefined;
  /** Extra eligibility test (the offline replay uses it to hide facts newer than the one judged). */
  readonly accept?: (f: Fact) => boolean;
  readonly limit?: number;
}

/** Same-key active facts first, then nearest by embedding, at most `limit` (default 5). */
export async function findCandidates(
  store: JudgeStore,
  tenantId: string,
  fresh: Fact,
  opts: CandidateOptions = {},
): Promise<Fact[]> {
  const limit = opts.limit ?? MAX_CANDIDATES;
  const ok = (f: Fact): boolean => f.id !== fresh.id && isActive(f) && (opts.accept?.(f) ?? true);
  const picked = new Map<string, Fact>();
  const sameKey = await store.list(tenantId, { subject: fresh.subject, predicate: fresh.predicate, limit: limit * 4 });
  for (const f of sameKey) if (ok(f) && picked.size < limit) picked.set(f.id, f);
  if (picked.size < limit && opts.embedder) {
    try {
      const { vector } = await opts.embedder.embed(composeFactEmbedText(fresh.subject, fresh.predicate, fresh.value), "document");
      const near = await store.semanticSearch(tenantId, vector, limit * 4);
      const nearFacts = await store.getByIds(tenantId, near.map((n) => n.factId));
      const byId = new Map(nearFacts.map((f) => [f.id, f]));
      for (const n of near) {
        const f = byId.get(n.factId);
        if (f && ok(f) && picked.size < limit) picked.set(f.id, f);
      }
    } catch {
      // Embedding is best-effort; same-key candidates alone are still a valid pool.
    }
  }
  return [...picked.values()];
}

export interface JudgeLogEntry {
  readonly ts: string;
  readonly mode: JudgeMode;
  readonly newId: string;
  readonly action: JudgeAction;
  readonly targetId: string | null;
  readonly reason: string;
  readonly candidateIds: ReadonlyArray<string>;
  readonly fallback: string | null;
  readonly latencyMs: number;
  /** True only when `on` mode actually changed a row. */
  readonly applied: boolean;
  readonly guard?: string;
}

/** Append-only. Telemetry-style: a failed write warns and never throws. */
export function appendJudgeLog(entries: ReadonlyArray<JudgeLogEntry>, path: string = judgeLogPath()): void {
  if (entries.length === 0) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  } catch (e) {
    process.stderr.write(`[fact-judge] log write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export interface FactJudgeOptions extends JudgeDeps {
  readonly store: JudgeStore;
  readonly embedder?: LLMClient | undefined;
  readonly mode?: JudgeMode;
  /** Largest share of a batch `on` mode may supersede or skip. */
  readonly maxShare?: number;
  readonly logPath?: string;
  readonly auditPath?: string;
}

export class FactJudge {
  readonly mode: JudgeMode;

  constructor(private readonly opts: FactJudgeOptions) {
    this.mode = opts.mode ?? judgeModeFromEnv();
  }

  /**
   * Judge a batch of freshly written facts. Off: no-op. Shadow: log only.
   * On: apply the batch's SKIP_NEW and SUPERSEDE_OLD decisions unless the sweep
   * guard finds the batch would mutate more than the configured share.
   */
  async run(
    tenantId: string,
    facts: ReadonlyArray<Fact>,
    runOpts: { accept?: (f: Fact) => boolean } = {},
  ): Promise<JudgeOutcome[]> {
    if (this.mode === "off" || facts.length === 0) return [];
    const outcomes: JudgeOutcome[] = [];
    const now = this.opts.now ?? Date.now;
    for (const fact of facts) {
      const t0 = now();
      const candidates = await findCandidates(this.opts.store, tenantId, fact, {
        embedder: this.opts.embedder,
        ...(runOpts.accept ? { accept: runOpts.accept } : {}),
      });
      const outcome = await judgeFact(this.opts, fact, candidates);
      // Added latency per fact: candidate retrieval (embed + KNN) plus the model call.
      outcomes.push({ ...outcome, latencyMs: now() - t0 });
    }

    const mutating = outcomes.filter((o) => o.decision.action !== "KEEP_BOTH");
    const appliedIds = new Set<string>();
    let guardNote: string | undefined;
    if (this.mode === "on" && mutating.length > 0) {
      const maxShare = this.opts.maxShare ?? Number(process.env["NLM_FACT_JUDGE_MAX_SHARE"] ?? DEFAULT_MAX_SHARE);
      const verdict = guardSweep({
        sweep: "fact-judge",
        actor: "daemon",
        targetTotal: facts.length,
        touching: mutating.length,
        maxShare: Number.isFinite(maxShare) ? maxShare : DEFAULT_MAX_SHARE,
        ...(this.opts.auditPath ? { auditPath: this.opts.auditPath } : {}),
      });
      guardNote = verdict.reason;
      if (verdict.mode === "applied") {
        // A fact already used as a winner or loser in this batch is left alone, so two
        // facts that pick each other cannot both end up superseded.
        const touched = new Set<string>();
        for (const o of mutating) {
          const target = o.decision.targetId;
          if (target === null || touched.has(target) || touched.has(o.newId)) continue;
          await this.apply(tenantId, o);
          touched.add(target).add(o.newId);
          appliedIds.add(o.newId);
        }
      }
    }

    const ts = new Date().toISOString();
    appendJudgeLog(
      outcomes.map((o) => ({
        ts,
        mode: this.mode,
        newId: o.newId,
        action: o.decision.action,
        targetId: o.decision.targetId,
        reason: o.decision.reason,
        candidateIds: o.candidateIds,
        fallback: o.fallback,
        latencyMs: o.latencyMs,
        applied: appliedIds.has(o.newId),
        ...(guardNote ? { guard: guardNote } : {}),
      })),
      this.opts.logPath,
    );
    return outcomes;
  }

  /** Both actions keep the loser's row and point `superseded_by` at the survivor. */
  private async apply(tenantId: string, o: JudgeOutcome): Promise<void> {
    const target = o.decision.targetId;
    if (target === null) return;
    if (o.decision.action === "SUPERSEDE_OLD") await this.opts.store.markSuperseded(tenantId, target, o.newId);
    else if (o.decision.action === "SKIP_NEW") await this.opts.store.markSuperseded(tenantId, o.newId, target);
  }
}
