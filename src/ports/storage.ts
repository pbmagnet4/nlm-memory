/**
 * Storage — top-level handle for NLM's fact + session corpus. Owns lifecycle
 * (init/close). Read and write paths use the bare .facts / .sessions handles;
 * adapters manage atomicity internally via explicit BEGIN/COMMIT on a PoolClient
 * (PG) or a single WAL writer (SQLite).
 *
 * See docs/plans/2026-05-30-factstore-storage-port.md.
 */

import type { CodeExemplarStore } from "./code-exemplar-store.js";
import type { FactStore } from "./fact-store.js";
import type { SessionStore } from "./session-store.js";
import type { SignalStore } from "./signal-store.js";
import type { WorkstreamStore } from "./workstream-store.js";
// Registry ports are defined alongside their adapters (the SourceRow/ProviderRow
// domain types live there); these are type-only imports.
import type { SourceRegistryPort } from "@core/sources/source-registry.js";
import type { ProviderRegistryPort } from "@core/providers/provider-registry.js";

export interface Storage {
  readonly facts: FactStore;
  readonly sessions: SessionStore;
  readonly signals: SignalStore;
  readonly exemplars: CodeExemplarStore;
  readonly workstreams: WorkstreamStore;
  /** Transcript-source registry (claude-code/hermes/webhook/…). */
  readonly sources: SourceRegistryPort;
  /** LLM-provider registry (ollama/deepseek/openai/…). */
  readonly providers: ProviderRegistryPort;

  /** Apply migrations / install extensions. Idempotent. */
  init(): Promise<void>;

  /** Release the underlying connection or pool. */
  close(): Promise<void>;
}
