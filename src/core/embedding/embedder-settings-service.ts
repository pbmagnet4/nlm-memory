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
}

export type LaneReconcile = "match" | "stale" | "recorded" | "unknown";

const PROBE_TEXT = "nlm dimension probe";
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

function redact(message: string, secret: string | null): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

interface Probe {
  readonly dim: number;
  readonly model: string;
  readonly latencyMs: number;
}

async function probe(lane: EmbeddingLane, v: EmbedderLaneValues, fetchImpl?: FetchImpl): Promise<Probe> {
  const started = Date.now();
  if (lane === "code") {
    const r = await buildCodeEmbedderFrom(v, fetchImpl).embed(PROBE_TEXT, "query");
    return { dim: r.dim, model: v.model, latencyMs: Date.now() - started };
  }
  const r = await buildEmbedderFrom(v, fetchImpl).embed(PROBE_TEXT, "query");
  return { dim: r.vector.length, model: r.model, latencyMs: Date.now() - started };
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

/** GET payload. Probes each live embedder once for its dimension; a probe failure reports reconcile "unknown". */
export async function getEmbedderSettings(deps: EmbedderSettingsDeps): Promise<Record<string, unknown>> {
  const lanes: Record<string, unknown> = {};
  for (const lane of ["prose", "code"] as const) {
    const s = await effective(deps, lane);
    let dim: number | null = null;
    try {
      dim = lane === "prose"
        ? (await deps.prose.embed(PROBE_TEXT, "query")).vector.length
        : (await deps.code.embed(PROBE_TEXT, "query")).dim;
    } catch {
      dim = null;
    }
    lanes[lane] = describeLane(deps, lane, s, dim);
  }
  return { lanes, rebuild_job: rebuildJob(deps) };
}

async function candidate(
  deps: EmbedderSettingsDeps,
  p: LanePatch,
): Promise<{ current: EmbedderLaneSettings; next: EmbedderLaneSettings }> {
  const stored = await deps.settings.get(p.lane);
  return {
    current: resolveEmbedderLane(p.lane, stored, deps.env),
    next: resolveEmbedderLane(p.lane, applyEmbedderUpdate(stored, p.update), deps.env),
  };
}

/** POST /api/embedder/test: probe a candidate config; nothing is persisted. */
export async function testEmbedder(deps: EmbedderSettingsDeps, p: LanePatch): Promise<Record<string, unknown>> {
  const { next } = await candidate(deps, p);
  try {
    const r = await probe(p.lane, laneValues(next), deps.fetchImpl);
    return { ok: true, dim: r.dim, model: r.model, latency_ms: r.latencyMs };
  } catch (e) {
    return { ok: false, error: redact(e instanceof Error ? e.message : String(e), next.apiKey.value) };
  }
}

/** PUT /api/embedder/settings. */
export async function saveEmbedderSettings(deps: EmbedderSettingsDeps, p: LanePatch): Promise<ServiceResult> {
  const { current, next } = await candidate(deps, p);
  const values = laneValues(next);

  // Code-lane identity is checked before probing: no code-lane re-embed exists
  // (T1179), and a different model at the same dim still invalidates the
  // vectors, so provider and model are compared as well as dim.
  if (p.lane === "code" && (next.provider.value !== current.provider.value || next.model.value !== current.model.value)) {
    return { status: 409, body: { error: CODE_REEMBED_UNSUPPORTED, requires_reembed: true } };
  }

  let probed: Probe;
  try {
    probed = await probe(p.lane, values, deps.fetchImpl);
  } catch (e) {
    return {
      status: 422,
      body: { error: `candidate embedder failed its probe: ${redact(e instanceof Error ? e.message : String(e), values.apiKey)}` },
    };
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
    await persistAndSwap(deps, p, values);
    deps.jobs.start([], laneEnv(values));
    return { status: 202, body: { lane: describeLane(deps, p.lane, next, probed.dim), rebuild_job: rebuildJob(deps), ...detail } };
  }

  await persistAndSwap(deps, p, values);
  return { status: 200, body: { lane: describeLane(deps, p.lane, next, probed.dim) } };
}

async function persistAndSwap(
  deps: EmbedderSettingsDeps,
  p: LanePatch,
  values: EmbedderLaneValues,
): Promise<void> {
  await deps.settings.update(p.lane, p.update);
  if (p.lane === "prose") deps.prose.swap(buildEmbedderFrom(values, deps.fetchImpl));
  else deps.code.swap(buildCodeEmbedderFrom(values, deps.fetchImpl));
}
