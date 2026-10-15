/**
 * Shared guard for destructive or bulk maintenance sweeps.
 *
 * A sweep reports how many rows it would touch out of a target set. The guard
 * refuses when that is more than a share of the set (default 80%) or would
 * leave fewer than a floor of rows, unless overridden. Every call appends one
 * JSONL audit line (sweep, counts, actor, timestamp, mode), including dry runs
 * and refusals, so the log shows what was decided and when.
 *
 * Both rules only bind once the target set has at least `minTarget` rows
 * (default 10): a store that small cannot be meaningfully "mostly swept".
 *
 * Env: NLM_SWEEP_MAX_SHARE, NLM_SWEEP_MIN_REMAINING, NLM_SWEEP_MIN_TARGET,
 * NLM_SWEEP_OVERRIDE=1, NLM_SWEEP_AUDIT_LOG (path). Telemetry-style writer:
 * an audit failure warns on stderr and never throws.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";

export const DEFAULT_MAX_SHARE = 0.8;
export const DEFAULT_MIN_REMAINING = 1;
export const DEFAULT_MIN_TARGET = 10;

export type SweepMode = "dry-run" | "applied" | "refused";

export interface SweepGuardInput {
  /** Stable sweep name, e.g. "reconcile-facts". */
  readonly sweep: string;
  /** Who runs it: a CLI command line label or "daemon". */
  readonly actor: string;
  /** Rows in the set the sweep selects from. */
  readonly targetTotal: number;
  /** Rows this run would change. */
  readonly touching: number;
  readonly dryRun?: boolean;
  /** Explicit override (flag); NLM_SWEEP_OVERRIDE=1 also overrides. */
  readonly override?: boolean | undefined;
  readonly maxShare?: number | undefined;
  readonly minRemaining?: number | undefined;
  readonly minTarget?: number | undefined;
  readonly auditPath?: string | undefined;
  readonly now?: () => Date;
}

export interface SweepDecision {
  readonly allowed: boolean;
  readonly overridden: boolean;
  readonly mode: SweepMode;
  readonly share: number;
  readonly remaining: number;
  readonly reason: string;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function sweepAuditPath(): string {
  return process.env["NLM_SWEEP_AUDIT_LOG"] ?? tenantStatePath(DEFAULT_TEAM_ID, "sweep-audit.jsonl");
}

/** Pure decision: would the guard let this sweep through? No I/O. */
export function evaluateSweep(input: SweepGuardInput): Omit<SweepDecision, "mode"> {
  const maxShare = input.maxShare ?? envNumber("NLM_SWEEP_MAX_SHARE", DEFAULT_MAX_SHARE);
  const minRemaining = input.minRemaining ?? envNumber("NLM_SWEEP_MIN_REMAINING", DEFAULT_MIN_REMAINING);
  const minTarget = input.minTarget ?? envNumber("NLM_SWEEP_MIN_TARGET", DEFAULT_MIN_TARGET);
  const overridden = input.override === true || process.env["NLM_SWEEP_OVERRIDE"] === "1";
  const share = input.targetTotal > 0 ? input.touching / input.targetTotal : 0;
  const remaining = Math.max(0, input.targetTotal - input.touching);

  let violation: string | null = null;
  if (input.touching > 0 && input.targetTotal >= minTarget) {
    if (share > maxShare) {
      violation = `would touch ${(share * 100).toFixed(1)}% of ${input.targetTotal} rows (limit ${(maxShare * 100).toFixed(0)}%)`;
    } else if (remaining < minRemaining) {
      violation = `would leave ${remaining} rows (floor ${minRemaining})`;
    }
  }
  if (violation === null) return { allowed: true, overridden: false, share, remaining, reason: "within guard" };
  if (overridden) return { allowed: true, overridden: true, share, remaining, reason: `${violation}; override set` };
  return {
    allowed: false,
    overridden: false,
    share,
    remaining,
    reason: `${violation}; pass the override flag or NLM_SWEEP_OVERRIDE=1 to proceed`,
  };
}

/**
 * Decide and audit in one step. Callers mutate only when
 * `decision.mode === "applied"`; a dry run reports the verdict it would get.
 */
export function guardSweep(input: SweepGuardInput): SweepDecision {
  const verdict = evaluateSweep(input);
  const mode: SweepMode = input.dryRun ? "dry-run" : verdict.allowed ? "applied" : "refused";
  const decision: SweepDecision = { ...verdict, mode };
  const path = input.auditPath ?? sweepAuditPath();
  const line = {
    ts: (input.now?.() ?? new Date()).toISOString(),
    sweep: input.sweep,
    actor: input.actor,
    mode,
    touching: input.touching,
    targetTotal: input.targetTotal,
    allowed: verdict.allowed,
    overridden: verdict.overridden,
    reason: verdict.reason,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
  } catch (e) {
    process.stderr.write(`[sweep-guard] audit write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return decision;
}

export function formatDecision(d: SweepDecision): string {
  return `guard: ${d.allowed ? "allow" : "REFUSE"} (${d.reason})`;
}
