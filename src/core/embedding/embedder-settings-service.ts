/**
 * Embedder settings service behind GET/PUT /api/embedder/settings and POST
 * /api/embedder/test. Pure orchestration over ports: stores, the live embedder
 * boxes and the rebuild job supervisor are injected.
 *
 * A candidate lane config is probed with one embed to learn its dimension.
 * - Same provider+model+dim as the vectors on disk (the `embedding_config`
 *   row): persist and swap the live embedder, no restart.
 * - Prose lane, anything else: the vectors are stale, so the change needs
 *   `confirm_reembed`; it then persists, swaps, and starts the existing
 *   `nlm embed-backfill` rebuild as a supervised daemon job.
 * - Code lane: only base_url / api_key may change (applied live). There is no
 *   code-lane re-embed yet (T1179), so a provider, model or dim change is refused.
 *
 * The API key never leaves this module except into a client or the rebuild
 * child's env; responses carry `api_key_set` only.
 */

import type { EmbedderLaneUpdate, EmbedderSettingsStore } from "@ports/embedder-settings-store.js";
import { applyEmbedderUpdate } from "@ports/embedder-settings-store.js";
import type { JobSnapshot, JobSupervisor } from "@core/jobs/job-supervisor.js";
import type { CodeEmbedderBox, EmbedderBox } from "../../llm/embedder-box.js";
import { buildCodeEmbedderFrom, buildEmbedderFrom } from "../../llm/build-embedder.js";
import type { FetchImpl } from "../../llm/openai-embedder-client.js";
import type { EmbeddingConfigStore, EmbeddingLane } from "./embedding-config.js";
import { reconcileLane } from "./embedding-config.js";
import {
  EMBEDDER_PROVIDERS,
  laneEnv,
  laneValues,
  resolveEmbedderLane,
  type EmbedderLaneSettings,
  type EmbedderLaneValues,
} from "./embedder-config.js";

export interface EmbedderSettingsDeps {
  readonly settings: EmbedderSettingsStore;
  readonly config: EmbeddingConfigStore;
  readonly prose: EmbedderBox;
  readonly code: CodeEmbedderBox;
  readonly jobs: Pick<JobSupervisor, "start" | "snapshot">;
  readonly env: Record<string, string | undefined>;
  /** Test seam: fetch used by candidate clients (openai providers). */
  readonly fetchImpl?: FetchImpl;
  /** Bound on every settings/test probe. Default 10s. */
  readonly probeTimeoutMs?: number;
}

export type LaneReconcile = "match" | "stale" | "recorded" | "unknown";

const PROBE_TEXT = "nlm dimension probe";
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const CODE_REEMBED_UNSUPPORTED =
  "changing a code-lane provider or model is not supported yet: there is no code-lane re-embed " +
  "(tracked as T1179). Only base_url and api_key can be edited.";

export interface ServiceResult {
  readonly status: 200 | 202 | 400 | 409 | 422;
  readonly body: Record<string, unknown>;
}

export interface LanePatch {
  readonly lane: EmbeddingLane;
  readonly update: EmbedderLaneUpdate;
  readonly confirmReembed: boolean;
}

function isLane(v: unknown): v is EmbeddingLane {
  return v === "prose" || v === "code";
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Boundary validation shared by PUT and the test endpoint; returns the patch or an error message. */
export function parseLanePatch(body: unknown): LanePatch | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const lane = b["lane"];
  if (!isLane(lane)) return 'lane must be "prose" or "code"';
  const update: { provider?: string | null; baseUrl?: string | null; model?: string | null; apiKey?: string | null } = {};
  if (b["provider"] !== undefined) {
    const p = b["provider"];
    if (p !== null) {
      const provider = typeof p === "string" ? p.toLowerCase() : "";
      if (!(EMBEDDER_PROVIDERS[lane] as readonly string[]).includes(provider)) {
        return `provider must be one of ${EMBEDDER_PROVIDERS[lane].join(", ")} or null`;
      }
      update.provider = provider;
    } else update.provider = null;
  }
  if (b["base_url"] !== undefined) {
    const u = b["base_url"];
    if (u !== null && (typeof u !== "string" || !isHttpUrl(u))) return "base_url must be an http(s) URL or null";
    update.baseUrl = u;
  }
  if (b["model"] !== undefined) {
    const m = b["model"];
    if (m !== null && (typeof m !== "string" || m.trim() === "")) return "model must be a non-empty string or null";
    update.model = m === null ? null : m.trim();
  }
  if (b["api_key"] !== undefined) {
    const k = b["api_key"];
    if (k !== null && (typeof k !== "string" || k === "")) return "api_key must be a non-empty string or null";
    update.apiKey = k;
  }
  const confirm = b["confirm_reembed"];
  if (confirm !== undefined && typeof confirm !== "boolean") return "confirm_reembed must be a boolean";
  return { lane, update, confirmReembed: confirm === true };
}

/** A generic probe failure: status or error class only, never upstream text (it may echo request details). */
function describeProbeError(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "probe failed: timed out";
  const text = e instanceof Error ? `${e.message} ${String((e.cause as { message?: unknown } | undefined)?.message ?? "")}` : "";
  const status = /(?:status|HTTP) (\d{3})/.exec(text);
  if (status) return `probe failed: HTTP ${status[1]}`;
  const code = /\b(ECONN[A-Z]+|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.exec(text);
  if (code) return `probe failed: ${code[1]}`;
  return `probe failed: ${e instanceof Error ? e.name : "error"}`;
}

interface Probe {
  readonly dim: number;
  readonly model: string;
  readonly latencyMs: number;
}

async function probe(lane: EmbeddingLane, v: EmbedderLaneValues, deps: EmbedderSettingsDeps): Promise<Probe> {
  const started = Date.now();
  const signal = probeSignal(deps);
  if (lane === "code") {
    const r = await buildCodeEmbedderFrom(v, deps.fetchImpl).embed(PROBE_TEXT, "query", signal);
    return { dim: r.dim, model: v.model, latencyMs: Date.now() - started };
  }
  const r = await buildEmbedderFrom(v, deps.fetchImpl).embed(PROBE_TEXT, "query", { signal });
  return { dim: r.vector.length, model: r.model, latencyMs: Date.now() - started };
}

function probeSignal(deps: EmbedderSettingsDeps): AbortSignal {
  return AbortSignal.timeout(deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
}

function tunedJson<T>(t: { value: T; source: string }): { value: T; source: string } {
  return { value: t.value, source: t.source };
}

function describeLane(
  deps: EmbedderSettingsDeps,
  lane: EmbeddingLane,
  s: EmbedderLaneSettings,
  dim: number | null,
): Record<string, unknown> {
  const stored = deps.config.getLane(lane);
  let reconcile: LaneReconcile = "unknown";
  if (dim !== null) {
    reconcile = reconcileLane(
      deps.config,
      { lane, provider: s.provider.value, model: s.model.value, dim },
      new Date().toISOString(),
    ).state;
  }
  return {
    lane,
    provider: tunedJson(s.provider),
    base_url: tunedJson(s.baseUrl),
    model: tunedJson(s.model),
    api_key_set: s.apiKey.value !== null,
    api_key_source: s.apiKey.source,
    providers: EMBEDDER_PROVIDERS[lane],
    provider_model_editable: lane === "prose",
    stored: stored ? { provider: stored.provider, model: stored.model, dim: stored.dim } : null,
    reconcile,
  };
}

function rebuildJob(deps: EmbedderSettingsDeps): JobSnapshot | null {
  const snap = deps.jobs.snapshot();
  return snap.state === "idle" ? null : snap;
}

async function effective(deps: EmbedderSettingsDeps, lane: EmbeddingLane): Promise<EmbedderLaneSettings> {
  return resolveEmbedderLane(lane, await deps.settings.get(lane), deps.env);
}

/** GET payload. Probes both live embedders concurrently, each bounded by the probe timeout; a failed or timed-out probe reports reconcile "unknown". */
export async function getEmbedderSettings(deps: EmbedderSettingsDeps): Promise<Record<string, unknown>> {
  const liveDim = async (lane: EmbeddingLane): Promise<number | null> => {
    try {
      const signal = probeSignal(deps);
      return lane === "prose"
        ? (await deps.prose.embed(PROBE_TEXT, "query", { signal })).vector.length
        : (await deps.code.embed(PROBE_TEXT, "query", signal)).dim;
    } catch {
      return null;
    }
  };
  const [prose, code] = await Promise.all([
    effective(deps, "prose").then(async (s) => describeLane(deps, "prose", s, await liveDim("prose"))),
    effective(deps, "code").then(async (s) => describeLane(deps, "code", s, await liveDim("code"))),
  ]);
  return { lanes: { prose, code }, rebuild_job: rebuildJob(deps) };
}

/**
 * Resolves the candidate lane. A stored or env API key is a credential for the
 * endpoint it was set for: when the patch moves provider or base URL and does
 * not bring its own key, the stored key is cleared (in the returned update too,
 * so a save persists that) and the env key stops applying.
 */
async function candidate(
  deps: EmbedderSettingsDeps,
  p: LanePatch,
): Promise<{ current: EmbedderLaneSettings; next: EmbedderLaneSettings; update: EmbedderLaneUpdate }> {
  const stored = await deps.settings.get(p.lane);
  const current = resolveEmbedderLane(p.lane, stored, deps.env);
  let next = resolveEmbedderLane(p.lane, applyEmbedderUpdate(stored, p.update), deps.env);
  let update = p.update;
  const moved = next.provider.value !== current.provider.value || next.baseUrl.value !== current.baseUrl.value;
  if (moved && p.update.apiKey === undefined) {
    update = { ...p.update, apiKey: null };
    next = resolveEmbedderLane(p.lane, applyEmbedderUpdate(stored, update), deps.env);
  }
  return { current, next, update };
}

/** POST /api/embedder/test: probe a candidate config; nothing is persisted. */
export async function testEmbedder(deps: EmbedderSettingsDeps, p: LanePatch): Promise<Record<string, unknown>> {
  const { next } = await candidate(deps, p);
  try {
    const r = await probe(p.lane, laneValues(next), deps);
    return { ok: true, dim: r.dim, model: r.model, latency_ms: r.latencyMs };
  } catch (e) {
    return { ok: false, error: describeProbeError(e) };
  }
}

/** PUT /api/embedder/settings. */
export async function saveEmbedderSettings(deps: EmbedderSettingsDeps, p: LanePatch): Promise<ServiceResult> {
  const { current, next, update } = await candidate(deps, p);
  const values = laneValues(next);

  // Code-lane identity is checked before probing: no code-lane re-embed exists
  // (T1179), and a different model at the same dim still invalidates the
  // vectors, so provider and model are compared as well as dim.
  if (p.lane === "code" && (next.provider.value !== current.provider.value || next.model.value !== current.model.value)) {
    return { status: 409, body: { error: CODE_REEMBED_UNSUPPORTED, requires_reembed: true } };
  }

  let probed: Probe;
  try {
    probed = await probe(p.lane, values, deps);
  } catch (e) {
    return { status: 422, body: { error: describeProbeError(e) } };
  }

  const vectors = deps.config.getLane(p.lane);
  if (p.lane === "code" && vectors !== null && vectors.dim !== probed.dim) {
    return { status: 409, body: { error: CODE_REEMBED_UNSUPPORTED, requires_reembed: true } };
  }

  const stale =
    p.lane === "prose" &&
    vectors !== null &&
    (vectors.provider !== next.provider.value || vectors.model !== next.model.value || vectors.dim !== probed.dim);

  if (vectors !== null && stale) {
    const detail = {
      stored: { provider: vectors.provider, model: vectors.model, dim: vectors.dim },
      candidate: { provider: next.provider.value, model: next.model.value, dim: probed.dim },
    };
    if (!p.confirmReembed) {
      return {
        status: 409,
        body: {
          error:
            "this change makes the stored vectors stale: every session and fact must be re-embedded. " +
            "Resend with confirm_reembed: true to apply it and start the rebuild.",
          requires_reembed: true,
          ...detail,
        },
      };
    }
    const running = rebuildJob(deps);
    if (running && (running.state === "running" || running.state === "stalled")) {
      return { status: 409, body: { error: "an embedding rebuild is already running", rebuild_job: running } };
    }
    await persistAndSwap(deps, p.lane, update, values);
    deps.jobs.start([], laneEnv(values));
    return { status: 202, body: { lane: describeLane(deps, p.lane, next, probed.dim), rebuild_job: rebuildJob(deps), ...detail } };
  }

  await persistAndSwap(deps, p.lane, update, values);
  return { status: 200, body: { lane: describeLane(deps, p.lane, next, probed.dim) } };
}

async function persistAndSwap(
  deps: EmbedderSettingsDeps,
  lane: EmbeddingLane,
  update: EmbedderLaneUpdate,
  values: EmbedderLaneValues,
): Promise<void> {
  await deps.settings.update(lane, update);
  if (lane === "prose") deps.prose.swap(buildEmbedderFrom(values, deps.fetchImpl));
  else deps.code.swap(buildCodeEmbedderFrom(values, deps.fetchImpl));
}
