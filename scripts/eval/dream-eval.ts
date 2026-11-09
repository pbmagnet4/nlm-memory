/**
 * Dream-eval runner — one command over the dream-pass scoring core.
 *
 * Loads the eval pipeline's *existing* labelled artifacts, scores them with
 * the pure functions in src/core/eval/dream-metrics.ts, and writes a markdown
 * report plus JSON into reports/dream-eval/. No model ever grades anything
 * here: every verdict in the report was produced upstream by the blind
 * labelling pipeline (re-derivation judge + independent human/model labeler);
 * this runner only reads those files and does deterministic arithmetic.
 *
 * Arms (each independently optional — a missing input yields a null metric
 * and a warning, never a crash):
 *  1. reDerivation  ← <rederivDir>/labels.jsonl joined with sample.jsonl on
 *     the pair's earlier-session startedAt (rate by fixed UTC window).
 *  2. correction    ← fact-judge labels.json (items[] of fact-judge-label.ts).
 *  3. merge         ← the SKIP_NEW subset of the same items[].
 *  4. injection     ← hook-log.jsonl joined to citation-log.jsonl by
 *     conversation id (tokens injected per hit the agent actually cited).
 *
 * Production safety: the corpus stats open a COPY of the canonical DB under a
 * temp dir, exactly like fact-recall-eval.ts's sandboxCopy (WAL/SHM included).
 * The live daemon DB at ~/.nlm is never opened.
 *
 * Run:
 *   npm run eval:dream
 *   npx tsx scripts/eval/dream-eval.ts [--db=<path>] [--rederiv-dir=reports/re-derivation]
 *     [--labels-name=labels.jsonl] [--fact-judge-labels=<labels.json>]
 *     [--logs-dir=~/.nlm] [--out-dir=reports/dream-eval] [--window-days=7]
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  correctionMetrics,
  injectionCostPerUsefulHit,
  mergePrecision,
  reDerivationRateByWindow,
  type CitationRow,
  type CorrectionMetrics,
  type FactJudgeLabelItem,
  type HookFireRow,
  type InjectionCost,
  type MergePrecision,
  type ReDerivationLabelRow,
  type ReDerivationRate,
} from "../../src/core/eval/dream-metrics.js";

export interface DreamEvalOptions {
  /** Canonical DB to sandbox-copy for corpus stats (never opened in place). */
  dbPath: string;
  /** Dir holding labels.jsonl + sample.jsonl from the re-derivation pipeline. */
  rederivDir: string;
  /** Label filename inside rederivDir (labels.jsonl | labels-pilot.jsonl | labels-smoke.jsonl). */
  labelsName: string;
  /** labels.json written by fact-judge-label.ts ({ summary, items }). */
  factJudgeLabelsPath: string;
  /** Dir holding hook-log.jsonl and citation-log.jsonl. */
  logsDir: string;
  outDir: string;
  windowDays: number;
}

export interface DbStats {
  readonly facts: number;
  readonly activeFacts: number;
  readonly sessions: number;
}

export interface DreamEvalMetrics {
  readonly reDerivation: ReDerivationRate | null;
  readonly correction: CorrectionMetrics | null;
  readonly merge: MergePrecision | null;
  readonly injection: InjectionCost | null;
}

export interface DreamEvalReport {
  readonly generatedAt: string;
  readonly inputs: Omit<DreamEvalOptions, "outDir"> & { readonly outDir: string };
  readonly db: DbStats | null;
  readonly warnings: ReadonlyArray<string>;
  readonly metrics: DreamEvalMetrics;
}

export interface DreamEvalResult {
  readonly report: DreamEvalReport;
  readonly jsonPath: string;
  readonly mdPath: string;
}

function parseArgs(argv: string[]): DreamEvalOptions {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  return {
    dbPath: get("db") ?? join(homedir(), ".nlm", "canonical.sqlite"),
    rederivDir: get("rederiv-dir") ?? join(process.cwd(), "reports", "re-derivation"),
    labelsName: get("labels-name") ?? "labels.jsonl",
    factJudgeLabelsPath:
      get("fact-judge-labels") ?? join(process.cwd(), "reports", "replay-eval", "labels.json"),
    logsDir: get("logs-dir") ?? join(homedir(), ".nlm"),
    outDir: get("out-dir") ?? join(process.cwd(), "reports", "dream-eval"),
    windowDays: Number.parseFloat(get("window-days") ?? "7"),
  };
}

/** Copy the DB (+ WAL/SHM if present) into a throwaway sandbox dir. */
function sandboxCopy(srcDb: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nlm-dream-eval-"));
  const dst = join(dir, "canonical.sqlite");
  copyFileSync(srcDb, dst);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, dst + suffix);
  }
  return { path: dst, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readJsonl(path: string): ReadonlyArray<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function statsFromSandbox(sandboxPath: string): DbStats {
  const db = new Database(sandboxPath);
  try {
    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      facts: count("SELECT COUNT(*) AS n FROM facts"),
      activeFacts: count(
        "SELECT COUNT(*) AS n FROM facts WHERE superseded_by IS NULL AND retired_at IS NULL",
      ),
      sessions: count("SELECT COUNT(*) AS n FROM sessions"),
    };
  } finally {
    db.close();
  }
}

/**
 * labels.jsonl rows joined with sample.jsonl's earlier-side startedAt
 * (SampleSide.startedAt copied verbatim, per the dream-metrics row contract).
 * A label whose pairId has no sample row gets an empty startedAt and is
 * excluded from windowing by the scorer, never guessed.
 */
function loadReDerivationRows(
  labelsPath: string,
  samplePath: string,
): ReadonlyArray<ReDerivationLabelRow> {
  const startedByPair = new Map<string, string>();
  for (const s of readJsonl(samplePath)) {
    const a = s["a"] as { startedAt?: string } | undefined;
    if (typeof s["pairId"] === "string" && typeof a?.startedAt === "string") {
      startedByPair.set(s["pairId"], a.startedAt);
    }
  }
  return readJsonl(labelsPath).map((r): ReDerivationLabelRow => {
    const v = r["verdict"] as ReDerivationLabelRow["verdict"];
    return {
      pairId: typeof r["pairId"] === "string" ? r["pairId"] : "",
      stratum: typeof r["stratum"] === "string" ? r["stratum"] : "",
      verdict: v ?? null,
      startedAt: startedByPair.get(typeof r["pairId"] === "string" ? r["pairId"] : "") ?? "",
    };
  });
}

function loadJudgeItems(labelsJsonPath: string): ReadonlyArray<FactJudgeLabelItem> {
  const doc = JSON.parse(readFileSync(labelsJsonPath, "utf8")) as { items?: FactJudgeLabelItem[] };
  if (!Array.isArray(doc.items)) throw new Error(`${labelsJsonPath} has no items[] array`);
  return doc.items;
}

/** SKIP_NEW arm of the judge decisions — the merge pairs for mergePrecision. */
function mergePairsFrom(items: ReadonlyArray<FactJudgeLabelItem>): MergePairInput[] {
  return items
    .filter((it) => it.action === "SKIP_NEW")
    .map((it) => ({
      newId: it.newId,
      // decision renders as "SKIP_NEW <targetId>" (see fact-judge-label.ts).
      targetId: it.decision.startsWith("SKIP_NEW ") ? it.decision.slice("SKIP_NEW ".length).trim() || null : null,
      verdict: it.labeler?.verdict ?? null,
    }));
}

type MergePairInput = { newId: string; targetId: string | null; verdict: "correct" | "incorrect" | null };

function loadHookFires(path: string): ReadonlyArray<HookFireRow> {
  return readJsonl(path)
    .filter((r) => typeof r["conversationId"] === "string")
    .map(
      (r): HookFireRow => ({
        conversationId: r["conversationId"] as string,
        estTokens: typeof r["estTokens"] === "number" ? r["estTokens"] : -1,
        hits: Array.isArray(r["hits"]) ? (r["hits"] as HookFireRow["hits"]) : [],
      }),
    );
}

/** Stored citation rows are snake_case (citation-log.ts write path). */
function loadCitations(path: string): ReadonlyArray<CitationRow> {
  return readJsonl(path)
    .map((r): CitationRow | null => {
      const conv = (r["conversation_id"] ?? r["conversationId"]) as string | undefined;
      const cited = (r["cited_id"] ?? r["citedId"]) as string | undefined;
      return typeof conv === "string" && typeof cited === "string"
        ? { conversationId: conv, citedId: cited }
        : null;
    })
    .filter((r): r is CitationRow => r !== null);
}

export function runDreamEval(opts: DreamEvalOptions): DreamEvalResult {
  const warnings: string[] = [];

  // Arm 1 — re-derivation rate over time windows.
  let reDerivation: ReDerivationRate | null = null;
  const labelsPath = join(opts.rederivDir, opts.labelsName);
  const samplePath = join(opts.rederivDir, "sample.jsonl");
  if (existsSync(labelsPath) && existsSync(samplePath)) {
    reDerivation = reDerivationRateByWindow(
      loadReDerivationRows(labelsPath, samplePath),
      opts.windowDays * 24 * 60 * 60 * 1000,
    );
  } else {
    warnings.push(`reDerivation skipped: needs ${labelsPath} and ${samplePath}`);
  }

  // Arms 2+3 — correction precision/recall and merge precision from one file.
  let correction: CorrectionMetrics | null = null;
  let merge: MergePrecision | null = null;
  if (existsSync(opts.factJudgeLabelsPath)) {
    const items = loadJudgeItems(opts.factJudgeLabelsPath);
    correction = correctionMetrics(items);
    merge = mergePrecision(mergePairsFrom(items));
  } else {
    warnings.push(`correction/merge skipped: ${opts.factJudgeLabelsPath} not found`);
  }

  // Arm 4 — injection tokens per useful (cited) hit.
  let injection: InjectionCost | null = null;
  const hookLogPath = join(opts.logsDir, "hook-log.jsonl");
  const citationLogPath = join(opts.logsDir, "citation-log.jsonl");
  if (existsSync(hookLogPath) && existsSync(citationLogPath)) {
    injection = injectionCostPerUsefulHit(loadHookFires(hookLogPath), loadCitations(citationLogPath));
  } else {
    warnings.push(`injection skipped: needs ${hookLogPath} and ${citationLogPath}`);
  }

  // Corpus stats — sandbox copy only; the live daemon DB is never opened.
  let db: DbStats | null = null;
  if (existsSync(opts.dbPath)) {
    const sb = sandboxCopy(opts.dbPath);
    try {
      db = statsFromSandbox(sb.path);
    } finally {
      sb.cleanup();
    }
  } else {
    warnings.push(`db stats skipped: ${opts.dbPath} not found`);
  }

  const report: DreamEvalReport = {
    generatedAt: new Date().toISOString(),
    inputs: { ...opts },
    db,
    warnings,
    metrics: { reDerivation, correction, merge, injection },
  };

  mkdirSync(opts.outDir, { recursive: true });
  const jsonPath = join(opts.outDir, "report.json");
  const mdPath = join(opts.outDir, "report.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(report));
  return { report, jsonPath, mdPath };
}

const rate = (r: number | null): string => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);
const num = (n: number | null): string => (n === null ? "—" : String(Math.round(n * 100) / 100));

function renderMarkdown(report: DreamEvalReport): string {
  const m = report.metrics;
  const lines: string[] = [
    "# Dream-pass eval report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "All verdicts come from the pre-existing blind-labelling artifacts; scoring is",
    "pure deterministic arithmetic (src/core/eval/dream-metrics.ts). No model",
    "grades anything in this run.",
    "",
    "## Inputs",
    "",
    `- DB: \`${report.inputs.dbPath}\` (scored through a sandbox copy)`,
    `- Re-derivation labels: \`${join(report.inputs.rederivDir, report.inputs.labelsName)}\` (window ${report.inputs.windowDays}d)`,
    `- Fact-judge labels: \`${report.inputs.factJudgeLabelsPath}\``,
    `- Logs: \`${report.inputs.logsDir}\``,
    "",
    "## Corpus (from sandbox copy)",
    "",
    report.db
      ? [
          "| Metric | Value |",
          "| --- | ---: |",
          `| Facts (total) | ${report.db.facts} |`,
          `| Facts (active) | ${report.db.activeFacts} |`,
          `| Sessions | ${report.db.sessions} |`,
        ].join("\n")
      : "— (not read)",
  ];
  lines.push(
    "",
    "## Re-derivation rate over time",
    "",
    m.reDerivation
      ? [
          `- Overall GENUINE rate: **${rate(m.reDerivation.overallRate)}** (${m.reDerivation.totalPositives}/${m.reDerivation.totalJudged} judged, ${m.reDerivation.excluded} excluded)`,
          `- Windows: ${m.reDerivation.windows.length}`,
          "",
          "| Window (UTC, inclusive start) | Judged | Positives | Rate |",
          "| --- | ---: | ---: | ---: |",
          ...m.reDerivation.windows.map(
            (w) => `| ${w.start} | ${w.judged} | ${w.positives} | ${rate(w.rate)} |`,
          ),
        ].join("\n")
      : "— (not computed)",
    "",
    "## Correction precision / recall (fact judge vs blind labeler)",
    "",
    m.correction
      ? [
          `- Precision (mutating decisions judged correct): **${rate(m.correction.precision)}** (${m.correction.mutatingCorrect}/${m.correction.mutatingJudged})`,
          `- Recall (gold mutating rows the judge mutated): **${rate(m.correction.recall)}** (${m.correction.truePositives}/${m.correction.goldMutating})`,
          `- Exclusions: verdictUnparsed ${m.correction.verdictUnparsed}, independentUnparsed ${m.correction.independentUnparsed}`,
        ].join("\n")
      : "— (not computed)",
    "",
    "## Merge precision (SKIP_NEW arm)",
    "",
    m.merge
      ? `- Merge precision: **${rate(m.merge.precision)}** (${m.merge.correct}/${m.merge.merges}, ${m.merge.excluded} unjudged excluded)`
      : "— (not computed)",
    "",
    "## Injection cost per useful hit",
    "",
    m.injection
      ? [
          `- Tokens per cited hit: **${num(m.injection.tokensPerUsefulHit)}** (${m.injection.injectedTokens} tokens across ${m.injection.fires} fires, ${m.injection.usefulHits} useful hits)`,
        ].join("\n")
      : "— (not computed)",
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map((w) => `- ${w}`) : ["- none"]),
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.dbPath)) {
    console.error(`dream-eval: corpus not found at ${opts.dbPath}`);
    process.exit(2);
  }
  const { report, jsonPath, mdPath } = runDreamEval(opts);
  for (const w of report.warnings) console.error(`dream-eval: warning: ${w}`);
  const m = report.metrics;
  console.error(
    `dream-eval: reDerivation ${rate(m.reDerivation?.overallRate ?? null)} | correction P ${rate(
      m.correction?.precision ?? null,
    )} R ${rate(m.correction?.recall ?? null)} | merge ${rate(m.merge?.precision ?? null)} | tokens/useful-hit ${num(
      m.injection?.tokensPerUsefulHit ?? null,
    )}`,
  );
  console.error(`dream-eval: wrote ${mdPath}\ndream-eval: wrote ${jsonPath}`);
  if (!m.reDerivation && !m.correction && !m.merge && !m.injection) {
    console.error("dream-eval: no arms could be scored — check the input paths");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
