/**
 * Harness orchestration: build goldens from a snapshot, run the metric suite
 * against it, compare two runs. Every database read happens on a throwaway
 * APFS-clone of the snapshot so neither the snapshot nor the live store is
 * ever opened for writing.
 */

import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { LLMClient } from "../../../ports/llm-client.js";
import type { RecallMode } from "../../../shared/types.js";
import { FactRecallService } from "../../recall-facts/fact-recall-service.js";
import { RecallService } from "../../recall/recall-service.js";
import { readCitationLog } from "../../recall/citation-log.js";
import { readHookRecallLog } from "../../recall/hook-recall-log.js";
import { readQueryLog } from "../../recall/query-log.js";
import { computePerSourcePrecision, computePrecision } from "../../recall/precision.js";
import { computeReDerivationRate, sqliteReDerivationDeps } from "../../metrics/re-derivation.js";
import { SqliteStorage } from "../../storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "../../tenancy/default-team.js";
import { runEval, type EvalQuery, type EvalReport } from "../run-eval.js";
import {
  deriveCitationGoldens,
  deriveFactTopicGoldens,
  readCitations,
  summarizeGoldens,
  type Golden,
  type Split,
} from "./goldens.js";
import { dbSizeByTable, factHealth, hookTokens } from "./metrics.js";

const MIGRATIONS_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../migrations");
const GOLDENS_FILE = "goldens.json";
const RE_DERIVATION_WINDOW_DAYS = 90;

export interface GoldenFile {
  readonly builtAt: string;
  readonly fact: { readonly sampleSize: number };
  readonly session: ReadonlyArray<Golden>;
  readonly factTopic: ReadonlyArray<Golden>;
  readonly factCitation: ReadonlyArray<Golden>;
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function sandbox(snapshotDir: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nlm-eval-"));
  const path = join(dir, "canonical.sqlite");
  copyFileSync(join(snapshotDir, "canonical.sqlite"), path, constants.COPYFILE_FICLONE);
  chmodSync(path, 0o600); // the snapshot is 0444; the throwaway clone must be writable for WAL
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Derive golden sets from a snapshot and write goldens.json beside it. */
export function buildGoldens(snapshotDir: string, opts: { factSample?: number; now?: Date } = {}): GoldenFile {
  const factSample = opts.factSample ?? 400;
  const citations = readCitations(
    readText(join(snapshotDir, "citation-log.jsonl")),
    readText(join(snapshotDir, "hook-log.jsonl")),
  );
  const session = deriveCitationGoldens(readText(join(snapshotDir, "query_log.jsonl")), citations, "");
  const factCitation = deriveCitationGoldens(readText(join(snapshotDir, "fact_query_log.jsonl")), citations, "fact_");

  const sb = sandbox(snapshotDir);
  let factTopic: Golden[];
  try {
    const db = new Database(sb.path, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, subject, predicate FROM facts
            WHERE kind = 'decision' AND confidence >= 0.6 AND superseded_by IS NULL AND retired_at IS NULL`,
        )
        .all() as Array<{ id: string; subject: string; predicate: string }>;
      // Uniqueness must be judged over every active fact, not just decisions.
      const all = db
        .prepare("SELECT id, subject, predicate FROM facts WHERE superseded_by IS NULL AND retired_at IS NULL")
        .all() as Array<{ id: string; subject: string; predicate: string }>;
      const taken = new Set(rows.map((r) => r.id));
      factTopic = deriveFactTopicGoldens(all, Number.MAX_SAFE_INTEGER)
        .filter((g) => taken.has(g.relevantIds[0]!))
        .slice(0, factSample);
    } finally {
      db.close();
    }
  } finally {
    sb.cleanup();
  }
  const file: GoldenFile = {
    builtAt: (opts.now ?? new Date()).toISOString(),
    fact: { sampleSize: factSample },
    session,
    factTopic,
    factCitation,
  };
  writeFileSync(join(snapshotDir, GOLDENS_FILE), JSON.stringify(file));
  return file;
}

export function loadGoldens(snapshotDir: string): GoldenFile {
  const p = join(snapshotDir, GOLDENS_FILE);
  if (!existsSync(p)) throw new Error(`no ${GOLDENS_FILE} in ${snapshotDir}; run the goldens step first`);
  return JSON.parse(readFileSync(p, "utf8")) as GoldenFile;
}

export interface LaneMetrics {
  readonly n: number;
  readonly rAt1: number;
  readonly rAt5: number;
  readonly mrr: number;
}

type SplitModeMetrics = Record<Split, Record<string, LaneMetrics>>;

const laneOf = (r: EvalReport): LaneMetrics => ({ n: r.n, rAt1: r.rAt1, rAt5: r.rAt5, mrr: r.mrr });
const toQueries = (g: ReadonlyArray<Golden>): EvalQuery[] => g.map((x) => ({ query: x.query, expectedIds: x.relevantIds }));

async function lane(
  search: (q: { query: string; mode: RecallMode; limit: number }) => Promise<{ results: ReadonlyArray<{ id: string }> }>,
  goldens: ReadonlyArray<Golden>,
  modes: ReadonlyArray<RecallMode>,
): Promise<SplitModeMetrics> {
  const out: SplitModeMetrics = { dev: {}, heldout: {} };
  for (const split of ["dev", "heldout"] as const) {
    const qs = toQueries(goldens.filter((g) => g.split === split));
    for (const mode of modes) {
      out[split][mode] = laneOf(await runEval({ recall: { search } }, qs, { mode, k: 10 }));
    }
  }
  return out;
}

export interface HarnessReport {
  readonly schema: 1;
  readonly snapshot: string;
  readonly ranAt: string;
  readonly runtimeSeconds: number;
  readonly modes: ReadonlyArray<RecallMode>;
  readonly goldens: {
    readonly session: ReturnType<typeof summarizeGoldens>;
    readonly factTopic: ReturnType<typeof summarizeGoldens>;
    readonly factCitation: ReturnType<typeof summarizeGoldens>;
  };
  readonly retrieval: { readonly session: SplitModeMetrics; readonly fact: SplitModeMetrics };
  readonly store: ReturnType<typeof factHealth> & { readonly dbBytesByTable: Record<string, number> };
  readonly hookTokens: ReturnType<typeof hookTokens>;
  readonly classifyLatency: null;
  readonly reDerivation: { readonly windowDays: number; readonly rate: number; readonly pairs: number };
  readonly citation: {
    readonly blendedHookPrecision: number | null;
    readonly perSource: ReadonlyArray<{ source: string; precision: number; conversationCount: number }>;
    readonly unmeasurableSources: ReadonlyArray<string>;
  };
}

export interface RunOptions {
  readonly modes: ReadonlyArray<RecallMode>;
  readonly embedder: LLMClient;
}

export async function runHarness(snapshotDir: string, opts: RunOptions): Promise<HarnessReport> {
  const t0 = Date.now();
  const goldens = loadGoldens(snapshotDir);
  if (opts.modes.some((m) => m !== "keyword")) {
    // Without this, a dead embedder would silently degrade semantic and hybrid to keyword.
    await opts.embedder.embed("harness embedder probe", "query");
  }
  const sb = sandbox(snapshotDir);
  const storage = SqliteStorage.create({ dbPath: sb.path, migrationsDir: MIGRATIONS_DIR });
  try {
    const recall = new RecallService({ store: storage.sessions, llm: opts.embedder, factStore: storage.facts });
    const factRecall = new FactRecallService({ factStore: storage.facts, llm: opts.embedder });
    const session = await lane((q) => recall.search(DEFAULT_TEAM_ID, q), goldens.session, opts.modes);
    const fact = await lane((q) => factRecall.search(DEFAULT_TEAM_ID, q), goldens.factTopic, opts.modes);

    const db = storage.rawDb();
    const store = { ...factHealth(db), dbBytesByTable: dbSizeByTable(db) };
    const rd = await computeReDerivationRate(sqliteReDerivationDeps(db, DEFAULT_TEAM_ID), RE_DERIVATION_WINDOW_DAYS);

    const allDays = 36_500;
    const [queries, citations, hooks] = await Promise.all([
      readQueryLog(DEFAULT_TEAM_ID, allDays, join(snapshotDir, "query_log.jsonl")),
      readCitationLog(DEFAULT_TEAM_ID, allDays, join(snapshotDir, "citation-log.jsonl")),
      readHookRecallLog(DEFAULT_TEAM_ID, allDays, join(snapshotDir, "hook-log.jsonl")),
    ]);
    const { perSource, unmeasurable } = computePerSourcePrecision(queries, citations);

    return {
      schema: 1,
      snapshot: snapshotDir,
      ranAt: new Date().toISOString(),
      runtimeSeconds: Math.round((Date.now() - t0) / 100) / 10,
      modes: opts.modes,
      goldens: {
        session: summarizeGoldens(goldens.session),
        factTopic: summarizeGoldens(goldens.factTopic),
        factCitation: summarizeGoldens(goldens.factCitation),
      },
      retrieval: { session, fact },
      store,
      hookTokens: hookTokens(readText(join(snapshotDir, "hook-log.jsonl"))),
      classifyLatency: null,
      reDerivation: { windowDays: RE_DERIVATION_WINDOW_DAYS, rate: rd.rate, pairs: rd.pairs.length },
      citation: {
        blendedHookPrecision: computePrecision(hooks, citations).precisionAtK,
        perSource,
        unmeasurableSources: unmeasurable,
      },
    };
  } finally {
    await storage.close();
    sb.cleanup();
  }
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** Human-readable summary of one run (the JSON report is the machine form). */
export function formatReport(r: HarnessReport): string {
  const out: string[] = [`snapshot ${r.snapshot}  run ${r.runtimeSeconds}s`];
  for (const lane of ["session", "fact"] as const) {
    for (const split of ["dev", "heldout"] as const) {
      for (const [mode, m] of Object.entries(r.retrieval[lane][split])) {
        out.push(
          `${lane.padEnd(8)}${split.padEnd(9)}${mode.padEnd(10)}n=${String(m.n).padEnd(5)}R@1 ${pct(m.rAt1).padStart(6)}  R@5 ${pct(m.rAt5).padStart(6)}  MRR ${m.mrr.toFixed(3)}`,
        );
      }
    }
  }
  out.push(
    `active facts ${r.store.activeFacts}; conflicting groups ${r.store.conflictingActiveFacts} (+${r.store.multiValuedGroups} exempt multi-valued)`,
    `facts missing embedding ${r.store.activeFactsMissingEmbedding} (${pct(r.store.missingEmbeddingShare)})`,
    `hook tokens/call: n=${r.hookTokens.calls} mean ${r.hookTokens.meanPerCall?.toFixed(1)} p50 ${r.hookTokens.p50} p95 ${r.hookTokens.p95}; injecting calls n=${r.hookTokens.injectingCalls} p50 ${r.hookTokens.p50Injecting} p95 ${r.hookTokens.p95Injecting}`,
    `re-derivation rate (${r.reDerivation.windowDays}d) ${r.reDerivation.rate} (${r.reDerivation.pairs} pairs)`,
    `classify latency: not recorded in snapshot logs`,
    "citation rate per surfaced session, by source:",
    ...r.citation.perSource.map((p) => `  ${p.source.padEnd(20)}${pct(p.precision).padStart(7)}  (${p.conversationCount} conversations)`),
    `  unmeasurable (no conversation id): ${r.citation.unmeasurableSources.join(", ") || "none"}`,
    "db size by table (MB): " +
      Object.entries(r.store.dbBytesByTable)
        .slice(0, 8)
        .map(([t, b]) => `${t} ${(b / 1048576).toFixed(0)}`)
        .join(", "),
  );
  return out.join("\n");
}
