/**
 * ScanScheduler — periodic ingest loop. Ports `scheduler.py`.
 *
 * Each tick walks the registered adapters, runs scanOnce to discover idle
 * transcript files, classifies the resulting SessionChunks via the active
 * classifier, and persists them through SqliteSessionStore.insertSession
 * with the embedder. Records adapter_state after each successful insert
 * so the next tick is incremental.
 *
 * Single-process: the scheduler runs alongside the HTTP server (Phase D
 * wires it into `nlm start`). No worker thread; Node's event loop is
 * enough — adapter discovery is filesystem-bound and the per-chunk
 * classify call is async-awaited with a wall-clock timeout to keep the
 * tick loop responsive.
 *
 * Confidence floor of 0.3 mirrors Python: classifier outputs below that
 * are skipped rather than persisted as low-quality noise.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LLMClient } from "@ports/llm-client.js";
import type { TranscriptAdapter } from "@ports/transcript-adapter.js";
import type { SignalStore } from "@ports/signal-store.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { drainSessionExemplars } from "@core/exemplars/capture-from-session.js";
import { extractFacts } from "@core/facts/extract-facts.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "@core/storage/sqlite-session-store.js";
import { PgSessionStore } from "@core/storage/pg-session-store.js";
import type { PgFactStore } from "@core/storage/pg-fact-store.js";
import type { Fact, Signal } from "@shared/types.js";
import { MAX_CLASSIFY_FAILURES, recordClassified, recordClassifiedPg, recordFailed, recordFailedPg, recordSkippedLowConfidence, recordSkippedLowConfidencePg, scanOnce, scanOncePg } from "./scan-once.js";
import { runCheapChecksOnSqlite } from "@core/integrity/check-invariants.js";
import { classifyAdaptive } from "@core/classifier/hierarchical-classify.js";
import { TimeoutError } from "@core/util/with-timeout.js";
import { bindSessionToWorkstream } from "@core/workstream/bind.js";
import { parseWorkTopics, aliasToLabelMap } from "@core/workstream/work-topics.js";

function bindWorkstreamsEnabled(): boolean {
  return process.env["NLM_WORKSTREAM_BIND"] === "true";
}

function loadAliasToLabel(): Map<string, string> {
  try {
    const raw = readFileSync(join(homedir(), ".nlm", "work-topics.json"), "utf8");
    return aliasToLabelMap(parseWorkTopics(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 min, matches Python default
const DEFAULT_CLASSIFY_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIDENCE_FLOOR = 0.3;
const DEFAULT_IDLE_MINUTES = 15;
const DEFAULT_EXEMPLAR_MAX_PER_BUCKET = 50;
const BODY_CAP = 200_000;

function exemplarMaxPerBucket(): number {
  const raw = process.env["NLM_EXEMPLAR_MAX_PER_BUCKET"];
  if (raw === undefined) return DEFAULT_EXEMPLAR_MAX_PER_BUCKET;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_EXEMPLAR_MAX_PER_BUCKET;
}
const INTEGRITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

interface IntegrityCache {
  readonly checkedAt: string;
}

function integrityCheckCachePath(): string {
  return process.env["NLM_INTEGRITY_CACHE"] ?? join(homedir(), ".nlm", "integrity-check.json");
}

function shouldRunIntegrityCheck(now: number): boolean {
  try {
    const raw = readFileSync(integrityCheckCachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<IntegrityCache>;
    if (typeof parsed.checkedAt === "string") {
      return now - Date.parse(parsed.checkedAt) >= INTEGRITY_CHECK_INTERVAL_MS;
    }
  } catch {
    // cache missing or corrupt — run the check
  }
  return true;
}

function markIntegrityCheckRan(now: number): void {
  try {
    const path = integrityCheckCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ checkedAt: new Date(now).toISOString() }, null, 2), "utf8");
  } catch {
    // cache write failure is non-fatal
  }
}

export interface SchedulerOptions {
  readonly store: SqliteSessionStore | PgSessionStore;
  readonly adapters: ReadonlyArray<TranscriptAdapter>;
  readonly classifier: LLMClient;
  readonly embedder?: LLMClient | null;
  /**
   * FactStore for Phase B.2 fact ingest. When provided, the scheduler
   * extracts facts from each classify result and persists them atomically
   * with the session row. Optional — when null, sessions ingest as before
   * with no facts written (backwards-compatible default for tests not yet
   * updated, and for any future caller that wants facts off).
   */
  readonly factStore?: SqliteFactStore | PgFactStore | null;
  /** SignalStore for the self-improvement lane. When set, the tick drains
   *  each chunk's embedded nlm.signal payloads, decoupled from classification. */
  readonly signalStore?: SignalStore | null;
  /** Per-install scope stamped on drained signals. Required when signalStore is set. */
  readonly installScope?: string;
  /** Code-exemplar store. When set + NLM_CODE_EXEMPLARS_ENABLED=1, the tick
   *  captures exemplars from committed sessions after they are stored. */
  readonly exemplarStore?: CodeExemplarStore | null;
  /** Code embedder for exemplar vectors (CodeRankEmbed). */
  readonly codeEmbedder?: CodeEmbedder | null;
  /** WorkstreamStore for flag-gated session binding. When set and
   *  NLM_WORKSTREAM_BIND=true, each ingested session is bound to a workstream. */
  readonly workstreams?: WorkstreamStore | null;
  /** Provider and model name of the active classifier, for provenance stamping. */
  readonly classifierDescriptor?: { readonly provider: string; readonly model: string };
  readonly intervalMs?: number;
  readonly classifyTimeoutMs?: number;
  readonly confidenceFloor?: number;
  readonly idleMinutes?: number;
  /** Defaults to console.error. Set to a noop in tests. */
  readonly logger?: (msg: string) => void;
}

export interface TickReport {
  readonly inserted: number;
  readonly skippedLowConfidence: number;
  readonly classifyFailures: number;
  readonly storageFailures: number;
  readonly chunksSeen: number;
}

export class ScanScheduler {
  private readonly opts: Required<Omit<SchedulerOptions, "embedder" | "factStore" | "signalStore" | "installScope" | "exemplarStore" | "codeEmbedder" | "workstreams" | "classifierDescriptor">> & {
    readonly embedder: LLMClient | null;
    readonly factStore: SqliteFactStore | PgFactStore | null;
    readonly signalStore: SignalStore | null;
    readonly installScope: string;
    readonly exemplarStore: CodeExemplarStore | null;
    readonly codeEmbedder: CodeEmbedder | null;
    readonly workstreams: WorkstreamStore | null;
    readonly classifierDescriptor: { readonly provider: string; readonly model: string } | undefined;
  };
  private readonly aliasToLabel: ReadonlyMap<string, string>;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SchedulerOptions) {
    this.opts = {
      store: opts.store,
      adapters: opts.adapters,
      classifier: opts.classifier,
      embedder: opts.embedder ?? null,
      factStore: opts.factStore ?? null,
      signalStore: opts.signalStore ?? null,
      installScope: opts.installScope ?? "default",
      exemplarStore: opts.exemplarStore ?? null,
      codeEmbedder: opts.codeEmbedder ?? null,
      workstreams: opts.workstreams ?? null,
      classifierDescriptor: opts.classifierDescriptor,
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      classifyTimeoutMs: opts.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
      confidenceFloor: opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
      idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      logger: opts.logger ?? ((msg) => console.error(msg)),
    };
    this.aliasToLabel = loadAliasToLabel();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext(this.opts.intervalMs));
    }, delayMs);
  }

  async tick(): Promise<TickReport> {
    let inserted = 0;
    let skippedLowConfidence = 0;
    let classifyFailures = 0;
    let storageFailures = 0;
    let chunksSeen = 0;

    const now = Date.now();
    // Backend split: exactly one of (_pgPool, sqliteDb) is non-null. PG branches
    // use the pool; SQLite branches use the raw better-sqlite3 handle.
    const store = this.opts.store;
    const _pgPool = store instanceof PgSessionStore ? store.pool : null;
    const sqliteDb = store instanceof PgSessionStore ? null : store.rawDb();
    if (!_pgPool && shouldRunIntegrityCheck(now)) {
      try {
        const violations = runCheapChecksOnSqlite(sqliteDb!);
        markIntegrityCheckRan(now);
        for (const v of violations) {
          this.opts.logger(`[integrity] FAIL ${v.id} count=${v.count} ${v.description}  run \`nlm doctor\` to inspect or \`nlm doctor --fix\` to repair`);
        }
      } catch (e) {
        this.opts.logger(`[integrity] check error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    for (const adapter of this.opts.adapters) {
      let results;
      try {
        results = _pgPool
          ? await scanOncePg(adapter, this.opts.idleMinutes, _pgPool)
          : await scanOnce(adapter, this.opts.idleMinutes, sqliteDb!);
      } catch (e) {
        this.opts.logger(
          `[scheduler] scanOnce error for ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      for (const { chunk, supersedes, fileSize } of results) {
        chunksSeen += 1;
        await this.drainSignals(chunk);

        let classification;
        try {
          classification = await classifyAdaptive(chunk.text, this.opts.classifier, {
            perCallTimeoutMs: this.opts.classifyTimeoutMs,
          });
        } catch (e) {
          classifyFailures += 1;
          const reason = e instanceof TimeoutError ? "timed out" : `error: ${e instanceof Error ? e.message : String(e)}`;
          let count: number;
          if (_pgPool) {
            count = await recordFailedPg(_pgPool, adapter.name, chunk.sourcePath, fileSize);
          } else {
            recordFailed(sqliteDb!, adapter.name, chunk.sourcePath, fileSize);
            count = sqliteDb!
              .prepare<[string, string], { failure_count: number }>(
                "SELECT COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ? AND source_path = ?",
              )
              .get(adapter.name, chunk.sourcePath)?.failure_count ?? 1;
          }
          const ceiling = count >= MAX_CLASSIFY_FAILURES ? ` (failure ${count}/${MAX_CLASSIFY_FAILURES} — will skip until file grows)` : ` (failure ${count}/${MAX_CLASSIFY_FAILURES})`;
          this.opts.logger(`[scheduler] classifier ${reason} for ${chunk.id}${ceiling}`);
          continue;
        }

        if (classification.confidence < this.opts.confidenceFloor) {
          skippedLowConfidence += 1;
          if (_pgPool) {
            await recordSkippedLowConfidencePg(_pgPool, adapter.name, chunk.sourcePath, fileSize);
          } else {
            recordSkippedLowConfidence(sqliteDb!, adapter.name, chunk.sourcePath, fileSize);
          }
          this.opts.logger(
            `[scheduler] low-confidence (${classification.confidence} < ${this.opts.confidenceFloor}) for ${chunk.id} - skipping until file grows`,
          );
          continue;
        }

        const record: IngestRecord = {
          id: chunk.id,
          runtime: chunk.runtime,
          runtimeSessionId: chunk.runtimeSessionId || null,
          startedAt: chunk.startedAt,
          endedAt: chunk.endedAt || null,
          durationMin: chunk.durationMin,
          label: classification.label,
          summary: classification.summary,
          body: chunk.text.slice(0, BODY_CAP),
          status: "closed",
          transcriptKind: adapter.transcriptKind,
          transcriptPath: chunk.sourcePath,
          transcriptOffset: chunk.byteRange[0],
          transcriptLength: chunk.byteRange[1],
          entities: classification.entities,
          decisions: classification.decisions,
          openQuestions: classification.open,
          ...(this.opts.classifierDescriptor !== undefined
            ? { classifier: { ...this.opts.classifierDescriptor, confidence: classification.confidence } }
            : {}),
        };

        const supersedesArg = supersedes ? { priorSessionId: supersedes, kind: "replaces" as const } : null;
        const facts: ReadonlyArray<Fact> = this.opts.factStore
          ? extractFacts(classification, chunk.id, chunk.startedAt)
          : [];

        try {
          // Store + factStore are constructed from the same backend, so the
          // factStore cast below is sound — TS just can't correlate the two
          // union members across a single call site.
          if (store instanceof PgSessionStore) {
            await store.insertSession(record, this.opts.embedder, supersedesArg,
              this.opts.factStore ? { factStore: this.opts.factStore as PgFactStore, facts } : null);
          } else {
            await store.insertSession(record, this.opts.embedder, supersedesArg,
              this.opts.factStore ? { factStore: this.opts.factStore as SqliteFactStore, facts } : null);
          }
          if (_pgPool) {
            await recordClassifiedPg(_pgPool, adapter.name, chunk.sourcePath, chunk.id, fileSize);
          } else {
            recordClassified(sqliteDb!, adapter.name, chunk.sourcePath, chunk.id, fileSize);
          }
          inserted += 1;
          if (bindWorkstreamsEnabled() && this.opts.workstreams) {
            await bindSessionToWorkstream(
              {
                namer: this.opts.classifier,
                workstreams: this.opts.workstreams,
                sessions: this.opts.store,
                aliasToLabel: this.aliasToLabel,
                log: this.opts.logger,
              },
              {
                sessionId: chunk.id,
                label: classification.label,
                summary: classification.summary,
                ...(record.body != null ? { body: record.body } : {}),
                entities: classification.entities,
                startedAt: chunk.startedAt,
              },
            );
          }
          if (this.opts.exemplarStore && this.opts.installScope) {
            await drainSessionExemplars(
              {
                sessionId: chunk.id,
                projectDir: chunk.projectDir,
                text: chunk.text,
                startedAt: chunk.startedAt,
                summary: classification.summary,
                decisions: classification.decisions,
                installScope: this.opts.installScope,
              },
              { exemplarStore: this.opts.exemplarStore, codeEmbedder: this.opts.codeEmbedder, logger: this.opts.logger },
            );
          }
        } catch (e) {
          storageFailures += 1;
          if (_pgPool) {
            await recordFailedPg(_pgPool, adapter.name, chunk.sourcePath, fileSize);
          } else {
            recordFailed(sqliteDb!, adapter.name, chunk.sourcePath, fileSize);
          }
          this.opts.logger(
            `[scheduler] storage error for ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    if (
      process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1" &&
      this.opts.exemplarStore &&
      this.opts.installScope
    ) {
      try {
        await this.opts.exemplarStore.applyBucketCap(this.opts.installScope, exemplarMaxPerBucket());
      } catch (e) {
        this.opts.logger(
          `[scheduler] exemplar bucket cap failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return { inserted, skippedLowConfidence, classifyFailures, storageFailures, chunksSeen };
  }

  private async drainSignals(chunk: { id: string; signals?: ReadonlyArray<unknown> }): Promise<void> {
    if (process.env["NLM_SIGNALS_ENABLED"] === "0") return;
    if (!this.opts.signalStore || !chunk.signals?.length) return;
    try {
      const normalized: Signal[] = [];
      for (const raw of chunk.signals) {
        try {
          normalized.push(normalizeSignal(raw, this.opts.installScope));
        } catch {
          // skip a malformed embedded signal; one bad entry must not lose the rest
        }
      }
      if (normalized.length > 0) await this.opts.signalStore.insertMany(normalized);
    } catch (e) {
      this.opts.logger(
        `[scheduler] signal drain failed for ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

