#!/usr/bin/env node
/**
 * nlm — CLI entry point. Composition root for the whole stack.
 *
 * This is the one file that knows about every concrete implementation:
 * SqliteSessionStore (storage), OllamaClient (LLM), Hono (HTTP),
 * McpServer (MCP). Every other module depends on ports. Swapping a
 * backend means editing this file, not anything inside core/.
 *
 * Subcommands:
 *   nlm start    — boot HTTP server on $NLM_PORT (default 3940)
 *   nlm migrate  — run pending migrations against the canonical SQLite
 *   nlm recall   — one-shot recall query from the shell (debugging)
 *   nlm mcp      — run as an MCP stdio server (for ~/.mcp.json wiring)
 *   nlm setup    — interactive first-run wizard (recommended entry point)
 *   nlm install  — install the macOS LaunchAgent (auto-start on login)
 *   nlm uninstall — remove the macOS LaunchAgent
 *   nlm hook install   — add the recall hook to Claude Code (shadow mode)
 *   nlm hook uninstall — remove the recall hook from Claude Code
 *   nlm connect claude-code  — write MCP server block to ~/.mcp.json
 *   nlm connect codex        — install Codex marketplace plugin
 *   nlm disconnect claude-code — remove MCP block from ~/.mcp.json
 *   nlm disconnect codex       — remove Codex plugin
 *   nlm digest   — print a daily-activity digest (or --telegram to post)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FactRecallService } from "../core/recall-facts/fact-recall-service.js";
import { RecallService } from "../core/recall/recall-service.js";
import { ProviderRegistry } from "../core/providers/provider-registry.js";
import type { SourceRegistryPort } from "../core/sources/source-registry.js";
import { SqliteStorage } from "../core/storage/sqlite-storage.js";
import { PgStorage } from "../core/storage/pg-storage.js";
import { applyPendingRestore, stageRestore } from "../core/storage/db-restore.js";
import { listBackupDates, resolveBackup, runRollingBackup } from "../core/storage/backup-rotation.js";
import { createApp } from "../http/app.js";
import { createMcpServer, listMergeSuggestionsHandler, mergeWorkstreamsHandler, rebindSessionHandler, recallWorkstreamHandler, renameWorkstreamHandler, retireWorkstreamHandler } from "../mcp/server.js";
import { classifierEgressNotice } from "../llm/classifier-egress.js";
import { buildClassifier } from "../llm/build-classifier.js";
import { OllamaCodeEmbedder } from "../llm/ollama-code-embedder.js";
import { OpenAICodeEmbedderClient } from "../llm/openai-code-embedder-client.js";
import { resolveEmbedderInfo } from "../llm/embedder-info.js";
import type { CodeEmbedder } from "../ports/code-embedder.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { buildEmbedder as _buildEmbedder } from "../llm/build-embedder.js";
import { addHook, buildHookCommand, removeHook } from "../core/hook/claude-settings.js";
import {
  codexBinaryAvailable,
  connectCodex,
  disconnectCodex,
  repairCodex,
  pluginScriptsDir,
} from "../install/codex.js";
import { connectClaudeCode, disconnectClaudeCode, installClaudeCodeHooks, mcpConfigPath } from "../install/claude-code.js";
import { evaluateInstallHealth, evaluateModelHealth, evaluateRecallSmoke } from "../install/health.js";
import type { HealthCheck, InstallProbe } from "../install/health.js";
import { codexConfigPath } from "../install/codex.js";
import { hardenNlmDirPermissions } from "../install/nlm-dir-perms.js";
import { embeddingModelPresent, ensureMcpToken, ollamaModelPresent } from "../install/ollama.js";
import { connectCursor, disconnectCursor } from "../install/cursor.js";
import {
  describeRemove,
  describeUpsert,
  installCursorRules,
  installOpencodeRules,
  installWindsurfRules,
  uninstallCursorRules,
  uninstallOpencodeRules,
  uninstallWindsurfRules,
} from "../install/rules-install.js";
import { runSupersedeCommand } from "./supersede.js";
import { getUpdateStatus } from "../core/update-check/check.js";
import { connectHermes, disconnectHermes, hermesConfigPath } from "../install/hermes.js";
import { connectHermesAgent, disconnectHermesAgent, hermesAgentPluginDir } from "../install/hermes-agent.js";
import { connectWindsurf, disconnectWindsurf } from "../install/windsurf.js";
import { connectPi, disconnectPi, piSettingsPath } from "../install/pi.js";
import { runSetup } from "../install/setup.js";
import { runParity } from "./classify-parity.js";
import { reembedCorpus } from "../core/embedding/embed-backfill.js";
import { backfillExemplarEmbeddings } from "../core/exemplars/embed-backfill.js";
import { warmCodeEmbedder } from "../core/exemplars/warm-embedder.js";
import { markWarm } from "../core/health/warmup-state.js";
import { backfillFacts } from "../core/facts/backfill-facts.js";
import { normalizeEmbeddings } from "../core/embedding/embed-normalize.js";
import { ScanScheduler } from "../core/scheduler/scheduler.js";
import { MemoSweepScheduler } from "../core/hook/memo-sweep.js";
import { isAgentLoaded, isBenignBootoutError } from "./launchctl-helpers.js";
import { DAEMON_PKILL_PATTERN, planRestart, executeRestartPlan, type ExecuteRestartPlanDeps } from "./restart-helpers.js";
import { isDevBuild, updateCheckCachePath } from "./upgrade-helpers.js";
import { applyEnvAssignment } from "./config-env.js";
import { adapterFromSource } from "../core/adapters/from-source.js";
import type { TranscriptAdapter } from "../ports/transcript-adapter.js";
import type { LLMClient } from "../ports/llm-client.js";
import { runDigest } from "./digest.js";
import { installScope } from "../core/signals/install-scope.js";
import { buildWorkDigest } from "../core/work-digest/build-work-digest.js";
import { composeWorkDigest } from "../core/work-digest/compose-work-digest.js";
import { defaultTopicProvider, aliasTopicProvider, type TopicProvider } from "../core/work-digest/topics.js";
import { runChecksOnSqlite, runChecksOnPg, applyFixOnSqlite, applyFixOnPg } from "../core/integrity/check-invariants.js";
import { normalizeLabel } from "../core/workstream/model.js";
import { resolveWorkstreamId } from "../core/workstream/resolve.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const PG_MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
const UI_DIST = resolve(__dirname, "../../dist/ui");
const DEFAULT_DB_PATH = resolve(homedir(), ".nlm/canonical.sqlite");
const DEFAULT_PORT = 3940;

function dbPath(): string {
  return process.env["NLM_DB_PATH"] ?? DEFAULT_DB_PATH;
}

function port(): number {
  const raw = process.env["NLM_PORT"];
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65_535) return DEFAULT_PORT;
  return n;
}

function ollamaUrl(): string {
  return process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434";
}

export function resolveDigestDate(date: string | undefined): string {
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`invalid --date "${date}"; expected YYYY-MM-DD`);
    }
    return date;
  }
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

function workDigestEnv(): { idleThresholdMin: number; deepBlockMin: number } {
  const idle = Number.parseInt(process.env["NLM_WORK_IDLE_THRESHOLD_MIN"] ?? "5", 10);
  const deep = Number.parseInt(process.env["NLM_WORK_DEEP_BLOCK_MIN"] ?? "25", 10);
  return {
    idleThresholdMin: Number.isFinite(idle) && idle > 0 ? idle : 5,
    deepBlockMin: Number.isFinite(deep) && deep > 0 ? deep : 25,
  };
}

function loadTopicProvider(): TopicProvider {
  try {
    const raw = readFileSync(join(homedir(), ".nlm", "work-topics.json"), "utf8");
    const map = JSON.parse(raw) as Record<string, string>;
    return aliasTopicProvider(map);
  } catch {
    return defaultTopicProvider;
  }
}

/** Build the recall/document embedder. Delegates to the shared factory in
 *  src/llm/build-embedder.ts — see that file for provider routing details. */
function buildEmbedder(): LLMClient {
  return _buildEmbedder();
}

/** Build the code-lane embedder. Follows the same destination as the prose
 *  embedder (NLM_EMBED_PROVIDER / NLM_EMBED_BASE_URL) but with its own model
 *  (NLM_CODE_EMBED_MODEL, e.g. text-embedding-coderankembed on LM Studio).
 *  Switching providers on existing exemplars requires `nlm embed-backfill
 *  --exemplars`. */
function buildCodeEmbedder(): CodeEmbedder {
  const provider = (process.env["NLM_EMBED_PROVIDER"] ?? "ollama").toLowerCase();
  if (provider === "openai") {
    autoloadEnv();
    const baseUrl = process.env["NLM_EMBED_BASE_URL"];
    if (!baseUrl) {
      throw new Error(
        "NLM_EMBED_PROVIDER=openai requires NLM_EMBED_BASE_URL for the code embedder too, " +
          "e.g. http://localhost:1234/v1 for LM Studio.",
      );
    }
    return new OpenAICodeEmbedderClient({
      baseUrl,
      ...(process.env["NLM_CODE_EMBED_MODEL"] ? { model: process.env["NLM_CODE_EMBED_MODEL"] } : {}),
      ...(process.env["NLM_EMBED_API_KEY"] ? { apiKey: process.env["NLM_EMBED_API_KEY"] } : {}),
    });
  }
  return new OllamaCodeEmbedder({ baseUrl: ollamaUrl() });
}

async function buildAdapters(sources: SourceRegistryPort): Promise<TranscriptAdapter[]> {
  // Sources table is the source of truth. Each enabled row maps to one
  // adapter via adapterFromSource(). Detection still gates registration —
  // a row pointing at a missing dir won't poll. NLM_ADAPTERS keeps working
  // as a name-based filter for forcing a subset during dev.
  const explicit = process.env["NLM_ADAPTERS"];
  const allowed = explicit ? new Set(explicit.split(",").map((s) => s.trim())) : null;
  const rows = await sources.list();
  const out: TranscriptAdapter[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const adapter = adapterFromSource(row);
    if (!adapter) continue;
    if (allowed && !allowed.has(adapter.name)) continue;
    if (!adapter.detect().enabled) continue;
    out.push(adapter);
  }
  return out;
}

async function buildStorage(path: string): Promise<SqliteStorage | PgStorage> {
  const pgUrl = process.env["NLM_PG_URL"];
  if (pgUrl) {
    const storage = PgStorage.create({ connectionString: pgUrl, migrationsDir: PG_MIGRATIONS_DIR });
    await storage.init();
    return storage;
  }
  return SqliteStorage.create({ dbPath: path, migrationsDir: MIGRATIONS_DIR });
}

async function buildStack() {
  // Load .env before any registry seeds so secrets carried in env vars
  // (DEEPSEEK_API_KEY today; OPENAI_API_KEY etc. tomorrow) bridge into
  // the providers table on first boot under launchd.
  autoloadEnv();
  // A restore staged via POST /api/data/restore is promoted here, before
  // the store opens — the daemon can't swap a DB file it already holds.
  const restored = applyPendingRestore(dbPath());
  if (restored.applied) {
    console.error(`nlm-memory: restored database from staged backup`);
    if (restored.archivedTo) console.error(`  previous db archived at ${restored.archivedTo}`);
  }
  const storage = await buildStorage(dbPath());
  const store = storage.sessions;
  // FactStore shares the SessionStore's connection so session+facts ingest
  // can commit in one transaction. Phase B.1 wires it in; no callers yet.
  const facts = storage.facts;
  const signals = storage.signals;
  const scope = installScope();
  const sources = storage.sources;
  await sources.seedDefaults();
  const providers = storage.providers;
  // Provider seeding is SQLite-only: it bridges from the local DEEPSEEK_API_KEY
  // env, which is wrong for a hosted multi-tenant PG. PgProviderRegistry has no
  // seedDefaults (not on ProviderRegistryPort), so this narrows to the SQLite case.
  if (providers instanceof ProviderRegistry) await providers.seedDefaults();
  // Recall only uses embed(). Default embedder is local Ollama; NLM_EMBED_*
  // can point it at any OpenAI-compatible endpoint. Classifier is wired
  // separately for Phase D ingest.
  const embedder = buildEmbedder();
  const classifier = buildClassifier();
  const wsStore = storage.workstreams;
  const recall = new RecallService({
    store,
    llm: embedder,
    factStore: facts,
    exemplarStore: storage.exemplars,
    codeEmbedder: buildCodeEmbedder(),
    installScope: scope,
    resolveWorkstreamMembers: async (idOrLabel: string): Promise<ReadonlyArray<string>> => {
      const all = await wsStore.listAll();
      const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
      const target = all.find((w) => w.id === idOrLabel)
        ?? all.find((w) => normalizeLabel(w.label) === normalizeLabel(idOrLabel));
      if (!target) return [];
      const survivor = resolveWorkstreamId(target.id, byId);
      return all.filter((w) => resolveWorkstreamId(w.id, byId) === survivor).map((w) => w.id);
    },
  });
  const factRecall = new FactRecallService({ factStore: facts, llm: embedder });
  return { storage, store, facts, signals, scope, sources, providers, recall, factRecall, embedder, classifier };
}

const program = new Command();
program
  .name("nlm")
  .description("Local-first memory operating system for AI operators")
  .version(pkg.version);

program
  .command("start")
  .description("Boot the HTTP server + ingest scheduler")
  .option("--no-scheduler", "HTTP only; skip the ingest tick loop")
  .option("--interval-min <n>", "scheduler tick interval (min, default 30)", (v) => Number.parseInt(v, 10), 30)
  .action(async (opts) => {
    // Self-heal perms on every daemon start. Idempotent. Covers upgrade
    // path from pre-v0.4.2 installs where ~/.nlm contents were world-readable.
    hardenNlmDirPermissions();
    // Generate NLM_MCP_TOKEN if missing so /api/* gets Bearer-protected for
    // non-browser callers. Idempotent: re-reads persisted token first.
    autoloadEnv();
    ensureMcpToken();
    const { storage, store, facts, signals, scope, sources, providers, recall, factRecall, embedder, classifier } = await buildStack();
    const { existsSync } = await import("node:fs");
    const hasMcpToken = Boolean(process.env["NLM_MCP_TOKEN"]);
    const app = createApp({
      recall,
      store,
      liveStore: store,
      factRecall,
      factStore: facts,
      dbPath: dbPath(),
      classifier,
      sources,
      providers,
      ingest: {
        classifier,
        embedder,
        store,
        ...(facts ? { factStore: facts } : {}),
      },
      signalStore: signals,
      installScope: scope,
      // Code-exemplar lane. The store + code embedder are always wired; the
      // NLM_CODE_EXEMPLARS_ENABLED flag gates capture (POST /api/signal) and
      // the /api/exemplar + /api/recall-code routes at request time.
      exemplarStore: storage.exemplars,
      codeEmbedder: buildCodeEmbedder(),
      embedderInfo: resolveEmbedderInfo(),
      ...(existsSync(UI_DIST) ? { uiDist: UI_DIST } : {}),
      // Wire POST /mcp only when NLM_MCP_TOKEN is present. Absent = route never
      // mounts, zero attack surface. Present = token-gated Streamable-HTTP MCP
      // endpoint for container agents (e.g. Hermes WebUI).
      ...(hasMcpToken
        ? {
            mcpDeps: {
              recall,
              store,
              factRecall,
              factStore: facts,
              // Parity with the stdio `nlm mcp` server: remote/container MCP
              // clients hitting POST /mcp get recall_code too when the flag is on.
              exemplarStore: storage.exemplars,
              codeEmbedder: buildCodeEmbedder(),
              installScope: scope,
              workDigest: { store, topicProvider: loadTopicProvider(), workstreams: storage.workstreams, ...workDigestEnv() },
              workstreams: { store: storage.workstreams, sessions: store, facts: facts, exemplars: storage.exemplars },
            },
          }
        : {}),
    });
    warmCodeEmbedder(buildCodeEmbedder());

    void embedder
      .embed("warmup init", "query")
      .then(() => markWarm("textEmbedder"))
      .catch(() => {});

    setImmediate(() => {
      void recall
        .search({ query: "warmup init", mode: "keyword", limit: 1 })
        .then(() => markWarm("fts5"))
        .catch(() => {});
    });

    const p = port();
    serve({ fetch: app.fetch, port: p, hostname: "127.0.0.1" }, (info) => {
      console.error(`nlm-memory http listening on http://localhost:${info.port}`);
      if (hasMcpToken) {
        console.error(`  mcp:    http://localhost:${info.port}/mcp (token-gated)`);
      }
      console.error(`  db:     ${dbPath()}`);
      console.error(`  ollama: ${ollamaUrl()}`);
      const classifier = (process.env["NLM_CLASSIFIER"] ?? "ollama").toLowerCase();
      const egress = classifierEgressNotice(classifier, process.env["NLM_CLASSIFIER_BASE_URL"]);
      const classifyTarget =
        classifier === "openai" && process.env["NLM_CLASSIFIER_BASE_URL"]
          ? `${classifier} (${process.env["NLM_CLASSIFIER_BASE_URL"]})`
          : classifier;
      console.error(`  classify: ${classifyTarget} [${egress ? "cloud egress" : "local"}]`);
      if (egress) console.error(`  notice: ${egress}`);
      // Passive update notice. Fire-and-forget so a slow npm registry
      // round-trip can't delay the startup banner; surfaced only when
      // strictly behind. See src/core/update-check/check.ts for the
      // local-first / no-telemetry contract this honors.
      void getUpdateStatus({ currentVersion: pkg.version }).then((status) => {
        if (status.behind && status.latest) {
          console.error(
            `  update: ${status.current} → ${status.latest} available (npm i -g nlm-memory@latest)`,
          );
        }
      });
    });

    // Keep the SQLite WAL bounded. WAL mode is on but nothing else
    // checkpoints it; under continuous readers it grows without limit
    // (it had reached 38 MB), which slows every read. Drain once at boot,
    // then every 5 minutes. Skip entirely when using PgStorage (no WAL).
    const checkpointTimer = !(storage instanceof PgStorage)
      ? (() => {
          const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000;
          const sqliteStore = store as import("../core/storage/sqlite-session-store.js").SqliteSessionStore;
          try {
            sqliteStore.checkpoint();
          } catch {
            // Boot checkpoint can lose a race with readers — the interval retries.
          }
          const t = setInterval(() => {
            try {
              sqliteStore.checkpoint();
            } catch {
              // Checkpoint contention — the next tick retries.
            }
          }, WAL_CHECKPOINT_INTERVAL_MS);
          t.unref();
          return t;
        })()
      : null;

    // Signal retention prune. Best-effort, every 6h, default 90d. Runs on
    // both SQLite and Pg backends since both expose pruneOlderThan().
    const parsedRetentionDays = Number.parseInt(process.env["NLM_SIGNAL_RETENTION_DAYS"] ?? "90", 10);
    const SIGNAL_RETENTION_DAYS = Number.isFinite(parsedRetentionDays) && parsedRetentionDays > 0 ? parsedRetentionDays : 90;
    const SIGNAL_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
    const signalPruneTimer = setInterval(() => {
      const cutoff = new Date(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000).toISOString();
      void signals.pruneOlderThan(cutoff).catch(() => { /* prune is best-effort */ });
    }, SIGNAL_PRUNE_INTERVAL_MS);
    signalPruneTimer.unref();

    // Memo sweep runs independently of the transcript scheduler — it's the
    // backstop for SessionEnd hook unreliability (crashes, kill -9, IDE
    // force-close don't fire SessionEnd, so memo files would otherwise
    // accumulate forever). Always on, even when --no-scheduler.
    const memoSweep = new MemoSweepScheduler();
    memoSweep.start();
    console.error("  memo sweep: dormant cleanup every 5m (threshold 24h)");

    if (opts.scheduler !== false) {
      const adapters = await buildAdapters(sources);
      if (adapters.length === 0) {
        console.error("  scheduler: no adapters detected (set NLM_ADAPTERS to force-enable)");
      } else {
        const scheduler = new ScanScheduler({
          store,
          adapters,
          classifier,
          embedder,
          factStore: facts ?? null,
          signalStore: signals,
          installScope: scope,
          intervalMs: opts.intervalMin * 60_000,
          exemplarStore: storage.exemplars,
          codeEmbedder: buildCodeEmbedder(),
          workstreams: storage.workstreams,
        });
        scheduler.start();
        console.error(
          `  scheduler: ${adapters.map((a) => a.name).join(", ")} every ${opts.intervalMin}m`,
        );
        const shutdown = async () => {
          if (checkpointTimer) clearInterval(checkpointTimer);
          scheduler.stop();
          memoSweep.stop();
          await storage.close();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      }
    }
  });

program
  .command("migrate")
  .description("Run pending migrations against the canonical SQLite")
  .action(async () => {
    // SqliteSessionStore's constructor loads sqlite-vec and runs migrations.
    // Opening + closing is the whole operation.
    const storage = SqliteStorage.create({
      dbPath: dbPath(),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.close();
    console.error(`nlm-memory: migrations applied at ${dbPath()}`);
  });

program
  .command("recall")
  .description("One-shot recall query (for shell debugging)")
  .argument("<query>", "search query")
  .option("-e, --entity <name>", "filter by entity")
  .option("-k, --kind <kind>", "filter by marker kind (decision|open)")
  .option("-m, --mode <mode>", "recall mode: keyword, semantic, or hybrid (default: keyword)", "keyword")
  .option("-l, --limit <n>", "max results", (v) => Number.parseInt(v, 10), 10)
  .option("-w, --workstream <idOrLabel>", "filter by workstream (id or label; merge chains resolve)")
  .option("--json", "emit the raw JSON result instead of rendered lines")
  .action(async (query, opts) => {
    const { storage, recall } = await buildStack();
    try {
      const result = await recall.search({
        query,
        mode: opts.mode,
        limit: opts.limit,
        // Investigative surface: surface superseded sessions down-ranked and
        // badged with their successor. The hooks keep strict exclusion.
        includeSuperseded: true,
        ...(opts.entity ? { entity: opts.entity } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.workstream ? { workstream: opts.workstream } : {}),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        for (const r of result.results) {
          const badge =
            r.status === "superseded" ? ` [SUPERSEDED -> ${r.supersededBy ?? "?"}]` : "";
          process.stdout.write(
            `${r.matchScore.toFixed(4)}  ${r.id}  ${r.label}${badge}\n`,
          );
        }
        if (result.results.length === 0) process.stdout.write("(no matches)\n");
      }
    } finally {
      await storage.close();
    }
  });

program
  .command("recall-workstream")
  .description("Recall a workstream's accumulated context (id or label)")
  .argument("<idOrLabel>", "workstream id or label")
  .action(async (idOrLabel) => {
    const { storage, store } = await buildStack();
    try {
      const r = await recallWorkstreamHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { idOrLabel },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("rebind-session")
  .description("Rebind a session to a workstream (operator correction)")
  .argument("<sessionId>", "session id")
  .argument("<workstream>", "target workstream id or label")
  .action(async (sessionId, workstream) => {
    const { storage, store } = await buildStack();
    try {
      const r = await rebindSessionHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { sessionId, workstream },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("merge-workstreams")
  .description("Merge a duplicate workstream into the one to keep")
  .argument("<from>", "duplicate workstream id or label")
  .argument("<into>", "survivor workstream id or label")
  .action(async (from, into) => {
    const { storage, store } = await buildStack();
    try {
      const r = await mergeWorkstreamsHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { from, into },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("rename-workstream")
  .description("Rename a workstream")
  .argument("<idOrLabel>", "workstream id or current label")
  .argument("<label>", "new label")
  .action(async (idOrLabel, label) => {
    const { storage, store } = await buildStack();
    try {
      const r = await renameWorkstreamHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { idOrLabel, label },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("retire-workstream")
  .description("Retire (mark dead) a workstream")
  .argument("<idOrLabel>", "workstream id or label")
  .action(async (idOrLabel) => {
    const { storage, store } = await buildStack();
    try {
      const r = await retireWorkstreamHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { idOrLabel },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("merge-suggestions")
  .description("List likely-duplicate workstreams to merge")
  .option("-m, --min-score <n>", "minimum similarity score 0..1", "0.5")
  .action(async (opts) => {
    const minScore = Number(opts.minScore);
    if (!Number.isFinite(minScore)) {
      process.stderr.write(`nlm: invalid --min-score "${opts.minScore}" (expected a number 0..1)\n`);
      process.exitCode = 1;
      return;
    }
    const { storage, store } = await buildStack();
    try {
      const r = await listMergeSuggestionsHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { minScore },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("eval")
  .description("Run R@k/MRR over an operator-supplied query set (queries never bundled)")
  .requiredOption("--queries <file>", "JSON file: [{ query, expectedIds }]")
  .option("--mode <mode>", "keyword | semantic | hybrid", "keyword")
  .option("--json", "emit JSON instead of a table")
  .action(async (opts) => {
    const { readFile } = await import("node:fs/promises");
    const queries = JSON.parse(await readFile(opts.queries, "utf8"));
    const { runEval } = await import("../core/eval/run-eval.js");
    const { storage, recall } = await buildStack();
    try {
      const report = await runEval({ recall }, queries, { mode: opts.mode, k: 5 });
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        `mode=${report.mode} n=${report.n} R@1=${(report.rAt1 * 100).toFixed(1)}% ` +
          `R@5=${(report.rAt5 * 100).toFixed(1)}% MRR=${report.mrr.toFixed(3)}\n`,
      );
    } finally {
      await storage.close();
    }
  });

program
  .command("recall-code")
  .description("Semantic search over code exemplars (requires NLM_CODE_EXEMPLARS_ENABLED=1)")
  .argument("<query>", "natural-language description of the task you are about to implement")
  .option("-r, --repo <path>", "filter by repository path")
  .option("-l, --lang <lang>", "filter by language (ts, py, go, ...)")
  .option("-k <n>", "max results", (v) => Number.parseInt(v, 10), 5)
  .option("--no-negatives", "exclude fail/exhausted exemplars from results")
  .option("--json", "emit the raw JSON result")
  .action(async (query, opts) => {
    if (process.env["NLM_CODE_EXEMPLARS_ENABLED"] !== "1") {
      process.stderr.write("recall-code requires NLM_CODE_EXEMPLARS_ENABLED=1\n");
      process.exit(1);
    }
    const { storage } = await buildStack();
    const { recallCode } = await import("../core/exemplars/recall-code.js");
    const { installScope: getScope } = await import("../core/signals/install-scope.js");
    try {
      const embedder = buildCodeEmbedder();
      const result = await recallCode(
        {
          query,
          installScope: getScope(),
          ...(opts.repo ? { repo: opts.repo } : {}),
          ...(opts.lang ? { lang: opts.lang } : {}),
          k: opts.k ?? 5,
          includeNegatives: opts.negatives !== false,
        },
        storage.exemplars,
        embedder,
        null,
      );
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const printHits = (label: string, hits: typeof result.positives) => {
          if (hits.length === 0) return;
          process.stdout.write(`\n── ${label} ──\n`);
          for (const h of hits) {
            process.stdout.write(`[${h.outcome}] ${h.taskContext} (${h.repo}, dist=${h.distance.toFixed(4)})\n`);
            process.stdout.write(h.code.slice(0, 400) + (h.code.length > 400 ? "\n…" : "") + "\n\n");
          }
        };
        printHits("Positives (pass / fix)", result.positives);
        printHits("Negatives (fail / exhausted) — avoid these patterns", result.negatives);
        if (result.positives.length === 0 && result.negatives.length === 0) {
          process.stdout.write("(no exemplars found)\n");
        }
      }
    } finally {
      await storage.close();
    }
  });

program
  .command("code-signal")
  .description("Emit a PATH-(b) code signal for a commit (deterministic pass/fail exemplar). Best-effort: never blocks a commit.")
  .requiredOption("--repo-path <dir>", "path to the git repo whose commit to capture")
  .requiredOption("--sha <sha>", "commit sha to extract the diff from")
  .requiredOption("--test-exit <n>", "test gate exit code (0 -> pass, non-zero -> fail)", (v) => Number.parseInt(v, 10))
  .option("--task <s>", "task description (defaults to the changed funcname/file)")
  .option("--model <s>", "model that produced the change")
  .option("--repo <logical>", "logical repo name (defaults to the repo-path basename)")
  .option("--dry-run", "print the payload and do not POST")
  .action(async (opts) => {
    const { buildCodeSignalPayload, formatCodeSignalResult } = await import("../core/signals/code-signal.js");
    const payload = buildCodeSignalPayload({
      repoPath: opts.repoPath,
      sha: opts.sha,
      testExit: opts.testExit,
      ...(opts.task ? { task: opts.task } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
    });
    if (opts.dryRun) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return;
    }
    const url = `http://localhost:${port()}/api/signal`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status !== 202) {
        process.stderr.write(`code-signal: daemon returned ${res.status} (not 202); skipping\n`);
        return;
      }
      const accepted = (await res.json()) as { id?: string };
      process.stdout.write(formatCodeSignalResult(payload.outcome, accepted.id ?? "unknown") + "\n");
    } catch {
      process.stderr.write(`code-signal: daemon unreachable at ${url}; skipping\n`);
    }
  });

program
  .command("misses")
  .description("Show sessions the agent explicitly fetched but the hook never surfaced (recall miss log)")
  .option("-d, --days <n>", "lookback window", (v) => Number.parseInt(v, 10), 7)
  .option("--json", "emit JSON instead of a human-readable table")
  .action(async (opts) => {
    const { missStats } = await import("../core/recall/miss-log.js");
    const stats = await missStats(opts.days);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return;
    }
    if (!stats.logPresent) {
      console.error(`No miss log at ${process.env["NLM_MISS_LOG"] ?? "~/.nlm/miss-log.jsonl"}.`);
      console.error("Misses are recorded by the Stop hook when the agent explicitly fetches or cites a session NLM didn't surface.");
      return;
    }
    console.log(`Recall misses — last ${stats.days} day(s)`);
    console.log(`  Total miss events: ${stats.total}`);
    console.log(`  Distinct missed session IDs: ${stats.distinctIds}`);
    if (stats.topIds.length === 0) {
      console.log("  (no misses in this window)");
      return;
    }
    console.log("");
    console.log("  Top missed session IDs:");
    for (const row of stats.topIds) {
      console.log(`    ${row.id}  ×${row.count}  (in ${row.conversations} conv${row.conversations === 1 ? "" : "s"})`);
    }
  });

program
  .command("precision")
  .description(
    "Compute real-world recall precision: fraction of surfaced sessions that were later cited.",
  )
  .option("--days <n>", "lookback window in days", (v) => Number.parseInt(v, 10), 30)
  .option("--json", "emit JSON instead of human-readable output")
  .option("--verbose", "show per-conversation breakdown")
  .action(async (opts) => {
    const { computePrecision, computePerSourcePrecision } = await import(
      "../core/recall/precision.js"
    );
    const { readHookRecallLog } = await import("../core/recall/hook-recall-log.js");
    const { readQueryLog } = await import("../core/recall/query-log.js");
    const { readCitationLog } = await import("../core/recall/citation-log.js");

    const [recallEntries, queryEntries, citationEntries] = await Promise.all([
      readHookRecallLog(opts.days),
      readQueryLog(opts.days),
      readCitationLog(opts.days),
    ]);

    const result = computePrecision(recallEntries, citationEntries);
    const { perSource, unmeasurable } = computePerSourcePrecision(
      queryEntries,
      citationEntries,
    );

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ...result, perSource, unmeasurableSources: unmeasurable }, null, 2)}\n`,
      );
      return;
    }

    console.log(`Recall precision@k — last ${opts.days} day(s)`);
    if (result.precisionAtK === null) {
      console.log("  Blended: no hook-lane conversations to score (hook-log.jsonl empty for this window).");
      if (citationEntries.length === 0) {
        console.log("  No citations recorded — run: nlm help close-loop");
      }
    } else {
      const pct = (result.precisionAtK * 100).toFixed(1);
      console.log(`  Blended: ${pct}%  (${result.conversationCount} conversations scored)`);
    }

    if (perSource.length > 0) {
      console.log("\n  Per source:");
      for (const row of perSource) {
        const p = (row.precision * 100).toFixed(1).padStart(5);
        const convs = `${row.conversationCount} conv${row.conversationCount === 1 ? "" : "s"}`;
        console.log(`    ${row.source.padEnd(20)} ${p}%  (${convs})`);
      }
    }
    if (unmeasurable.length > 0) {
      console.log(`  Unmeasurable (no conversation id captured): ${unmeasurable.join(", ")}`);
    }

    if (opts.verbose && result.perConversation.length > 0) {
      console.log("\nPer-conversation breakdown (worst first):");
      for (const row of result.perConversation) {
        const p = (row.precision * 100).toFixed(0).padStart(3);
        console.log(`  ${p}%  surfaced=${row.surfaced}  cited=${row.cited}  ${row.conversationId}`);
      }
    }
  });

program
  .command("metrics")
  .description("Read-only retrieval-quality metrics")
  .argument("<name>", "metric name: re-derivation")
  .option("--window <days>", "lookback window in days", (v) => Number.parseInt(v, 10), 90)
  .option("--json", "emit JSON instead of human-readable output")
  .action(async (name, opts) => {
    if (name !== "re-derivation") {
      console.error(`unknown metric '${name}' (available: re-derivation)`);
      process.exitCode = 1;
      return;
    }
    const { computeReDerivationRate, sqliteReDerivationDeps } = await import(
      "../core/metrics/re-derivation.js"
    );
    const { storage, store } = await buildStack();
    try {
      if (typeof (store as { rawDb?: unknown }).rawDb !== "function") {
        console.error("re-derivation metric requires the SQLite backend");
        process.exitCode = 1;
        return;
      }
      const deps = sqliteReDerivationDeps(
        (store as unknown as { rawDb(): unknown }).rawDb() as never,
      );
      const report = await computeReDerivationRate(deps, opts.window);
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return;
      }
      const pct = (report.rate * 100).toFixed(1);
      console.log(
        `re_derivation_rate (last ${opts.window} day(s)): ${pct}%  ` +
          `(${report.pairs.length} re-derived pair${report.pairs.length === 1 ? "" : "s"})`,
      );
      for (const p of report.pairs) {
        console.log(
          `  ${p.a} <-> ${p.b}  jaccard=${p.jaccard}  shared=${p.sharedEntities.join(", ")}`,
        );
      }
    } finally {
      await storage.close();
    }
  });

program
  .command("supersede")
  .description("Retroactively mark a session as superseded by a newer one")
  .argument("[predecessor]", "predecessor session id (omit for interactive search)")
  .argument("[successor]", "successor session id (omit for interactive search)")
  .option("-r, --reason <text>", "optional rationale (logged to ~/.nlm/supersedence-log.jsonl)")
  .option("-y, --yes", "skip confirmation")
  .action(async (predecessorArg, successorArg, opts) => {
    await runSupersedeCommand({
      predecessor: predecessorArg,
      successor: successorArg,
      reason: opts.reason,
      yes: Boolean(opts.yes),
    });
  });

program
  .command("classify-parity")
  .description("Run TS classifier against ~/.nlm/canonical.sqlite and diff vs persisted Python output")
  .option("-l, --limit <n>", "sessions to sample", (v) => Number.parseInt(v, 10), 10)
  .option("-p, --provider <name>", "deepseek | ollama", "deepseek")
  .option("-m, --model <name>", "model tag (default: deepseek-v4-flash for deepseek, qwen3.5:4b for ollama)")
  .option("-v, --verbose", "per-session diff lines on stderr")
  .action(async (opts) => {
    const provider = opts.provider === "ollama" ? "ollama" : "deepseek";
    const defaultModel = provider === "deepseek" ? "deepseek-v4-flash" : "qwen3.5:4b";
    const report = await runParity({
      limit: opts.limit,
      dbPath: dbPath(),
      ollamaUrl: ollamaUrl(),
      classifyModel: opts.model ?? defaultModel,
      provider,
      verbose: Boolean(opts.verbose),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });

program
  .command("embed-backfill")
  .description("Re-embed every session into session_embedding_chunks (chunk + max-pool)")
  .option("-l, --limit <n>", "session cap (default: all)", (v) => Number.parseInt(v, 10))
  .option("--state <path>", "resume state file (default ~/.nlm/embed_reembed.state)")
  .option("--exemplars", "instead: embed code_exemplars rows missing a vector (repairs dropped capture embeds)")
  .option("-v, --verbose", "per-session progress on stderr")
  .action(async (opts) => {
    if (opts.exemplars) {
      const { storage } = await buildStack();
      try {
        const report = await backfillExemplarEmbeddings({
          dbPath: dbPath(),
          embedder: buildCodeEmbedder(),
          store: storage.exemplars,
          ...(opts.limit ? { limit: opts.limit } : {}),
          ...(opts.verbose
            ? {
                onProgress: (i: number, n: number, id: string, status: string) => {
                  process.stderr.write(`  [${i}/${n}] ${id}  ${status}\n`);
                },
              }
            : {}),
        });
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } finally {
        await storage.close();
      }
      return;
    }
    const embedder = buildEmbedder();
    const report = await reembedCorpus({
      dbPath: dbPath(),
      embedder,
      ...(opts.state ? { statePath: opts.state } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.verbose
        ? {
            onProgress: (i: number, n: number, sid: string, status: string) => {
              process.stderr.write(`  [${i}/${n}] ${sid}  ${status}\n`);
            },
          }
        : {}),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });

program
  .command("backfill-facts")
  .description("One-shot: classify historical sessions and populate the FactStore (Phase B.5)")
  .option("-l, --limit <n>", "max sessions to process this run", (v) => Number.parseInt(v, 10))
  .option("--from <session-id>", "skip sessions with id <= this value (operator-resume)")
  .option("--state <path>", "resume state file (default ~/.nlm/backfill_facts.state)")
  .option("--dry-run", "count what would happen without writing facts")
  .option("--reprocess", "re-classify sessions that already have facts")
  .option("--no-embed", "skip per-fact embedding (faster but disables semantic recall)")
  .option("-v, --verbose", "per-session progress on stderr")
  .action(async (opts) => {
    const { storage, store, facts, embedder, classifier } = await buildStack();
    try {
      const report = await backfillFacts({
        store,
        factStore: facts,
        classifier,
        embedder: opts.embed === false ? null : embedder,
        ...(opts.state ? { statePath: opts.state } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
        ...(opts.from ? { from: opts.from } : {}),
        dryRun: Boolean(opts.dryRun),
        reprocess: Boolean(opts.reprocess),
        ...(opts.verbose
          ? {
              onProgress: (i, n, sid, status, detail) => {
                const tail = detail ? `  ${detail}` : "";
                process.stderr.write(`  [${i}/${n}] ${sid}  ${status}${tail}\n`);
              },
            }
          : {}),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } finally {
      await storage.close();
    }
  });

program
  .command("reclassify-oversized")
  .description("One-shot: re-classify large sessions that never ingested (hierarchical classify), recover into the corpus")
  .option("-l, --limit <n>", "max sessions to process", (v) => Number.parseInt(v, 10))
  .option("--dry-run", "count candidates without writing", false)
  .action(async (opts: { limit?: number; dryRun?: boolean }) => {
    const { reclassifyOversized } = await import("../core/ingest/reclassify-oversized.js");
    const stack = await buildStack();
    try {
      if (!(stack.storage instanceof SqliteStorage)) {
        console.error("reclassify-oversized: only supported with SQLite storage (NLM_PG_URL must not be set)");
        await stack.storage.close();
        process.exit(1);
      }
      const adapters = await buildAdapters(stack.sources);
      const r = await reclassifyOversized(
        {
          db: stack.storage.rawDb(),
          store: stack.storage.sessions,
          factStore: stack.storage.facts,
          embedder: stack.embedder,
          classifier: stack.classifier,
          adapters,
        },
        { ...(opts.limit ? { limit: opts.limit } : {}), dryRun: Boolean(opts.dryRun) },
      );
      console.log(
        `reclassify-oversized: attempted=${r.attempted} ingested=${r.ingested} ` +
        `lowConfidence=${r.skippedLowConfidence} missingFile=${r.missingFile} failed=${r.failed} ` +
        `| gained entities=${r.entities} decisions=${r.decisions} facts=${r.facts}`,
      );
    } finally {
      await stack.storage.close();
    }
  });

program
  .command("embed-normalize")
  .description("L2-normalize every row in session_embeddings (idempotent)")
  .option("--dim <n>", "vector dimension (default 768)", (v) => Number.parseInt(v, 10), 768)
  .option("--batch <n>", "rows per commit batch (default 100)", (v) => Number.parseInt(v, 10), 100)
  .option("--dry-run", "report what would change without writing")
  .action((opts) => {
    const report = normalizeEmbeddings({
      dbPath: dbPath(),
      dim: opts.dim,
      batchSize: opts.batch,
      dryRun: Boolean(opts.dryRun),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });

program
  .command("mcp")
  .description("Run as an MCP stdio server (for ~/.mcp.json)")
  .action(async () => {
    const { recall, store, facts, factRecall, storage, scope } = await buildStack();
    const server = createMcpServer({
      recall,
      store,
      factStore: facts,
      factRecall,
      exemplarStore: storage.exemplars,
      codeEmbedder: buildCodeEmbedder(),
      installScope: scope,
      workDigest: { store, topicProvider: loadTopicProvider(), workstreams: storage.workstreams, ...workDigestEnv() },
      workstreams: { store: storage.workstreams, sessions: store, facts: facts, exemplars: storage.exemplars },
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

const LAUNCH_AGENT_LABEL = "com.github.pbmagnet4.nlm-memory";
const LAUNCH_AGENT_PLIST = join(
  homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`,
);

const LINUX_SYSTEMD_UNIT_NAME = "nlm.service";
const LINUX_SYSTEMD_UNIT_PATH = join(
  homedir(), ".config", "systemd", "user", LINUX_SYSTEMD_UNIT_NAME,
);

function buildSystemdUnit(nodeExec: string, nlmJs: string): string {
  const logDir = join(homedir(), ".nlm", "logs");
  return `[Unit]
Description=NLM Memory — local AI session memory daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeExec} ${nlmJs} start
WorkingDirectory=${homedir()}
Restart=on-failure
RestartSec=10
StandardOutput=append:${logDir}/daemon-out.log
StandardError=append:${logDir}/daemon-err.log

[Install]
WantedBy=default.target
`;
}

// systemd user instance needs XDG_RUNTIME_DIR (a real user session) and
// systemctl --user to respond. Both are missing on headless servers without
// loginctl enable-linger and in many minimal containers.
function linuxSystemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (!process.env["XDG_RUNTIME_DIR"]) return false;
  return spawnSync("systemctl", ["--user", "--version"], { encoding: "utf8" }).status === 0;
}

function buildPlist(nodeExec: string, nlmJs: string): string {
  const logDir = join(homedir(), ".nlm", "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${nlmJs}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${homedir()}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon-out.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon-err.log</string>
</dict>
</plist>
`;
}

program
  .command("install")
  .description("Install the auto-start daemon (LaunchAgent on macOS, systemd user unit on Linux)")
  .action(() => {
    // Harden before installing the daemon so the persisted unit owner-
    // checks succeed against locked-down ~/.nlm logs.
    hardenNlmDirPermissions();
    if (process.platform === "darwin") {
      const uid = process.getuid?.();
      if (uid === undefined) {
        console.error("nlm install: could not determine UID");
        process.exit(1);
      }
      mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
      writeFileSync(LAUNCH_AGENT_PLIST, buildPlist(process.execPath, __filename), "utf8");
      console.error(`nlm: wrote ${LAUNCH_AGENT_PLIST}`);
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCH_AGENT_LABEL], { stdio: "ignore" });
      } catch {
        // not loaded yet — expected on first install
      }
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCH_AGENT_PLIST]);
      console.error("nlm: daemon installed and started.");
      console.error(`  UI:       http://localhost:${port()}/ui`);
      console.error(`  To stop:  launchctl stop ${LAUNCH_AGENT_LABEL}`);
      console.error("  To remove: nlm uninstall");
      return;
    }

    if (process.platform === "linux") {
      if (!linuxSystemdUserAvailable()) {
        console.error("nlm install: systemd user instance not available.");
        console.error("  XDG_RUNTIME_DIR missing or `systemctl --user` did not respond.");
        console.error("  Common on headless servers without an active user session.");
        console.error("  Start manually with: nlm start &");
        console.error("  Or enable lingering so user units run without login:");
        console.error("    sudo loginctl enable-linger $USER");
        console.error("  Then re-run: nlm install");
        process.exit(1);
      }
      mkdirSync(dirname(LINUX_SYSTEMD_UNIT_PATH), { recursive: true });
      mkdirSync(join(homedir(), ".nlm", "logs"), { recursive: true });
      writeFileSync(LINUX_SYSTEMD_UNIT_PATH, buildSystemdUnit(process.execPath, __filename), "utf8");
      console.error(`nlm: wrote ${LINUX_SYSTEMD_UNIT_PATH}`);
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      execFileSync("systemctl", ["--user", "enable", "--now", LINUX_SYSTEMD_UNIT_NAME]);
      console.error("nlm: daemon installed and started.");
      console.error(`  UI:        http://localhost:${port()}/ui`);
      console.error(`  Status:    systemctl --user status ${LINUX_SYSTEMD_UNIT_NAME}`);
      console.error(`  To stop:   systemctl --user stop ${LINUX_SYSTEMD_UNIT_NAME}`);
      console.error("  To remove: nlm uninstall");
      console.error("  Headless? Run `sudo loginctl enable-linger $USER` so the daemon survives logout.");
      return;
    }

    console.error("nlm install: only macOS and Linux (systemd) are supported.");
    console.error("  On Windows, run `nlm start` manually or via Task Scheduler.");
    process.exit(1);
  });

program
  .command("uninstall")
  .description("Remove the auto-start daemon (LaunchAgent on macOS, systemd user unit on Linux)")
  .action(() => {
    if (process.platform === "linux") {
      // Stop + disable, then remove the unit. Idempotent: ignore "not loaded"
      // errors so re-running uninstall on a half-removed state still finishes.
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", LINUX_SYSTEMD_UNIT_NAME], { stdio: "pipe" });
        console.error(`nlm: stopped and disabled ${LINUX_SYSTEMD_UNIT_NAME}`);
      } catch {
        // Unit wasn't loaded — fine, proceed to file cleanup.
      }
      if (existsSync(LINUX_SYSTEMD_UNIT_PATH)) {
        rmSync(LINUX_SYSTEMD_UNIT_PATH);
        console.error(`nlm: removed ${LINUX_SYSTEMD_UNIT_PATH}`);
      }
      try {
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      } catch {
        // systemd unavailable — file already removed, nothing more to do.
      }
      console.error("nlm: uninstalled. Run `nlm install` to reinstall.");
      return;
    }

    if (process.platform !== "darwin") {
      console.error("nlm uninstall: only macOS and Linux (systemd) are supported.");
      process.exit(1);
    }
    const uid = process.getuid?.();
    if (uid === undefined) {
      console.error("nlm uninstall: could not determine UID");
      process.exit(1);
    }

    let bootoutFailed = false;
    let bootoutStderr = "";
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCH_AGENT_LABEL], { stdio: "pipe" });
      console.error("nlm: daemon stopped.");
    } catch (e) {
      const err = e as { stderr?: Buffer | string };
      bootoutStderr = err.stderr ? err.stderr.toString() : "";
      if (isBenignBootoutError(bootoutStderr)) {
        // Agent wasn't loaded — fine, proceed to plist cleanup.
      } else {
        bootoutFailed = true;
      }
    }

    // Source of truth: did launchd actually unload the agent? Same shape
    // of bug as #161 — silent partial success is worse than loud failure.
    if (isAgentLoaded(LAUNCH_AGENT_LABEL)) {
      console.error("nlm: uninstall FAILED — agent is still loaded after bootout.");
      if (bootoutStderr.trim()) {
        console.error(`  launchctl stderr: ${bootoutStderr.trim()}`);
      }
      console.error("  Recovery options:");
      console.error(`    1. launchctl bootout gui/${uid}/${LAUNCH_AGENT_LABEL}`);
      console.error("    2. If a stale process is holding the port, find it:");
      console.error("       ps aux | grep 'nlm.js start' | grep -v grep");
      console.error("       Then: kill <pid>  (or  kill -9 <pid>  if it ignores TERM)");
      console.error("  Plist NOT removed — re-run `nlm uninstall` after the agent is gone.");
      process.exit(1);
    }

    if (bootoutFailed) {
      // launchctl errored AND the agent isn't loaded — odd but recoverable.
      // Flag it so the user knows something off-script happened.
      console.error(`nlm: bootout reported an error but agent is unloaded: ${bootoutStderr.trim()}`);
    }

    if (existsSync(LAUNCH_AGENT_PLIST)) {
      rmSync(LAUNCH_AGENT_PLIST);
      console.error(`nlm: removed ${LAUNCH_AGENT_PLIST}`);
    }
    console.error("nlm: uninstalled. Run `nlm install` to reinstall.");
  });

program
  .command("restart")
  .description("Restart the running daemon so a freshly-installed binary actually takes effect")
  .action(() => {
    const plan = planRestart({
      platform: process.platform,
      uid: process.getuid?.(),
      agentLoaded: process.platform === "darwin" && isAgentLoaded(LAUNCH_AGENT_LABEL),
      plistExists: existsSync(LAUNCH_AGENT_PLIST),
      systemdAvailable: linuxSystemdUserAvailable(),
      unitFileExists: existsSync(LINUX_SYSTEMD_UNIT_PATH),
      label: LAUNCH_AGENT_LABEL,
      plistPath: LAUNCH_AGENT_PLIST,
      unitName: LINUX_SYSTEMD_UNIT_NAME,
    });

    executeRestartPlan(plan, {
      successMessage: "daemon restarted with new code.",
      execFileSync,
      spawn: spawn as unknown as ExecuteRestartPlanDeps["spawn"],
      execPath: process.execPath,
      filename: __filename,
      pkillPattern: DAEMON_PKILL_PATTERN,
    });
  });

program
  .command("upgrade")
  .description("Install the latest nlm-memory from npm and restart the daemon")
  .action(() => {
    if (isDevBuild(__filename)) {
      console.error("nlm upgrade: you're running a dev build - run `npm run build` to pick up changes.");
      return;
    }

    console.error("nlm: upgrading nlm-memory…");
    try {
      execFileSync("npm", ["install", "-g", "nlm-memory@latest"], { stdio: "inherit" });
    } catch {
      // npm already printed its own error to stderr via stdio: "inherit"
      process.exit(1);
    }

    rmSync(updateCheckCachePath(), { force: true });

    const plan = planRestart({
      platform: process.platform,
      uid: process.getuid?.(),
      agentLoaded: process.platform === "darwin" && isAgentLoaded(LAUNCH_AGENT_LABEL),
      plistExists: existsSync(LAUNCH_AGENT_PLIST),
      systemdAvailable: linuxSystemdUserAvailable(),
      unitFileExists: existsSync(LINUX_SYSTEMD_UNIT_PATH),
      label: LAUNCH_AGENT_LABEL,
      plistPath: LAUNCH_AGENT_PLIST,
      unitName: LINUX_SYSTEMD_UNIT_NAME,
    });

    executeRestartPlan(plan, {
      successMessage: "upgraded and restarted.",
      execFileSync,
      spawn: spawn as unknown as ExecuteRestartPlanDeps["spawn"],
      execPath: process.execPath,
      filename: __filename,
      pkillPattern: DAEMON_PKILL_PATTERN,
    });
  });

const config = program
  .command("config")
  .description("Read and write nlm-memory settings in ~/.nlm/.env");

config
  .command("ui-auth [state]")
  .description("Show or set the WebUI auth mode (on = cookie, off = no auth)")
  .action((state?: string) => {
    autoloadEnv();
    const envPath = join(homedir(), ".nlm", ".env");
    if (state === undefined) {
      const current = process.env["NLM_UI_AUTH"] === "cookie" ? "on" : "off";
      console.error(`nlm config ui-auth: currently ${current}`);
      console.error("  on  → /ui/* and /api/* require a session cookie minted by `nlm ui`");
      console.error("  off → loopback bind is the only check (default)");
      return;
    }
    const normalized = state.toLowerCase();
    let value: string | null;
    if (normalized === "on" || normalized === "cookie") {
      value = "cookie";
    } else if (normalized === "off" || normalized === "none") {
      value = null;
    } else {
      console.error(`nlm config ui-auth: unknown state "${state}". Use "on" or "off".`);
      process.exit(1);
    }
    mkdirSync(dirname(envPath), { recursive: true });
    const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const after = applyEnvAssignment(before, "NLM_UI_AUTH", value);
    writeFileSync(envPath, after, { mode: 0o600 });
    console.error(`nlm config ui-auth: set to ${value === null ? "off" : "on"} in ${envPath}`);
    console.error("  Restart the daemon to pick up the change: nlm restart");
  });

config
  .command("get <key>")
  .description("Read a configuration key from ~/.nlm/.env")
  .action((key: string) => {
    autoloadEnv();
    const value = process.env[key];
    if (value === undefined) {
      console.error(`nlm config get: ${key} is not set`);
      process.exit(1);
    }
    process.stdout.write(value);
  });

program
  .command("ui")
  .description("Open the WebUI, bootstrapping a session cookie via single-use nonce")
  .option("--print", "Print the bootstrap URL to stdout instead of opening a browser (use over SSH when the daemon host is headless or you're accessing via Tailscale)")
  .action(async (opts: { print?: boolean }) => {
    // The daemon autoloads .env at startup, but a fresh shell invoking
    // `nlm ui` won't have NLM_MCP_TOKEN exported unless the user sourced
    // it manually. Mirror the daemon's lookup so this command works from
    // any shell on the same machine.
    autoloadEnv();
    const p = port();
    const token = process.env["NLM_MCP_TOKEN"];
    let target = `http://localhost:${p}/ui/`;
    if (token) {
      // Mint a single-use nonce server-side and put THAT in the URL,
      // not the long-lived token. Browser history retains the nonce
      // but the nonce dies on first use or after ~60 seconds. Replay
      // from any leaked URL fails.
      try {
        const res = await fetch(`http://localhost:${p}/api/ui-bootstrap-nonce`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          console.error(`nlm ui: daemon rejected nonce request (HTTP ${res.status}). Is NLM_MCP_TOKEN current?`);
          process.exit(1);
        }
        const { nonce } = (await res.json()) as { nonce: string };
        target = `http://localhost:${p}/ui/auth?nonce=${encodeURIComponent(nonce)}`;
      } catch (e) {
        console.error(`nlm ui: could not reach the daemon at localhost:${p}. Is it running?`);
        console.error(`  ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }
    if (opts.print) {
      // stdout (not stderr) so the URL can be piped or captured cleanly.
      // The accompanying status line goes to stderr.
      if (token) {
        console.error(`nlm ui: paste this URL into your browser within ~60s (nonce expires):`);
      } else {
        console.error("nlm ui: visit this URL in your browser:");
      }
      process.stdout.write(`${target}\n`);
      return;
    }
    const opener = process.platform === "darwin"
      ? "open"
      : process.platform === "linux"
      ? "xdg-open"
      : null;
    if (opener) {
      try {
        execFileSync(opener, [target], { stdio: "ignore" });
        console.error(`nlm: opened the WebUI${token ? " (bootstrapping session cookie)" : ""}.`);
        return;
      } catch {
        // Fall through to print-only.
      }
    }
    console.error("nlm: could not auto-open a browser. Visit:");
    console.error(`  ${target}`);
  });

const HOOK_JS = resolve(__dirname, "../hook/prompt-recall-hook.js");
const SESSION_START_HOOK_JS = resolve(__dirname, "../hook/session-start-hook.js");
const SESSION_END_HOOK_JS = resolve(__dirname, "../hook/session-end-hook.js");
const STOP_HOOK_JS = resolve(__dirname, "../hook/stop-hook.js");
const PRE_COMPACT_HOOK_JS = resolve(__dirname, "../hook/pre-compact-hook.js");
const SUBAGENT_START_HOOK_JS = resolve(__dirname, "../hook/subagent-start-hook.js");

interface HookSpec {
  readonly event: "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop" | "PreCompact" | "SubagentStart";
  readonly script: string;
  readonly label: string;
}

const ALL_HOOKS: ReadonlyArray<HookSpec> = [
  { event: "UserPromptSubmit", script: HOOK_JS, label: "recall" },
  { event: "SessionStart", script: SESSION_START_HOOK_JS, label: "session-start" },
  { event: "SessionEnd", script: SESSION_END_HOOK_JS, label: "session-end" },
  { event: "Stop", script: STOP_HOOK_JS, label: "stop" },
  { event: "PreCompact", script: PRE_COMPACT_HOOK_JS, label: "pre-compact" },
  { event: "SubagentStart", script: SUBAGENT_START_HOOK_JS, label: "subagent-start" },
];

function claudeSettingsPath(): string {
  return process.env["NLM_CLAUDE_SETTINGS"] ?? join(homedir(), ".claude", "settings.json");
}

const hook = program
  .command("hook")
  .description("Manage the Claude Code NLM hooks");

hook
  .command("install")
  .description("Add the NLM hooks (recall + session-end + stop) to ~/.claude/settings.json (live mode)")
  .action(() => {
    const path = claudeSettingsPath();
    const installed: HookSpec[] = [];
    for (const spec of ALL_HOOKS) {
      const command = buildHookCommand(process.execPath, spec.script, "live");
      try {
        addHook(path, command, spec.event);
        installed.push(spec);
      } catch (e) {
        for (const prior of installed) removeHook(path, prior.event);
        console.error(`nlm: ${spec.label} hook (${spec.event}) install failed — all NLM hooks reverted.`);
        console.error(`  reason: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }

    console.error(`nlm: NLM hooks installed in ${path} (live mode):`);
    for (const spec of installed) {
      console.error(`  - ${spec.event} → ${spec.label}-hook`);
    }
    console.error("  Recall hooks inject prior-session context on UserPromptSubmit and log to ~/.nlm/hook-log.jsonl.");
    console.error("  Session-end hook cleans up ~/.nlm/hook-state/<session>.json on session close.");
    console.error("  To run silently for calibration (no injection): set NLM_HOOK_MODE=shadow in the command.");
    console.error("  To remove: nlm hook uninstall");
  });

hook
  .command("uninstall")
  .description("Remove all NLM hooks from ~/.claude/settings.json")
  .action(() => {
    const path = claudeSettingsPath();
    removeHook(path, "*");
    console.error(`nlm: all NLM hooks removed from ${path}.`);
  });

// Repo root resolves to <pkg>/dist/cli/nlm.js → <pkg>/. The plugin tree is
// shipped alongside dist/ so plugin/scripts/ is reachable from both local
// dev and the globally-installed package.
const REPO_ROOT = resolve(__dirname, "../..");

const connect = program
  .command("connect")
  .description("Connect nlm-memory to an AI coding runtime");

connect
  .command("codex")
  .description("Install nlm-memory as a Codex CLI plugin (marketplace + plugin add)")
  .option("--source <source>", "marketplace source (owner/repo, git URL, or local path)", "pbmagnet4/nlm-memory")
  .option("--local", "shortcut for --source <repo-root>; use during dev")
  .option("--with-hooks", "additionally write absolute paths to ~/.codex/hooks.json (Codex Desktop fallback for openai/codex#16430)")
  .option("--repair", "first strip a stale pre-rename nlm-memory-ts install (config block + plugin + marketplace), then connect")
  .option("--dry-run", "print what would happen without invoking codex")
  .action((opts) => {
    if (!opts.dryRun && !codexBinaryAvailable()) {
      console.error("nlm connect codex: `codex` binary not on PATH. Install via `npm i -g @openai/codex` or `brew install codex`.");
      process.exit(1);
    }
    const source = opts.local ? REPO_ROOT : opts.source;
    const connectOpts = { source, withHooks: Boolean(opts.withHooks), dryRun: Boolean(opts.dryRun) };
    const repair = opts.repair
      ? repairCodex(connectOpts, pluginScriptsDir(REPO_ROOT))
      : null;
    const report = repair ? repair.connect : connectCodex(connectOpts, pluginScriptsDir(REPO_ROOT));

    if (repair && !repair.dryRun) {
      console.error(
        repair.staleMcpRemovedFromConfig
          ? "nlm connect codex --repair: stripped stale nlm-memory-ts MCP block from config.toml"
          : "nlm connect codex --repair: no stale nlm-memory-ts MCP block found",
      );
    }

    if (report.dryRun) {
      if (repair) console.error("  --repair: would strip any stale nlm-memory-ts block, then:");
      console.error("nlm connect codex (dry run):");
      console.error(`  codex plugin marketplace add ${report.source}`);
      console.error(`  codex plugin add ${report.pluginName}@${report.marketplaceName}`);
      console.error(`  write [mcp_servers.nlm-memory] block to ${report.mcpServerWritten}`);
      if (report.legacyHooksWritten) {
        console.error(`  write legacy fallback to ${report.legacyHooksWritten}`);
      }
      return;
    }

    if (report.marketplaceAdd && report.marketplaceAdd.status !== 0) {
      const stderr = report.marketplaceAdd.stderr.trim();
      console.error(`nlm connect codex: marketplace add failed (exit ${report.marketplaceAdd.status}).`);
      if (stderr) console.error(`  codex stderr: ${stderr}`);
      process.exit(1);
    }
    if (report.pluginAdd && report.pluginAdd.status !== 0) {
      const stderr = report.pluginAdd.stderr.trim();
      console.error(`nlm connect codex: plugin add failed (exit ${report.pluginAdd.status}).`);
      if (stderr) console.error(`  codex stderr: ${stderr}`);
      process.exit(1);
    }

    console.error(`nlm: connected to Codex via marketplace ${report.marketplaceName}, plugin ${report.pluginName}.`);
    if (report.mcpServerWritten) {
      console.error(`  Wrote [mcp_servers.nlm-memory] to ${report.mcpServerWritten}`);
    } else if (report.mcpServerAlreadyPresent) {
      console.error("  Left your existing [mcp_servers.nlm-memory] block in place (not overwriting it)");
    }
    if (report.legacyHooksWritten) {
      console.error(`  Wrote hooks.json fallback to ${report.legacyHooksWritten}`);
    }
    console.error("  Next: run `codex` interactively and approve the hook trust prompts. Then prompt — recall should fire.");
  });

connect
  .command("claude-code")
  .description("Write the nlm-memory MCP server block into ~/.mcp.json")
  .option("--with-hooks", "also install Claude Code session hooks")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error("nlm connect claude-code (dry run):");
      console.error(`  write [mcpServers.nlm-memory] to ${mcpConfigPath()}`);
      if (opts.withHooks) console.error("  install 6 Claude Code hooks");
      return;
    }
    const report = connectClaudeCode({ nlmBinPath: __filename, nodeExecPath: process.execPath });
    const action = report.alreadyPresent ? "updated" : "written";
    console.error(`nlm: [mcpServers.nlm-memory] ${action} → ${report.mcpConfigPath}`);
    console.error("  Restart Claude Code to activate the MCP server.");
    if (opts.withHooks) {
      const path = claudeSettingsPath();
      const result = installClaudeCodeHooks({
        nodeExecPath: process.execPath,
        hooks: ALL_HOOKS,
        settingsPath: path,
        addHook,
        removeHook,
        buildHookCommand,
      });
      if (!result.ok) {
        console.error(`nlm: ${result.failedLabel ?? "hook"} install failed — all hooks reverted. Run \`nlm hook install\` manually.`);
        process.exit(1);
      }
      console.error(`nlm: ${result.count} hooks installed → ${path}`);
    }
  });

connect
  .command("hermes")
  .description("Write the nlm-memory MCP server entry into ~/.hermes/config.yaml")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error(`nlm connect hermes (dry run): write [mcp_servers.nlm-memory] to ${hermesConfigPath()}`);
      return;
    }
    const report = connectHermes({ nlmBinPath: __filename, nodeExecPath: process.execPath, dryRun: false });
    const action = report.alreadyPresent ? "updated" : "written";
    console.error(`nlm: [mcp_servers.nlm-memory] ${action} → ${report.configPath}`);
    console.error("  Restart Hermes to activate the MCP server.");
  });

connect
  .command("hermes-agent")
  .description("Install the nlm-memory plugin into NousResearch Hermes Agent (~/.hermes/plugins/nlm-memory/)")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const pluginSrcDir = join(REPO_ROOT, "plugin-hermes-agent");
    if (opts.dryRun) {
      console.error(`nlm connect hermes-agent (dry run): copy ${pluginSrcDir} → ${hermesAgentPluginDir()}`);
      console.error("  then: hermes plugins enable nlm-memory");
      return;
    }
    const report = connectHermesAgent({ pluginSrcDir, dryRun: false });
    const action = report.alreadyPresent ? "updated" : "installed";
    console.error(`nlm: nlm-memory plugin ${action} → ${report.destDir}`);
    if (report.enabledViaCli) {
      console.error("  Enabled via: hermes plugins enable nlm-memory");
    } else {
      console.error("  Run: hermes plugins enable nlm-memory (if hermes binary is on PATH)");
    }
    console.error("  Also run: nlm connect hermes  (to wire the MCP server)");
  });

connect
  .command("cursor")
  .description("Register Cursor as an nlm source (reads state.vscdb directly — no files installed)")
  .option("--db-path <path>", "override path to globalStorage/state.vscdb")
  .option("--with-rules", "also install workspace rules nudge at .cursor/rules/nlm-recall.mdc")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      const report = await connectCursor(storage.sources, {
        ...(opts.dbPath ? { dbPath: opts.dbPath as string } : {}),
        dryRun: Boolean(opts.dryRun),
      });
      if (opts.dryRun) {
        console.error(`nlm connect cursor (dry run): register source at ${report.adapterDbPath}${report.adapterExists ? "" : " (not found yet)"}`);
        if (opts.withRules) console.error("  also install workspace rules nudge at ./.cursor/rules/nlm-recall.mdc");
        return;
      }
      const suffix = report.adapterExists ? "" : " (DB not found — will activate when Cursor is installed)";
      console.error(`nlm: Cursor source ${report.action} → ${report.adapterDbPath}${suffix}`);
      if (opts.withRules) {
        const rules = installCursorRules();
        console.error(`  ${describeUpsert("Cursor", rules)}`);
        console.error("  Note: workspace-scoped. Re-run inside each project where you want the nudge.");
      }
    } finally {
      await storage.close();
    }
  });

connect
  .command("windsurf")
  .description("Register Windsurf as an nlm source (reads state.vscdb files directly — no files installed)")
  .option("--user-dir <path>", "override path to Windsurf User directory")
  .option("--with-rules", "also install global rules nudge at ~/.codeium/windsurf/memories/global_rules.md")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      const report = await connectWindsurf(storage.sources, {
        ...(opts.userDir ? { userDir: opts.userDir as string } : {}),
        dryRun: Boolean(opts.dryRun),
      });
      if (opts.dryRun) {
        console.error(`nlm connect windsurf (dry run): register source at ${report.userDir}${report.dirExists ? "" : " (not found yet)"}`);
        if (opts.withRules) console.error("  also install global rules nudge at ~/.codeium/windsurf/memories/global_rules.md");
        return;
      }
      const suffix = report.dirExists ? "" : " (User dir not found — will activate when Windsurf is installed)";
      console.error(`nlm: Windsurf source ${report.action} → ${report.userDir}${suffix}`);
      if (opts.withRules) {
        const rules = installWindsurfRules();
        console.error(`  ${describeUpsert("Windsurf", rules)}`);
      }
    } finally {
      await storage.close();
    }
  });

connect
  .command("opencode")
  .description("Register OpenCode as an nlm source (reads opencode.db directly) and optionally install rules nudge")
  .option("--with-rules", "also install global rules nudge at ~/.config/opencode/AGENTS.md")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error("nlm connect opencode (dry run):");
      console.error("  OpenCode adapter is already wired via migrations/010_sources_opencode.sql — no source-registry mutation required");
      if (opts.withRules) console.error("  install global rules nudge at ~/.config/opencode/AGENTS.md");
      return;
    }
    console.error("nlm: OpenCode source already registered (see migration 010). No source-registry changes needed.");
    if (opts.withRules) {
      const rules = installOpencodeRules();
      console.error(`  ${describeUpsert("OpenCode", rules)}`);
    } else {
      console.error("  Pass --with-rules to install the recall nudge at ~/.config/opencode/AGENTS.md");
    }
  });

connect
  .command("pi")
  .description("Register the nlm-memory prompt-recall extension in ~/.pi/agent/settings.json")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const pluginDir = join(REPO_ROOT, "nlm");
    const report = connectPi({ pluginDir, dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      const verb = report.alreadyPresent ? "already present in" : "append to";
      console.error(`nlm connect pi (dry run): ${verb} packages[] in ${report.settingsPath} → ${pluginDir}`);
      return;
    }
    if (report.alreadyPresent) {
      console.error(`nlm: pi extension already registered → ${report.pluginDir}`);
    } else {
      console.error(`nlm: pi extension registered → ${report.settingsPath}`);
      console.error(`  Packages entry: ${report.pluginDir}`);
    }
    console.error("  Restart pi to activate the prompt-recall hook.");
    console.error("  Set NLM_HOOK_MODE=live in ~/.nlm/.env to flip from shadow → live.");
  });

const disconnect = program
  .command("disconnect")
  .description("Disconnect nlm-memory from an AI coding runtime");

disconnect
  .command("codex")
  .description("Remove the nlm-memory plugin + marketplace from Codex")
  .option("--with-hooks", "also strip our entries from ~/.codex/hooks.json")
  .option("--dry-run", "print what would happen without invoking codex")
  .action((opts) => {
    if (!opts.dryRun && !codexBinaryAvailable()) {
      console.error("nlm disconnect codex: `codex` binary not on PATH.");
      process.exit(1);
    }
    const report = disconnectCodex({
      withHooks: Boolean(opts.withHooks),
      dryRun: Boolean(opts.dryRun),
    });

    if (report.dryRun) {
      console.error("nlm disconnect codex (dry run):");
      console.error(`  codex plugin remove ${report.pluginName}@${report.marketplaceName}`);
      console.error(`  codex plugin marketplace remove ${report.marketplaceName}`);
      console.error("  strip [mcp_servers.nlm-memory] block from ~/.codex/config.toml");
      if (opts.withHooks) console.error("  strip our entries from ~/.codex/hooks.json");
      return;
    }

    // Best-effort removal — non-zero exits from codex are reported but
    // don't abort, because partial cleanup (plugin removed, marketplace
    // already gone) is the common case for repeat invocations.
    const pluginStderr = (report.pluginRemove?.stderr ?? "").trim();
    const marketStderr = (report.marketplaceRemove?.stderr ?? "").trim();
    if (report.pluginRemove?.status !== 0 && pluginStderr) {
      console.error(`  plugin remove: ${pluginStderr}`);
    }
    if (report.marketplaceRemove?.status !== 0 && marketStderr) {
      console.error(`  marketplace remove: ${marketStderr}`);
    }
    console.error("nlm: disconnected from Codex.");
    console.error(report.mcpServerRemoved
      ? "  Stripped [mcp_servers.nlm-memory] block from ~/.codex/config.toml"
      : "  No [mcp_servers.nlm-memory] block to remove from ~/.codex/config.toml");
    if (opts.withHooks) {
      console.error(report.legacyHooksRemoved
        ? "  Stripped our entries from ~/.codex/hooks.json"
        : "  No legacy hooks to remove from ~/.codex/hooks.json");
    }
  });

disconnect
  .command("claude-code")
  .description("Remove the nlm-memory MCP server block from ~/.mcp.json")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectClaudeCode({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect claude-code (dry run): strip [mcpServers.nlm-memory] from ${report.mcpConfigPath}`);
      return;
    }
    console.error(report.removed
      ? `nlm: removed [mcpServers.nlm-memory] from ${report.mcpConfigPath}`
      : `nlm: no [mcpServers.nlm-memory] entry found in ${report.mcpConfigPath}`);
  });

disconnect
  .command("hermes")
  .description("Remove the nlm-memory MCP server entry from ~/.hermes/config.yaml")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectHermes({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect hermes (dry run): strip [mcp_servers.nlm-memory] from ${report.configPath}`);
      return;
    }
    console.error(report.removed
      ? `nlm: removed [mcp_servers.nlm-memory] from ${report.configPath}`
      : `nlm: no [mcp_servers.nlm-memory] entry found in ${report.configPath}`);
  });

disconnect
  .command("hermes-agent")
  .description("Remove the nlm-memory plugin from ~/.hermes/plugins/nlm-memory/")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectHermesAgent({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect hermes-agent (dry run): remove ${hermesAgentPluginDir()}`);
      return;
    }
    console.error(report.removed
      ? `nlm: removed plugin directory ${report.destDir}`
      : `nlm: no plugin directory found at ${report.destDir}`);
  });

disconnect
  .command("cursor")
  .description("Disable the Cursor source in the nlm registry (leaves Cursor untouched)")
  .option("--with-rules", "also remove workspace rules nudge at .cursor/rules/nlm-recall.mdc")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      const report = await disconnectCursor(storage.sources, { dryRun: Boolean(opts.dryRun) });
      if (opts.dryRun) {
        console.error("nlm disconnect cursor (dry run): disable Cursor source in registry");
        if (opts.withRules) console.error("  also remove ./.cursor/rules/nlm-recall.mdc");
        return;
      }
      console.error(report.action === "disabled"
        ? "nlm: Cursor source disabled"
        : "nlm: no Cursor source found in registry");
      if (opts.withRules) {
        const rules = uninstallCursorRules();
        console.error(`  ${describeRemove("Cursor", rules)}`);
      }
    } finally {
      await storage.close();
    }
  });

disconnect
  .command("windsurf")
  .description("Disable the Windsurf source in the nlm registry (leaves Windsurf untouched)")
  .option("--with-rules", "also remove global rules nudge at ~/.codeium/windsurf/memories/global_rules.md")
  .option("--dry-run", "print what would happen without changing files")
  .action(async (opts) => {
    const storage = SqliteStorage.create({ dbPath: dbPath(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    try {
      const report = await disconnectWindsurf(storage.sources, { dryRun: Boolean(opts.dryRun) });
      if (opts.dryRun) {
        console.error("nlm disconnect windsurf (dry run): disable Windsurf source in registry");
        if (opts.withRules) console.error("  also strip rules nudge from ~/.codeium/windsurf/memories/global_rules.md");
        return;
      }
      console.error(report.action === "disabled"
        ? "nlm: Windsurf source disabled"
        : "nlm: no Windsurf source found in registry");
      if (opts.withRules) {
        const rules = uninstallWindsurfRules();
        console.error(`  ${describeRemove("Windsurf", rules)}`);
      }
    } finally {
      await storage.close();
    }
  });

disconnect
  .command("opencode")
  .description("Strip the rules nudge from ~/.config/opencode/AGENTS.md (leaves OpenCode source registered)")
  .option("--with-rules", "remove rules nudge (default behavior — flag is for symmetry with connect)")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    if (opts.dryRun) {
      console.error("nlm disconnect opencode (dry run): strip rules nudge from ~/.config/opencode/AGENTS.md");
      return;
    }
    const rules = uninstallOpencodeRules();
    console.error(`nlm: ${describeRemove("OpenCode", rules)}`);
  });

disconnect
  .command("pi")
  .description("Remove the nlm-memory pi extension from ~/.pi/agent/settings.json")
  .option("--dry-run", "print what would happen without changing files")
  .action((opts) => {
    const report = disconnectPi({ dryRun: Boolean(opts.dryRun) });
    if (opts.dryRun) {
      console.error(`nlm disconnect pi (dry run): strip nlm (and legacy plugin-pi) from packages[] in ${piSettingsPath()}`);
      return;
    }
    console.error(report.removed
      ? `nlm: pi extension removed → ${report.settingsPath}`
      : `nlm: no nlm pi extension found in ${report.settingsPath}`);
  });

program
  .command("setup")
  .description("Interactive first-run setup: detect runtimes, wire MCP + hooks, start daemon")
  .action(async () => {
    await runSetup({
      nlmBinPath: __filename,
      nodeExecPath: process.execPath,
      migrationsDir: MIGRATIONS_DIR,
      repoRoot: REPO_ROOT,
      dbPath: dbPath(),
      launchAgentLabel: LAUNCH_AGENT_LABEL,
      launchAgentPlist: LAUNCH_AGENT_PLIST,
      buildPlist,
      linuxSystemdUnitName: LINUX_SYSTEMD_UNIT_NAME,
      linuxSystemdUnitPath: LINUX_SYSTEMD_UNIT_PATH,
      buildSystemdUnit,
      linuxSystemdUserAvailable,
      claudeSettingsPath: claudeSettingsPath(),
      allHooks: ALL_HOOKS,
      addHook,
      removeHook,
      buildHookCommand,
    });
  });

program
  .command("improve")
  .description("Report known failure modes + recommended actions from captured signals")
  .option("--days <n>", "trailing window in days (default 14)", (v) => Number.parseInt(v, 10), 14)
  .action(async (opts) => {
    const storage = await buildStorage(dbPath());
    const scope = installScope();
    const sinceTs = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    const rows = await storage.signals.listForAggregation({ installScope: scope, sinceTs });
    const { aggregateFailureModes } = await import("../core/signals/aggregate.js");
    const { recommendActions } = await import("../core/signals/recommend.js");
    const modes = aggregateFailureModes(rows);
    if (modes.length === 0) {
      console.error(`nlm improve: no failure modes above threshold in the last ${opts.days}d (${rows.length} signals).`);
      await storage.close();
      return;
    }
    console.error(`Failure modes (last ${opts.days}d, ${rows.length} signals):`);
    for (const m of modes) {
      console.error(`  ${m.model} ${m.repo} ${m.kind}/${m.step ?? "-"}: ${Math.round(m.failRate * 100)}% of ${m.total}`);
    }
    console.error("\nRecommendations:");
    for (const r of recommendActions(modes)) console.error(`  [${r.kind}] ${r.text}`);
    await storage.close();
  });

program
  .command("digest")
  .description("Compose a daily-activity digest from the running daemon (optionally post to Telegram)")
  .option("-p, --port <n>", "daemon port", (v) => Number.parseInt(v, 10), Number.parseInt(process.env["NLM_PORT"] ?? "3940", 10))
  .option("--telegram", "post to Telegram instead of printing to stdout (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)")
  .action(async (opts) => {
    autoloadEnv();
    try {
      const result = await runDigest({
        port: opts.port as number,
        telegram: opts.telegram === true,
      });
      if (!result.daemonReachable) {
        process.exit(1);
      }
    } catch (e) {
      console.error("nlm digest:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command("work-digest")
  .description("Print the operator's agent-assisted work recap for a day")
  .option("-d, --date <date>", "day to summarize, YYYY-MM-DD (default: today)")
  .action(async (opts) => {
    const date = resolveDigestDate(opts.date as string | undefined);
    const { storage, store } = await buildStack();
    try {
      const digest = await buildWorkDigest(
        { store, topicProvider: loadTopicProvider(), workstreams: storage.workstreams, ...workDigestEnv() },
        date,
      );
      console.log(composeWorkDigest(digest));
    } finally {
      await storage.close();
    }
  });

async function gatherInstallProbe(): Promise<InstallProbe> {
  autoloadEnv();

  let reachable = false;
  let version: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1_500);
    const res = await fetch(`http://localhost:${port()}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      reachable = true;
      version = typeof body.version === "string" ? body.version : null;
    }
  } catch {
    // unreachable — reported as a FAIL by the evaluator
  }

  const mcpPath = mcpConfigPath();
  let claudeMcp = false;
  try {
    if (existsSync(mcpPath)) {
      const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      claudeMcp = Boolean(cfg.mcpServers && "nlm-memory" in cfg.mcpServers);
    }
  } catch {
    // malformed config → treat as unconfigured (connect will rewrite it)
  }

  const codexPath = codexConfigPath();
  let codexPresent = false;
  let codexMcp = false;
  let codexStale = false;
  if (existsSync(codexPath)) {
    codexPresent = true;
    const txt = readFileSync(codexPath, "utf8");
    // Recognize the MCP table whether it's our managed (sentineled) block or a
    // hand-authored bare one — both wire the server.
    codexMcp = txt.split("\n").some((l) => l.trim() === "[mcp_servers.nlm-memory]");
    // Match the marketplace suffix, not the bare name: a [projects."…/nlm-memory-ts"]
    // trust entry is Codex's registry (not nlm's), so it must not trip this check.
    codexStale = txt.includes("@nlm-memory-ts");
  }

  const envPath = join(homedir(), ".nlm", ".env");
  return {
    daemon: { reachable, version, expectedVersion: pkg.version },
    env: {
      path: envPath,
      exists: existsSync(envPath),
      hasMcpToken: Boolean(process.env["NLM_MCP_TOKEN"]),
    },
    claudeCode: { configPath: mcpPath, mcpConfigured: claudeMcp },
    codex: {
      configPath: codexPath,
      configPresent: codexPresent,
      mcpConfigured: codexMcp,
      staleNlmMemoryTs: codexStale,
    },
  };
}

program
  .command("doctor")
  .description("Check database integrity invariants and install/runtime health, optionally repair safe violations")
  .option("--fix", "repair mechanically safe violations: delete self-loop edges (I1), restore orphaned superseded/replaced sessions to closed (I2), delete ghost fact embeddings (I7)")
  .action(async (opts) => {
    const storage = await buildStorage(dbPath());
    let violations;
    let fixReport;
    try {
      if (opts.fix) {
        if (storage instanceof PgStorage) {
          fixReport = await applyFixOnPg(storage.pgPool());
        } else {
          fixReport = applyFixOnSqlite((storage as SqliteStorage).rawDb());
        }
        if (fixReport.deletedSelfLoops > 0) {
          console.log(`  fixed I1: deleted ${fixReport.deletedSelfLoops} self-loop edge(s)`);
        }
        if (fixReport.restoredToClosed > 0) {
          console.log(`  fixed I2: restored ${fixReport.restoredToClosed} session(s) to closed`);
        }
        if (fixReport.deletedGhostEmbeddings > 0) {
          console.log(`  fixed I7: deleted ${fixReport.deletedGhostEmbeddings} ghost embedding(s)`);
        }
        if (fixReport.deletedSelfLoops === 0 && fixReport.restoredToClosed === 0 && fixReport.deletedGhostEmbeddings === 0) {
          console.log("  --fix: nothing to repair");
        }
      }
      if (storage instanceof PgStorage) {
        violations = await runChecksOnPg(storage.pgPool());
      } else {
        violations = runChecksOnSqlite((storage as SqliteStorage).rawDb());
      }
    } finally {
      await storage.close();
    }

    const ALL_CHECKS = ["I1", "I2", "I3", "I4", "I5a", "I5b", "I6", "I7"];
    const byId = new Map(violations.map((v) => [v.id, v]));
    let anyFail = false;
    console.log("Database integrity:");
    for (const id of ALL_CHECKS) {
      const v = byId.get(id);
      if (v) {
        anyFail = true;
        const samples = v.sampleIds.length > 0 ? `  samples: ${v.sampleIds.slice(0, 5).join(", ")}` : "";
        console.log(`FAIL ${id}  count=${v.count}  ${v.description}${samples ? "\n" + samples : ""}`);
      } else {
        console.log(`PASS ${id}`);
      }
    }

    console.log("\nInstall & runtime health:");
    if (printHealthChecks(evaluateInstallHealth(await gatherInstallProbe()))) anyFail = true;

    if (anyFail) process.exit(1);
  });

function printHealthChecks(checks: ReadonlyArray<HealthCheck>): boolean {
  let anyFail = false;
  for (const c of checks) {
    if (c.status === "fail") anyFail = true;
    const label = c.status === "ok" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
    const fix = c.fix ? `\n  → fix: ${c.fix}` : "";
    console.log(`${label} ${c.id}  ${c.detail}${fix}`);
  }
  return anyFail;
}

async function dbIntegrityCheck(): Promise<HealthCheck> {
  const storage = await buildStorage(dbPath());
  try {
    const violations =
      storage instanceof PgStorage
        ? await runChecksOnPg(storage.pgPool())
        : runChecksOnSqlite((storage as SqliteStorage).rawDb());
    if (violations.length === 0) return { id: "db-integrity", status: "ok", detail: "all invariants hold" };
    return {
      id: "db-integrity",
      status: "fail",
      detail: `violations: ${violations.map((v) => v.id).join(", ")}`,
      fix: "nlm doctor --fix",
    };
  } finally {
    await storage.close();
  }
}

async function recallSmokeCheck(): Promise<HealthCheck> {
  let reachable = false;
  let status: number | null = null;
  let wellFormed = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3_000);
    const res = await fetch(`http://localhost:${port()}/api/recall?q=verify&limit=1`, { signal: ctrl.signal });
    clearTimeout(timer);
    reachable = true;
    status = res.status;
    const body = (await res.json().catch(() => null)) as { results?: unknown } | null;
    wellFormed = Boolean(body && Array.isArray(body.results));
  } catch {
    // unreachable — evaluateRecallSmoke reports the fail
  }
  return evaluateRecallSmoke(reachable, status, wellFormed);
}

program
  .command("verify")
  .description("Release-gate: verify the install is wired and recall works end-to-end. Exit 1 on any failure.")
  .action(async () => {
    const provider = (process.env["NLM_CLASSIFIER"] ?? "ollama").toLowerCase();
    const classifierModel =
      process.env["NLM_CLASSIFIER_MODEL"] ?? (provider === "ollama" ? "qwen3.5:4b" : "deepseek-v4-flash");
    const classifierPresent = provider === "ollama" ? ollamaModelPresent(classifierModel) : true;

    const checks: HealthCheck[] = [
      ...evaluateInstallHealth(await gatherInstallProbe()),
      evaluateModelHealth(embeddingModelPresent(), classifierModel, classifierPresent),
      await dbIntegrityCheck(),
      await recallSmokeCheck(),
    ];

    const anyFail = printHealthChecks(checks);
    const warns = checks.filter((c) => c.status === "warn").length;
    console.log(anyFail ? "\nVERIFY: FAIL" : warns > 0 ? `\nVERIFY: PASS (${warns} warning(s))` : "\nVERIFY: PASS");
    if (anyFail) process.exit(1);
  });

program
  .command("backup")
  .description("Write a dated snapshot to ~/.nlm/backups/ and prune ones past the retention window")
  .option("--retention <days>", "keep snapshots from the last N days", "7")
  .action(async (opts) => {
    const retention = Number.parseInt(opts.retention, 10);
    if (!Number.isFinite(retention) || retention < 1) {
      console.error("nlm backup: --retention must be a positive integer");
      process.exit(1);
    }
    const today = new Date().toISOString().slice(0, 10);
    const storage = await buildStorage(dbPath());
    try {
      if (storage instanceof PgStorage) {
        console.error("nlm backup: only the SQLite backend is supported (Postgres: use pg_dump)");
        process.exit(1);
      }
      const result = runRollingBackup((storage as SqliteStorage).rawDb(), dbPath(), today, retention);
      console.log(`Wrote ${result.written} (${(result.bytes / 1_048_576).toFixed(1)} MiB)`);
      if (result.pruned.length > 0) console.log(`Pruned ${result.pruned.length} snapshot(s) older than ${retention}d`);
    } finally {
      await storage.close();
    }
  });

program
  .command("restore")
  .description("Stage a dated backup for restore on next daemon start (does not overwrite the live DB in place)")
  .option("--from <date>", "backup date to restore (YYYY-MM-DD)")
  .option("--list", "list available backup dates")
  .action((opts) => {
    if (opts.list || !opts.from) {
      const dates = listBackupDates(dbPath());
      if (dates.length === 0) {
        console.log("No backups found. Run `nlm backup` (or wait for the daily job).");
        return;
      }
      console.log("Available backups:");
      for (const d of dates) console.log(`  ${d}`);
      if (!opts.from) console.log("\nRestore one with: nlm restore --from <date>");
      return;
    }

    const backup = resolveBackup(dbPath(), opts.from);
    if (!backup) {
      console.error(`nlm restore: no backup for ${opts.from}. Run \`nlm restore --list\` to see options.`);
      process.exit(1);
    }

    // Copy (not move) the snapshot to a scratch candidate so the backup is
    // preserved; stageRestore renames the candidate into the pending slot.
    const candidate = `${dbPath()}.restore-candidate`;
    copyFileSync(backup, candidate);
    const validation = stageRestore(dbPath(), candidate);
    if (!validation.ok) {
      console.error(`nlm restore: ${opts.from} is not a usable backup: ${validation.error}`);
      process.exit(1);
    }
    console.log(`Staged ${opts.from} (${validation.sessions} sessions, schema v${validation.schemaVersion}).`);
    console.log("Run `nlm restart` to apply — the current DB is archived aside, not deleted.");
  });

program.parseAsync().catch((e) => {
  console.error("nlm: fatal", e);
  process.exit(1);
});
