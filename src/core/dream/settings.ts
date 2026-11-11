/**
 * Dreaming settings model (T1613, T1729).
 *
 * The single mutable home for the dreaming lane's runtime settings: the
 * dream model and the per-pass policy (contradiction, dedup, promotion).
 * The contradiction/dedup entries carry enabled, cadenceMs, sampleSize and
 * applyMode (plus maxInFlight on the contradiction pass, which runs the
 * judge worker pool); the promotion entry (T1729) carries enabled, mode,
 * sampleSize, windowDays, maxLines, maxBytes and minCorroboration. Values
 * are seeded once from the existing NLM_DREAM_* env names the pass modules
 * read at registration (contradiction-pass.ts, dedup-pass.ts, judge.ts,
 * promotion-pass.ts) and can then be read/updated in memory; nothing here
 * touches the network, and no hostnames, IPs or URLs live in this module.
 *
 * Invariants:
 *  - Env is the seed, not the source of truth after load: update() mutates
 *    the in-memory current values; the env is only re-read by reseed() and by
 *    the attach-at-startup fallback.
 *  - With a store attached (attachDreamSettingsStore, T1729) the stored row is
 *    the source of truth at startup and every accepted update writes through,
 *    so a Dreaming page edit survives a restart. Env is the fallback for a
 *    fresh install and for a row this module refuses to read.
 *  - Every parse falls back to the pass defaults on a blank/invalid env
 *    value, same rule as the pass modules' positiveInt/flagEnabled.
 *  - update() validates the whole patch before applying any of it: an
 *    unknown pass name or a bad shape throws DreamSettingsError and leaves
 *    the current values untouched.
 *  - Turning the contradiction pass to apply needs its precision gate
 *    (CONTRADICTION_APPLY_GATE) to have passed; env seeding stays the
 *    operator's own opt-in and is not gated. The stored row is read through
 *    the same gate: a row claiming contradiction apply does not smuggle apply
 *    past it on the next boot.
 *  - get/lastRuns return snapshots; callers cannot mutate the registry or
 *    the current settings through the returned objects.
 */

import { DEFAULT_DREAM_MODEL, DREAM_MODEL_ENV } from "./judge.js";
import { MAX_PROMOTION_BYTES, MAX_PROMOTION_LINES, MIN_CORROBORATION } from "./promotion.js";
import type { DreamSettingsStore } from "@ports/dream-settings-store.js";

/** Env names — the ones the pass modules already read, plus the two new
 *  cadence knobs named after their siblings. The dedup lane makes no LLM
 *  calls, so it has no in-flight cap env (that knob lives only on the
 *  contradiction pass that runs the judge worker pool). */
export const DREAM_CONTRADICTION_PASS_ENV = "NLM_DREAM_CONTRADICTION_PASS";
export const DREAM_CONTRADICTION_APPLY_ENV = "NLM_DREAM_CONTRADICTION_APPLY";
export const DREAM_CONTRADICTION_SAMPLE_ENV = "NLM_DREAM_CONTRADICTION_SAMPLE";
export const DREAM_CONTRADICTION_INFLIGHT_ENV = "NLM_DREAM_CONTRADICTION_MAX_INFLIGHT";
export const DREAM_CONTRADICTION_CADENCE_ENV = "NLM_DREAM_CONTRADICTION_CADENCE_MS";

export const DREAM_DEDUP_PASS_ENV = "NLM_DREAM_DEDUP_PASS";
export const DREAM_DEDUP_APPLY_ENV = "NLM_DREAM_DEDUP_APPLY";
export const DREAM_DEDUP_SAMPLE_ENV = "NLM_DREAM_DEDUP_SAMPLE";
export const DREAM_DEDUP_CADENCE_ENV = "NLM_DREAM_DEDUP_CADENCE_MS";

/** Promotion pass env names (T1729). These are the names the pass module has
 *  always read; they live here now because the settings module is the single
 *  seed, and promotion-pass.ts re-exports them from here. There is no env
 *  name for the corroboration floor — MIN_CORROBORATION is the constant, the
 *  settings value only overrides it at runtime. */
export const DREAM_PROMOTE_PASS_ENV = "NLM_DREAM_PROMOTE_PASS";
export const DREAM_PROMOTE_APPLY_ENV = "NLM_DREAM_PROMOTE_APPLY";
export const DREAM_PROMOTE_SAMPLE_ENV = "NLM_DREAM_PROMOTE_SAMPLE";
export const DREAM_PROMOTE_MAX_LINES_ENV = "NLM_DREAM_PROMOTE_MAX_LINES";
export const DREAM_PROMOTE_MAX_BYTES_ENV = "NLM_DREAM_PROMOTE_MAX_BYTES";
export const DREAM_PROMOTE_WINDOW_DAYS_ENV = "NLM_DREAM_PROMOTE_WINDOW_DAYS";

/** Defaults mirrored from the pass modules (each keeps its own copy). */
export const DEFAULT_PASS_CADENCE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CONTRADICTION_SAMPLE_SIZE = 20;
export const DEFAULT_DEDUP_SAMPLE_SIZE = 200;
/** oMLX serves 4 concurrent requests; more in-flight just queues at the gateway. */
export const DEFAULT_MAX_IN_FLIGHT = 4;
/** Mirrored from promotion-pass.ts (each keeps its own copy). */
export const DEFAULT_PROMOTION_SAMPLE_SIZE = 200;
export const DEFAULT_PROMOTION_WINDOW_DAYS = 30;

export type DreamPassName = "contradiction" | "dedup" | "promotion";
export const DREAM_PASS_NAMES: readonly DreamPassName[] = ["contradiction", "dedup", "promotion"];

export type DreamApplyMode = "dry-run" | "apply";

export interface DreamPassSettings {
  enabled: boolean;
  cadenceMs: number;
  sampleSize: number;
  maxInFlight: number;
  applyMode: DreamApplyMode;
}

/** Dedup pass policy: the dedup lane makes no LLM calls, so it has no
 *  in-flight cap to tune — maxInFlight lives only on the contradiction
 *  pass that runs the judge worker pool. */
export interface DreamDedupPassSettings {
  enabled: boolean;
  cadenceMs: number;
  sampleSize: number;
  applyMode: DreamApplyMode;
}

/** Promotion pass policy (T1729). `mode` rather than `applyMode`: dry-run and
 *  apply are the pass's own vocabulary, and the field set is its own shape —
 *  no cadence (the nightly interval is a constant), no in-flight cap (no LLM
 *  lane). The line/byte caps and the corroboration floor live here too, so
 *  one POST retunes a whole run. */
export interface DreamPromotionPassSettings {
  enabled: boolean;
  mode: DreamApplyMode;
  sampleSize: number;
  windowDays: number;
  maxLines: number;
  maxBytes: number;
  minCorroboration: number;
}

export interface DreamSettings {
  model: string;
  contradiction: DreamPassSettings;
  dedup: DreamDedupPassSettings;
  promotion: DreamPromotionPassSettings;
}

/** A rejected update: unknown pass, unknown key, or a field of the wrong shape. */
export class DreamSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamSettingsError";
  }
}

/** The precision gate standing between the settings surface and the
 *  contradiction pass writing anything (T1641).
 *
 *  Wiring GET/POST /api/dreaming opened a runtime switch into apply mode,
 *  which retires facts, so the switch is refused until the pass has proven it
 *  only contradicts facts that really are wrong. Env seeding is deliberately
 *  *not* gated: a deployment that sets NLM_DREAM_CONTRADICTION_APPLY opted in
 *  at boot, on purpose, and re-seeding on restart is its own path. */
export interface ContradictionApplyGate {
  readonly passed: boolean;
  /** What the gate was judged on — quoted verbatim into the refusal. */
  readonly evidence: string;
}

export const CONTRADICTION_APPLY_GATE = {
  passed: false,
  evidence: "T1609 relabel precision 0/6 (2026-11-09)",
} as const;

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

function basePassSettings(env: EnvLike, opts: {
  enableEnv: string | undefined;
  applyEnv: string | undefined;
  sampleEnv: string | undefined;
  cadenceEnv: string | undefined;
  sampleDefault: number;
}): Omit<DreamPassSettings, "maxInFlight"> {
  return {
    enabled: flagEnabled(opts.enableEnv),
    cadenceMs: positiveInt(opts.cadenceEnv, DEFAULT_PASS_CADENCE_MS),
    sampleSize: positiveInt(opts.sampleEnv, opts.sampleDefault),
    applyMode: applyModeFromEnv(opts.applyEnv),
  };
}

/** Pure seed from an env source: defaults everywhere the env is blank or invalid. */
export function dreamSettingsFromEnv(env: EnvLike): DreamSettings {
  return {
    model: dreamModelSettingFromEnv(env),
    contradiction: {
      ...basePassSettings(env, {
        enableEnv: env[DREAM_CONTRADICTION_PASS_ENV],
        applyEnv: env[DREAM_CONTRADICTION_APPLY_ENV],
        sampleEnv: env[DREAM_CONTRADICTION_SAMPLE_ENV],
        cadenceEnv: env[DREAM_CONTRADICTION_CADENCE_ENV],
        sampleDefault: DEFAULT_CONTRADICTION_SAMPLE_SIZE,
      }),
      maxInFlight: positiveInt(env[DREAM_CONTRADICTION_INFLIGHT_ENV], DEFAULT_MAX_IN_FLIGHT),
    },
    dedup: basePassSettings(env, {
      enableEnv: env[DREAM_DEDUP_PASS_ENV],
      applyEnv: env[DREAM_DEDUP_APPLY_ENV],
      sampleEnv: env[DREAM_DEDUP_SAMPLE_ENV],
      cadenceEnv: env[DREAM_DEDUP_CADENCE_ENV],
      sampleDefault: DEFAULT_DEDUP_SAMPLE_SIZE,
    }),
    promotion: {
      enabled: flagEnabled(env[DREAM_PROMOTE_PASS_ENV]),
      mode: applyModeFromEnv(env[DREAM_PROMOTE_APPLY_ENV]),
      sampleSize: positiveInt(env[DREAM_PROMOTE_SAMPLE_ENV], DEFAULT_PROMOTION_SAMPLE_SIZE),
      windowDays: positiveInt(env[DREAM_PROMOTE_WINDOW_DAYS_ENV], DEFAULT_PROMOTION_WINDOW_DAYS),
      maxLines: positiveInt(env[DREAM_PROMOTE_MAX_LINES_ENV], MAX_PROMOTION_LINES),
      maxBytes: positiveInt(env[DREAM_PROMOTE_MAX_BYTES_ENV], MAX_PROMOTION_BYTES),
      minCorroboration: MIN_CORROBORATION,
    },
  };
}

function copySettings(s: DreamSettings): DreamSettings {
  return {
    model: s.model,
    contradiction: { ...s.contradiction },
    dedup: { ...s.dedup },
    promotion: { ...s.promotion },
  };
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

const PASS_FIELDS: readonly string[] = ["enabled", "cadenceMs", "sampleSize", "applyMode"];
const INFLIGHT_FIELD = "maxInFlight";
const APPLY_MODES: ReadonlySet<string> = new Set<DreamApplyMode>(["dry-run", "apply"]);
/** Promotion-pass patch fields (T1729) — its own shape, hence its own list. */
const PROMOTION_FIELDS: readonly string[] = [
  "enabled", "mode", "sampleSize", "windowDays", "maxLines", "maxBytes", "minCorroboration",
];

function validatePass(name: DreamPassName, patch: unknown, opts: { allowInFlight: boolean }): Partial<DreamPassSettings> {
  if (!isPlainObject(patch)) throw new DreamSettingsError(`dream settings: ${name} must be an object, got ${JSON.stringify(patch)}`);
  for (const key of Object.keys(patch)) {
    const known = PASS_FIELDS.includes(key) || (opts.allowInFlight && key === INFLIGHT_FIELD);
    if (!known) throw new DreamSettingsError(`dream settings: unknown field "${key}" on pass "${name}"`);
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

/** Validate a promotion-pass patch: `mode` (not `applyMode`) plus the run
 *  knobs. Integer fields must be whole and positive (`minCorroboration`
 *  included — a 0 corroboration floor would let single-session facts into the
 *  injection set, which is exactly what the floor exists to stop). */
function validatePromotionPass(patch: unknown): Partial<DreamPromotionPassSettings> {
  if (!isPlainObject(patch)) throw new DreamSettingsError(`dream settings: promotion must be an object, got ${JSON.stringify(patch)}`);
  for (const key of Object.keys(patch)) {
    if (!PROMOTION_FIELDS.includes(key)) throw new DreamSettingsError(`dream settings: unknown field "${key}" on pass "promotion"`);
  }
  const out: Partial<DreamPromotionPassSettings> = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new DreamSettingsError("dream settings: promotion.enabled must be a boolean");
    out.enabled = patch.enabled;
  }
  if (patch.mode !== undefined) {
    if (typeof patch.mode !== "string" || !APPLY_MODES.has(patch.mode)) {
      throw new DreamSettingsError('dream settings: promotion.mode must be "dry-run" or "apply"');
    }
    out.mode = patch.mode as DreamApplyMode;
  }
  for (const field of ["sampleSize", "windowDays", "maxLines", "maxBytes", "minCorroboration"] as const) {
    if (patch[field] !== undefined) {
      const n = patch[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new DreamSettingsError(`dream settings: promotion.${field} must be a positive integer`);
      }
      out[field] = n;
    }
  }
  return out;
}

/** Validate the whole patch before applying any of it (all-or-nothing). */
function validatePatch(patch: unknown, gate: ContradictionApplyGate): {
  model?: string;
  contradiction?: Partial<DreamPassSettings>;
  dedup?: Partial<DreamDedupPassSettings>;
  promotion?: Partial<DreamPromotionPassSettings>;
} {
  if (!isPlainObject(patch)) throw new DreamSettingsError(`dream settings: update patch must be an object, got ${JSON.stringify(patch)}`);
  for (const key of Object.keys(patch)) {
    if (key !== "model" && !(DREAM_PASS_NAMES as readonly string[]).includes(key)) {
      throw new DreamSettingsError(`dream settings: unknown pass or setting "${key}"`);
    }
  }
  const out: {
    model?: string;
    contradiction?: Partial<DreamPassSettings>;
    dedup?: Partial<DreamDedupPassSettings>;
    promotion?: Partial<DreamPromotionPassSettings>;
  } = {};
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || patch.model.trim().length === 0) {
      throw new DreamSettingsError("dream settings: model must be a non-blank string");
    }
    out.model = patch.model.trim();
  }
  if (patch.contradiction !== undefined) out.contradiction = validatePass("contradiction", patch.contradiction, { allowInFlight: true });
  if (patch.dedup !== undefined) out.dedup = validatePass("dedup", patch.dedup, { allowInFlight: false });
  if (patch.promotion !== undefined) out.promotion = validatePromotionPass(patch.promotion);
  if (out.contradiction?.applyMode === "apply" && !gate.passed) {
    throw new DreamSettingsError(`dream settings: contradiction applyMode "apply" is refused until the precision gate passes (${gate.evidence}) — use "dry-run"`);
  }
  return out;
}

/**
 * Apply a partial update to the current settings: `{ model?, contradiction?, dedup? }`
 * with partial pass patches. Throws DreamSettingsError (leaving current
 * unchanged) on an unknown pass/field or a bad shape; returns the new snapshot.
 *
 * `gate` is the contradiction apply precision gate, defaulting to the recorded
 * one; it is a parameter rather than a module read so the passed branch is
 * testable without mutating module state. Every caller, the HTTP route
 * included, leaves it at the default.
 */
export function updateDreamSettings(patch: unknown, gate: ContradictionApplyGate = CONTRADICTION_APPLY_GATE): DreamSettings {
  const valid = validatePatch(patch, gate);
  if (valid.model !== undefined) current.model = valid.model;
  if (valid.contradiction) Object.assign(current.contradiction, valid.contradiction);
  if (valid.dedup) Object.assign(current.dedup, valid.dedup);
  if (valid.promotion) Object.assign(current.promotion, valid.promotion);
  const snapshot = copySettings(current);
  writeThrough(snapshot);
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* Persistence (T1729) — one stored document, written through.          */
/* ------------------------------------------------------------------ */

/** The store the daemon attaches at startup (see attachDreamSettingsStore).
 *  Null = in-memory only, the pre-T1729 behavior the unit tests run on. */
let store: DreamSettingsStore | null = null;
/** The last write-through's outcome. The write itself is chained so two
 *  accepted updates cannot interleave a half-written document, and its
 *  rejection is kept here for the route to await and surface as a 500. */
let lastWrite: Promise<void> = Promise.resolve();

/** Attach (or detach with null) the settings store. Binding does not write:
 *  a daemon that starts and never edits keeps a fresh database row-free, so
 *  "nothing stored" and "env only" stay distinguishable. */
export function attachDreamSettingsStore(next: DreamSettingsStore | null): void {
  store = next;
  lastWrite = Promise.resolve();
}

/** Whether a settings store is attached (the routes report the difference). */
export function dreamSettingsStoreAttached(): boolean {
  return store !== null;
}

/** Resolve when the most recent write-through settles; rejects if that write
 *  failed. Nothing is lost when nobody awaits it: the module already handles
 *  the rejection, so no unhandled rejection escapes from a CLI path. */
export async function flushedDreamSettingsWrite(): Promise<void> {
  await lastWrite;
}

function writeThrough(snapshot: DreamSettings): void {
  if (!store) return;
  const target = store;
  const write = Promise.resolve(lastWrite)
    .catch(() => undefined) // a previously surfaced failure does not block this write
    .then(() => target.save(snapshot));
  lastWrite = write;
  // The tail never rejects, so the chain keeps going; the awaited rejection
  // still reaches whoever calls flushedDreamSettingsWrite().
  void write.catch(() => undefined);
}

/**
 * Resolve the live settings from a stored document, over the env seed: a
 * stored value wins, anything the document omits falls back to env, then to
 * the built-in defaults (so a row written by an older build keeps loading).
 *
 * `clampedApply` reports the one thing the gate refuses to read through: a row
 * whose contradiction applyMode says "apply" while the precision gate has not
 * passed and env did not ask for apply on this run. Env seeding is the
 * operator's own opt-in, so an env apply stays untouched — same rule the live
 * update path enforces, applied to what is on disk.
 */
export function dreamSettingsFromStored(
  stored: unknown,
  env: EnvLike = process.env,
  gate: ContradictionApplyGate = CONTRADICTION_APPLY_GATE,
): { settings: DreamSettings; clampedApply: boolean } {
  const settings = dreamSettingsFromEnv(env);
  if (stored === null || stored === undefined) return { settings, clampedApply: false };
  if (!isPlainObject(stored)) {
    throw new DreamSettingsError(`dream settings: stored document must be an object, got ${JSON.stringify(stored)}`);
  }
  for (const key of Object.keys(stored)) {
    if (key !== "model" && !(DREAM_PASS_NAMES as readonly string[]).includes(key)) {
      throw new DreamSettingsError(`dream settings: unknown pass or setting "${key}" in the stored document`);
    }
  }
  if (stored.model !== undefined) {
    if (typeof stored.model !== "string" || stored.model.trim().length === 0) {
      throw new DreamSettingsError("dream settings: model must be a non-blank string");
    }
    settings.model = stored.model.trim();
  }
  if (stored.contradiction !== undefined) {
    Object.assign(settings.contradiction, validatePass("contradiction", stored.contradiction, { allowInFlight: true }));
  }
  if (stored.dedup !== undefined) {
    Object.assign(settings.dedup, validatePass("dedup", stored.dedup, { allowInFlight: false }));
  }
  if (stored.promotion !== undefined) {
    Object.assign(settings.promotion, validatePromotionPass(stored.promotion));
  }
  const clampedApply =
    settings.contradiction.applyMode === "apply"
    && !gate.passed
    && !flagEnabled(env[DREAM_CONTRADICTION_APPLY_ENV])
    && isPlainObject(stored.contradiction)
    && stored.contradiction.applyMode === "apply";
  if (clampedApply) settings.contradiction.applyMode = "dry-run";
  return { settings, clampedApply };
}

/**
 * Startup seam: attach the store and read the stored document into the live
 * settings, so later updates write through. Load order is stored row, else
 * env. A row this module cannot read (unparseable, unknown keys, bad shapes)
 * is logged and skipped rather than taking the daemon down — the env seed runs
 * instead, and the next accepted update repairs the row.
 */
export async function loadStoredDreamSettings(
  settingsStore: DreamSettingsStore,
  opts: {
    readonly env?: EnvLike;
    readonly gate?: ContradictionApplyGate;
    readonly logger?: (msg: string) => void;
  } = {},
): Promise<DreamSettings> {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? ((msg: string) => console.error(msg));
  const gate = opts.gate ?? CONTRADICTION_APPLY_GATE;
  attachDreamSettingsStore(settingsStore);
  let stored: unknown;
  try {
    stored = await settingsStore.load();
  } catch (e) {
    log(`[dream] stored settings unreadable (${e instanceof Error ? e.message : String(e)}) — using the env seed`);
    return reseedDreamSettings(env);
  }
  try {
    const { settings, clampedApply } = dreamSettingsFromStored(stored, env, gate);
    current = settings;
    if (clampedApply) {
      log(`[dream] stored contradiction applyMode "apply" refused while the precision gate has not passed (${gate.evidence}) — running dry-run`);
    }
    return copySettings(current);
  } catch (e) {
    log(`[dream] stored settings invalid (${e instanceof Error ? e.message : String(e)}) — using the env seed`);
    return reseedDreamSettings(env);
  }
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
  readonly promotion: DreamRunRecord | null;
}

const lastRunRegistry = new Map<DreamPassName, DreamRunRecord>();

function copyRecord(record: DreamRunRecord): DreamRunRecord {
  return { name: record.name, ranAt: record.ranAt, summary: { ...record.summary } };
}

/** Record (overwrite) the pass's last run. Throws on an unknown pass name
 *  or a non-object summary — this is where pass wiring reports completion.
 *  Returns a copy: mutating it cannot corrupt the registry. */
export function recordLastRun(name: unknown, summary: Readonly<Record<string, unknown>>): DreamRunRecord {
  if (typeof name !== "string" || !(DREAM_PASS_NAMES as readonly string[]).includes(name)) {
    throw new DreamSettingsError(`dream settings: unknown pass "${String(name)}" in recordLastRun`);
  }
  if (!isPlainObject(summary)) throw new DreamSettingsError(`dream settings: last-run summary for "${name}" must be an object`);
  const record: DreamRunRecord = { name: name as DreamPassName, ranAt: new Date().toISOString(), summary: { ...summary } };
  lastRunRegistry.set(record.name, record);
  return copyRecord(record);
}

/** Snapshot of the registry — null for a pass that hasn't run since load/reset.
 *  Every record is a copy: callers cannot mutate the registry through it. */
export function lastRuns(): DreamLastRuns {
  const contradiction = lastRunRegistry.get("contradiction");
  const dedup = lastRunRegistry.get("dedup");
  const promotion = lastRunRegistry.get("promotion");
  return {
    contradiction: contradiction ? copyRecord(contradiction) : null,
    dedup: dedup ? copyRecord(dedup) : null,
    promotion: promotion ? copyRecord(promotion) : null,
  };
}

/** Clear the registry (restart/test hook). */
export function resetLastRuns(): void {
  lastRunRegistry.clear();
}
