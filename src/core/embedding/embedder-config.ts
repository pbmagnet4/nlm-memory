/**
 * Embedder lane configuration: provider, base URL, model and API key per lane.
 * Effective value precedence: persisted setting > env var > built-in default
 * (the same `{value, source}` reporting as classifier tuning).
 *
 * Env mapping — prose lane: NLM_EMBED_PROVIDER / NLM_EMBED_BASE_URL /
 * NLM_EMBED_MODEL / NLM_EMBED_API_KEY (the ollama base URL is NLM_OLLAMA_URL).
 * Code lane: provider, base URL and key follow the prose env; the model is
 * NLM_CODE_EMBED_MODEL.
 */

import { NO_STORED_EMBEDDER, type StoredEmbedderLane } from "@ports/embedder-settings-store.js";
import type { EmbeddingLane } from "./embedding-config.js";
import type { Tuned } from "@core/classifier/tuning.js";
import { DEFAULT_OPENAI_EMBED_MODEL } from "../../llm/openai-embedder-client.js";
import { DEFAULT_MODEL_REPO } from "../../llm/bundled-embedder-client.js";
import { DEFAULT_CODE_EMBED_MODEL } from "../../llm/ollama-code-embedder.js";

export const EMBEDDER_PROVIDERS = {
  prose: ["ollama", "openai", "bundled"],
  code: ["ollama", "openai"],
} as const satisfies Record<EmbeddingLane, readonly string[]>;

const DEFAULT_PROVIDER = "ollama";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";

export interface EmbedderLaneSettings {
  readonly provider: Tuned<string>;
  /** null for providers with no endpoint (bundled) or an openai lane with none configured. */
  readonly baseUrl: Tuned<string | null>;
  readonly model: Tuned<string>;
  readonly apiKey: Tuned<string | null>;
}

/** The plain values a client is built from. */
export interface EmbedderLaneValues {
  readonly provider: string;
  readonly baseUrl: string | null;
  readonly model: string;
  readonly apiKey: string | null;
}

function pick<T>(stored: T | null, env: T | null, fallback: T): Tuned<T> {
  if (stored !== null) return { value: stored, source: "setting" };
  if (env !== null) return { value: env, source: "env" };
  return { value: fallback, source: "default" };
}

function nonEmpty(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}

function defaultModel(lane: EmbeddingLane, provider: string): string {
  if (lane === "code") return DEFAULT_CODE_EMBED_MODEL;
  if (provider === "openai") return DEFAULT_OPENAI_EMBED_MODEL;
  if (provider === "bundled") return DEFAULT_MODEL_REPO;
  return DEFAULT_OLLAMA_EMBED_MODEL;
}

/**
 * The env API key is a credential for the env-configured endpoint: it applies
 * only while provider and base URL still equal what env alone resolves to, so
 * pointing a lane at another host never forwards it.
 */
export function resolveEmbedderLane(
  lane: EmbeddingLane,
  stored: StoredEmbedderLane,
  env: Record<string, string | undefined>,
): EmbedderLaneSettings {
  const settings = resolveWithEnvKey(lane, stored, env);
  if (stored.apiKey !== null || settings.apiKey.value === null) return settings;
  const fromEnv = resolveWithEnvKey(lane, NO_STORED_EMBEDDER, env);
  const sameEndpoint =
    settings.provider.value === fromEnv.provider.value && settings.baseUrl.value === fromEnv.baseUrl.value;
  return sameEndpoint ? settings : { ...settings, apiKey: { value: null, source: "default" } };
}

function resolveWithEnvKey(
  lane: EmbeddingLane,
  stored: StoredEmbedderLane,
  env: Record<string, string | undefined>,
): EmbedderLaneSettings {
  const provider = pick(stored.provider, nonEmpty(env["NLM_EMBED_PROVIDER"])?.toLowerCase() ?? null, DEFAULT_PROVIDER);
  const envModel = nonEmpty(env[lane === "code" ? "NLM_CODE_EMBED_MODEL" : "NLM_EMBED_MODEL"]);
  const isOllama = provider.value === "ollama";
  const baseUrl: Tuned<string | null> =
    stored.baseUrl !== null
      ? { value: stored.baseUrl, source: "setting" }
      : pick<string | null>(
          null,
          nonEmpty(env[isOllama ? "NLM_OLLAMA_URL" : "NLM_EMBED_BASE_URL"]),
          isOllama ? DEFAULT_OLLAMA_URL : null,
        );
  return {
    provider,
    baseUrl,
    model: pick(stored.model, envModel, defaultModel(lane, provider.value)),
    apiKey: pick<string | null>(stored.apiKey, nonEmpty(env["NLM_EMBED_API_KEY"]), null),
  };
}

export function laneValues(s: EmbedderLaneSettings): EmbedderLaneValues {
  return { provider: s.provider.value, baseUrl: s.baseUrl.value, model: s.model.value, apiKey: s.apiKey.value };
}

/** Env a child process needs to build this lane's embedder (read by buildEmbedder). Contains the API key: never log it. */
export function laneEnv(lane: EmbeddingLane, v: EmbedderLaneValues): Record<string, string> {
  // An empty key overrides any NLM_EMBED_API_KEY the child would inherit from the daemon env.
  const env: Record<string, string> = { NLM_EMBED_PROVIDER: v.provider, NLM_EMBED_API_KEY: v.apiKey ?? "" };
  env[lane === "code" ? "NLM_CODE_EMBED_MODEL" : "NLM_EMBED_MODEL"] = v.model;
  if (v.baseUrl) env[v.provider === "ollama" ? "NLM_OLLAMA_URL" : "NLM_EMBED_BASE_URL"] = v.baseUrl;
  return env;
}
