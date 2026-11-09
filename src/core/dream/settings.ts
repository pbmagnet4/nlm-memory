/**
 * Dreaming settings model (T1613).
 *
 * The single mutable home for the dreaming lane's runtime settings: the
 * dream model and the per-pass policy (contradiction, dedup) — enabled,
 * cadenceMs, sampleSize, maxInFlight, applyMode. Values are seeded once
 * from the existing NLM_DREAM_* env names the pass modules read at
 * registration (contradiction-pass.ts, dedup-pass.ts, judge.ts) and can
 * then be read/updated in memory; nothing here persists or touches the
 * network, and no hostnames, IPs or URLs live in this module.
 *
 * Invariants:
 *  - Env is the seed, not the source of truth after load: update() mutates
 *    the in-memory current values; the env is only re-read by reseed().
 *  - Every parse falls back to the pass defaults on a blank/invalid env
 *    value, same rule as the pass modules' positiveInt/flagEnabled.
 *  - update() validates the whole patch before applying any of it: an
 *    unknown pass name or a bad shape throws DreamSettingsError and leaves
 *    the current values untouched.
 *  - get/lastRuns return snapshots; callers cannot mutate the registry or
 *    the current settings through the returned objects.
 */

import { DEFAULT_DREAM_MODEL, DREAM_MODEL_ENV } from "./judge.js";

/** Env names — the ones the pass modules already read, plus the two new
 *  cadence knobs and the dedup in-flight cap named after their siblings. */
export const DREAM_CONTRADICTION_PASS_ENV = "NLM_DREAM_CONTRADICTION_PASS";
export const DREAM_CONTRADICTION_APPLY_ENV = "NLM_DREAM_CONTRADICTION_APPLY";
export const DREAM_CONTRADICTION_SAMPLE_ENV = "NLM_DREAM_CONTRADICTION_SAMPLE";
export const DREAM_CONTRADICTION_INFLIGHT_ENV = "NLM_DREAM_CONTRADICTION_MAX_INFLIGHT";
export const DREAM_CONTRADICTION_CADENCE_ENV = "NLM_DREAM_CONTRADICTION_CADENCE_MS";

export const DREAM_DEDUP_PASS_ENV = "NLM_DREAM_DEDUP_PASS";
export const DREAM_DEDUP_APPLY_ENV = "NLM_DREAM_DEDUP_APPLY";
export const DREAM_DEDUP_SAMPLE_ENV = "NLM_DREAM_DEDUP_SAMPLE";
export const DREAM_DEDUP_INFLIGHT_ENV = "NLM_DREAM_DEDUP_MAX_INFLIGHT";
export const DREAM_DEDUP_CADENCE_ENV = "NLM_DREAM_DEDUP_CADENCE_MS";

/** Defaults mirrored from the pass modules (each keeps its own copy). */
export const DEFAULT_PASS_CADENCE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CONTRADICTION_SAMPLE_SIZE = 20;
export const DEFAULT_DEDUP_SAMPLE_SIZE = 200;
/** oMLX serves 4 concurrent requests; more in-flight just queues at the gateway. */
export const DEFAULT_MAX_IN_FLIGHT = 4;

export type DreamPassName = "contradiction" | "dedup";
export const DREAM_PASS_NAMES: readonly DreamPassName[] = ["contradiction", "dedup"];

export type DreamApplyMode = "dry-run" | "apply";

export interface DreamPassSettings {
  enabled: boolean;
  cadenceMs: number;
  sampleSize: number;
  maxInFlight: number;
  applyMode: DreamApplyMode;
}

export interface DreamSettings {
  model: string;
  contradiction: DreamPassSettings;
  dedup: DreamPassSettings;
}

/** A rejected update: unknown pass, unknown key, or a field of the wrong shape. */
export class DreamSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamSettingsError";
  }
}

type EnvLike = Readonly<Record<string, string | undefined>>;

function flagEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function applyModeFromEnv(raw: string | undefined): DreamApplyMode {
  return flagEnabled(raw) ? "apply" : "dry-run";
}

/** The dream model: NLM_DREAM_MODEL when non-blank, else the default — same
 *  rule as dreamModelFromEnv in judge.ts. */
export function dreamModelSettingFromEnv(env: EnvLike): string {
  const raw = (env[DREAM_MODEL_ENV] ?? "").trim();
  return raw.length > 0 ? raw : DEFAULT_DREAM_MODEL;
}

function defaultPassSettings(env: EnvLike, opts: {
  enableEnv: string | undefined;
  applyEnv: string | undefined;
  sampleEnv: string | undefined;
  inflightEnv: string | undefined;
  cadenceEnv: string | undefined;
  sampleDefault: number;
}): DreamPassSettings {
  return {
    enabled: flagEnabled(opts.enableEnv),
    cadenceMs: positiveInt(opts.cadenceEnv, DEFAULT_PASS_CADENCE_MS),
    sampleSize: positiveInt(opts.sampleEnv, opts.sampleDefault),
    maxInFlight: positiveInt(opts.inflightEnv, DEFAULT_MAX_IN_FLIGHT),
    applyMode: applyModeFromEnv(opts.applyEnv),
  };
}

/** Pure seed from an env source: defaults everywhere the env is blank or invalid. */
export function dreamSettingsFromEnv(env: EnvLike): DreamSettings {
  return {
    model: dreamModelSettingFromEnv(env),
    contradiction: defaultPassSettings(env, {
      enableEnv: env[DREAM_CONTRADICTION_PASS_ENV],
      applyEnv: env[DREAM_CONTRADICTION_APPLY_ENV],
      sampleEnv: env[DREAM_CONTRADICTION_SAMPLE_ENV],
      inflightEnv: env[DREAM_CONTRADICTION_INFLIGHT_ENV],
      cadenceEnv: env[DREAM_CONTRADICTION_CADENCE_ENV],
      sampleDefault: DEFAULT_CONTRADICTION_SAMPLE_SIZE,
    }),
    dedup: defaultPassSettings(env, {
      enableEnv: env[DREAM_DEDUP_PASS_ENV],
      applyEnv: env[DREAM_DEDUP_APPLY_ENV],
      sampleEnv: env[DREAM_DEDUP_SAMPLE_ENV],
      inflightEnv: env[DREAM_DEDUP_INFLIGHT_ENV],
      cadenceEnv: env[DREAM_DEDUP_CADENCE_ENV],
      sampleDefault: DEFAULT_DEDUP_SAMPLE_SIZE,
    }),
  };
}

function copySettings(s: DreamSettings): DreamSettings {
  return { model: s.model, contradiction: { ...s.contradiction }, dedup: { ...s.dedup } };
}

/** Current values, seeded from the process env at module load. */
let current: DreamSettings = dreamSettingsFromEnv(process.env);

/** Snapshot of the current settings (mutating the copy changes nothing). */
export function getDreamSettings(): DreamSettings {
  return copySettings(current);
}

/** Re-seed the current values from an env source (default process.env),
 *  discarding any prior updates. Primarily a restart/test hook. */
export function reseedDreamSettings(env: EnvLike = process.env): DreamSettings {
  current = dreamSettingsFromEnv(env);
  return copySettings(current);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PASS_FIELDS: readonly string[] = ["enabled", "cadenceMs", "sampleSize", "maxInFlight", "applyMode"];
const APPLY_MODES: ReadonlySet<string> = new Set<DreamApplyMode>(["dry-run", "apply"]);

function validatePass(name: DreamPassName, patch: unknown): Partial<DreamPassSettings> {
  if (!isPlainObject(patch)) throw new DreamSettingsError(`dream settings: ${name} must be an object, got ${JSON.stringify(patch)}`);
  for (const key of Object.keys(patch)) {
    if (!PASS_FIELDS.includes(key)) throw new DreamSettingsError(`dream settings: unknown field "${key}" on pass "${name}"`);
  }
  const out: Partial<DreamPassSettings> = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new DreamSettingsError(`dream settings: ${name}.enabled must be a boolean`);
    out.enabled = patch.enabled;
  }
  for (const field of ["cadenceMs", "sampleSize", "maxInFlight"] as const) {
    if (patch[field] !== undefined) {
      const n = patch[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new DreamSettingsError(`dream settings: ${name}.${field} must be a positive integer`);
      }
      out[field] = n;
    }
  }
  if (patch.applyMode !== undefined) {
    if (typeof patch.applyMode !== "string" || !APPLY_MODES.has(patch.applyMode)) {
      throw new DreamSettingsError(`dream settings: ${name}.applyMode must be "dry-run" or "apply"`);
    }
    out.applyMode = patch.applyMode as DreamApplyMode;
  }
  return out;
}

/** Validate the whole patch before applying any of it (all-or-nothing). */
function validatePatch(patch: unknown): { model?: string; contradiction?: Partial<DreamPassSettings>; dedup?: Partial<DreamPassSettings> } {
  if (!isPlainObject(patch)) throw new DreamSettingsError(`dream settings: update patch must be an object, got ${JSON.stringify(patch)}`);
  for (const key of Object.keys(patch)) {
    if (key !== "model" && !(DREAM_PASS_NAMES as readonly string[]).includes(key)) {
      throw new DreamSettingsError(`dream settings: unknown pass or setting "${key}"`);
    }
  }
  const out: { model?: string; contradiction?: Partial<DreamPassSettings>; dedup?: Partial<DreamPassSettings> } = {};
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || patch.model.trim().length === 0) {
      throw new DreamSettingsError("dream settings: model must be a non-blank string");
    }
    out.model = patch.model.trim();
  }
  if (patch.contradiction !== undefined) out.contradiction = validatePass("contradiction", patch.contradiction);
  if (patch.dedup !== undefined) out.dedup = validatePass("dedup", patch.dedup);
  return out;
}

/**
 * Apply a partial update to the current settings: `{ model?, contradiction?, dedup? }`
 * with partial pass patches. Throws DreamSettingsError (leaving current
 * unchanged) on an unknown pass/field or a bad shape; returns the new snapshot.
 */
export function updateDreamSettings(patch: unknown): DreamSettings {
  const valid = validatePatch(patch);
  if (valid.model !== undefined) current.model = valid.model;
  if (valid.contradiction) Object.assign(current.contradiction, valid.contradiction);
  if (valid.dedup) Object.assign(current.dedup, valid.dedup);
  return copySettings(current);
}

/* ------------------------------------------------------------------ */
/* Last-run registry — in-memory only, one record per pass.            */
/* ------------------------------------------------------------------ */

export interface DreamRunRecord {
  readonly name: DreamPassName;
  /** ISO timestamp of the recorded run. */
  readonly ranAt: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface DreamLastRuns {
  readonly contradiction: DreamRunRecord | null;
  readonly dedup: DreamRunRecord | null;
}

const lastRunRegistry = new Map<DreamPassName, DreamRunRecord>();

/** Record (overwrite) the pass's last run. Throws on an unknown pass name
 *  or a non-object summary — this is where pass wiring reports completion. */
export function recordLastRun(name: unknown, summary: Readonly<Record<string, unknown>>): DreamRunRecord {
  if (typeof name !== "string" || !(DREAM_PASS_NAMES as readonly string[]).includes(name)) {
    throw new DreamSettingsError(`dream settings: unknown pass "${String(name)}" in recordLastRun`);
  }
  if (!isPlainObject(summary)) throw new DreamSettingsError(`dream settings: last-run summary for "${name}" must be an object`);
  const record: DreamRunRecord = { name: name as DreamPassName, ranAt: new Date().toISOString(), summary: { ...summary } };
  lastRunRegistry.set(record.name, record);
  return record;
}

/** Snapshot of the registry — null for a pass that hasn't run since load/reset. */
export function lastRuns(): DreamLastRuns {
  return {
    contradiction: lastRunRegistry.get("contradiction") ?? null,
    dedup: lastRunRegistry.get("dedup") ?? null,
  };
}

/** Clear the registry (restart/test hook). */
export function resetLastRuns(): void {
  lastRunRegistry.clear();
}
