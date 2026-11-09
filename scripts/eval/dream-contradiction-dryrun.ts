/**
 * Contradiction-pass precision-gate labeling package (T1609) — DRY-RUN ONLY.
 *
 * Samples active facts from a SANDBOX COPY of the live NLM corpus, judges
 * each one through the landed contradiction pass (src/core/dream/
 * contradiction-pass.ts) with `apply` unset (report-only), and writes a
 * human-reviewable candidate list for the labeling step.
 *
 * Safety invariants (do not weaken):
 *  - The live DB at ~/.nlm is NEVER opened. Every read goes through a
 *    throwaway copy under the OS temp dir (same sandbox-copy pattern as
 *    scripts/eval/dream-eval.ts and fact-recall-eval.ts, WAL/SHM included).
 *  - The string "apply" appears in this file only in comments and in the
 *    report's `apply: false` field. `runContradictionPass` is never given
 *    `apply: true`, and the `retire` dependency is a stub that throws, so
 *    even a future edit that flipped the flag could not retire a fact.
 *  - No hostnames, IPs, or URLs live here (public-repo rule). The judge
 *    endpoint comes from NLM_DREAM_JUDGE_BASE_URL (empty default = hard
 *    error); the model from NLM_DREAM_MODEL or the pass default.
 *  - Judge in-flight is capped at 2 (oMLX concurrency is shared with the
 *    live daemon's classify lane).
 *
 * Sampling is seeded (mulberry32 over id-ordered active facts) so a re-run
 * with the same --sample/--seed reproduces the same fact set. If the first
 * run yields fewer than MIN_CONTRADICTED (10) contradicted candidates, the
 * sample is raised to 150 with a second fixed seed and the report notes the
 * escalation; the package lists the final run's findings.
 *
 * Run:
 *   NLM_DREAM_JUDGE_BASE_URL=<judge-base-url> \
 *     npx tsx scripts/eval/dream-contradiction-dryrun.ts [--sample=50] [--seed=1]
 *     [--db=~/.nlm/canonical.sqlite] [--out-dir=reports]
 *
 * Writes <out-dir>/dream-contradiction-dryrun.md + .json (live-corpus
 * content — do NOT commit these; commit only this script).
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "@core/storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import {
  runContradictionPass,
  type ContradictionFinding,
  type ContradictionPassReport,
  type DreamFact,
} from "../../src/core/dream/contradiction-pass.js";
import { dreamModelFromEnv } from "../../src/core/dream/judge.js";
import { ClassifierBox } from "../../src/llm/classifier-box.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const DEFAULT_SAMPLE = 50;
const ESCALATED_SAMPLE = 150;
const MIN_CONTRADICTED = 10;
const MAX_IN_FLIGHT = 2;

interface CliArgs {
  sample: number;
  seed: number;
  dbPath: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const sample = Number.parseInt(get("sample") ?? String(DEFAULT_SAMPLE), 10);
  const seed = Number.parseInt(get("seed") ?? "1", 10);
  return {
    sample: Number.isInteger(sample) && sample > 0 ? sample : DEFAULT_SAMPLE,
    seed: Number.isInteger(seed) && seed > 0 ? seed : 1,
    dbPath: get("db") ?? join(homedir(), ".nlm", "canonical.sqlite"),
    outDir: get("out-dir") ?? join(process.cwd(), "reports"),
  };
}

/** Copy the corpus (+ WAL/SHM if present) into a throwaway sandbox dir. */
function sandboxCopy(srcDb: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nlm-dream-contradiction-"));
  const dst = join(dir, "canonical.sqlite");
  copyFileSync(srcDb, dst);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, dst + suffix);
  }
  return { path: dst, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic PRNG (mulberry32) — fixed seed => reproducible sample. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeededSample {
  facts: ReadonlyArray<DreamFact>;
  poolSize: number;
}

/** Id-ordered active facts, seeded shuffle, first N. Reproducible per seed. */
function seededSample(
  storage: SqliteStorage,
  tenantId: string,
  limit: number,
  seed: number,
): SeededSample {
  const db = storage.sessions.rawDb();
  const tc = tenantClause(tenantId);
  const rows = db
    .prepare<[string], {
      id: string; subject: string; predicate: string; value: string;
      source_session_id: string; source_quote: string | null; created_at: string;
    }>(
      `SELECT id, subject, predicate, value, source_session_id, source_quote, created_at FROM facts
       WHERE superseded_by IS NULL AND retired_at IS NULL AND ${tc.sql}
       ORDER BY id ASC`,
    )
    .all(tc.param);
  const rand = mulberry32(seed);
  const idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const picked = idx.slice(0, limit).map((i) => rows[i]!);
  return {
    poolSize: rows.length,
    facts: picked.map((r) => ({
      id: r.id,
      subject: r.subject,
      predicate: r.predicate,
      value: r.value,
      sourceSessionId: r.source_session_id,
      sourceQuote: r.source_quote,
      createdAt: r.created_at,
    })),
  };
}

function renderMarkdown(opts: {
  generatedAt: string;
  model: string;
  judgeRoute: string;
  sampleSize: number;
  seed: number;
  escalated: boolean;
  firstRunContradicted: number | null;
  firstRunSampleSize: number | null;
  poolSize: number;
  report: ContradictionPassReport;
}): string {
  const { report } = opts;
  const lines: string[] = [
    "# Dream contradiction dry-run — labeling package (T1609)",
    "",
    `Generated: ${opts.generatedAt}`,
    "",
    "DRY-RUN ONLY. Nothing was written: the pass ran with `apply` unset on a",
    "sandbox copy of the corpus (the live DB was never opened), and the",
    "fact-store `retire` dependency is a stub that throws.",
    "",
    "## Run config",
    "",
    `- Judge route: ${opts.judgeRoute}`,
    `- Judge model: \`${opts.model}\``,
    `- Sample: ${opts.sampleSize} active facts (seed ${opts.seed}, reproducible)`,
    `- Active-fact pool: ${opts.poolSize}`,
    `- Judge in-flight cap: ${MAX_IN_FLIGHT} (observed peak ${report.peakInFlight})`,
    ...(opts.escalated
      ? [
          `- Escalation: the first run (sample ${opts.firstRunSampleSize}) yielded only ${opts.firstRunContradicted} contradicted candidates (< ${MIN_CONTRADICTED}), so the sample was raised to ${ESCALATED_SAMPLE} per the package spec. This package lists the ${ESCALATED_SAMPLE}-sample run.`,
        ]
      : []),
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Sampled | ${report.sampled} |`,
    `| Judged (verdict reached) | ${report.judged} |`,
    `| Contradicted (labeling candidates) | ${report.contradicted} |`,
    `| Still-true | ${report.stillTrue} |`,
    `| Unverifiable | ${report.unverifiable} |`,
    `| No transcript | ${report.noTranscript} |`,
    `| Errors (judge failures / downgraded contradictions) | ${report.errors} |`,
    `| Superseded (writes — must be 0) | ${report.superseded} |`,
    "",
    "## Candidates for human labeling",
    "",
    "Each row: the fact as judged, the model verdict, the verbatim evidence",
    "quote, and the source session to open for labeling. `contradicted` rows",
    "are the labeling candidates; the remaining rows are included so the",
    "labeler can spot-check the judge's still-true / unverifiable calls.",
    "",
  ];
  const ordered = [...report.findings].sort((a, b) => {
    const rank = (f: ContradictionFinding): number =>
      f.outcome === "contradicted" ? 0 : f.outcome === "still-true" ? 1 : f.outcome === "unverifiable" ? 2 : 3;
    return rank(a) - rank(b) || (a.factId < b.factId ? -1 : 1);
  });
  for (const f of ordered) {
    lines.push(
      `### ${f.factId} — ${f.outcome}`,
      "",
      `- Fact: \`${f.subject} ${f.predicate}: ${f.value}\``,
      `- Verdict: ${f.verdict ?? "—"}${f.model ? ` (model \`${f.model}\`)` : ""}`,
      `- Evidence: ${f.evidenceQuote ? `"${f.evidenceQuote}"` : "(none)"}`,
      `- Source session: \`${f.sourceSessionId}\``,
      ...(f.error ? [`- Note: ${f.error}`] : []),
      "",
    );
  }
  return lines.join("\n");
}

async function runOnce(opts: {
  storage: SqliteStorage;
  llm: ClassifierBox;
  model: string | undefined;
  tenantId: string;
  sampleSize: number;
  seed: number;
}): Promise<{ report: ContradictionPassReport; poolSize: number }> {
  const { facts, poolSize } = seededSample(opts.storage, opts.tenantId, opts.sampleSize, opts.seed);
  const report = await runContradictionPass({
    tenantId: opts.tenantId,
    // apply is deliberately omitted: dry-run is the pass default.
    facts: {
      retire: async () => {
        throw new Error("dry-run: retire is disabled in the labeling package");
      },
    },
    transcripts: opts.storage.sessions,
    llm: opts.llm,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    sampleSize: opts.sampleSize,
    maxInFlight: MAX_IN_FLIGHT,
    sampleFacts: async () => facts,
  });
  if (report.superseded !== 0 || report.apply !== false) {
    throw new Error(
      `dry-run invariant violated: apply=${report.apply} superseded=${report.superseded}`,
    );
  }
  if (report.peakInFlight > MAX_IN_FLIGHT) {
    throw new Error(`in-flight cap violated: peak ${report.peakInFlight} > ${MAX_IN_FLIGHT}`);
  }
  return { report, poolSize };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    console.error(`dream-contradiction-dryrun: corpus not found at ${args.dbPath}`);
    process.exit(2);
  }
  const baseUrl = (process.env["NLM_DREAM_JUDGE_BASE_URL"] ?? "").trim();
  if (!baseUrl) {
    console.error("dream-contradiction-dryrun: NLM_DREAM_JUDGE_BASE_URL is not set (no default — set it explicitly)");
    process.exit(2);
  }
  const model = (process.env["NLM_DREAM_MODEL"] ?? "").trim() || dreamModelFromEnv(process.env);
  const tenantId = DEFAULT_TEAM_ID;

  const sb = sandboxCopy(args.dbPath);
  let storage: SqliteStorage | undefined;
  try {
    storage = SqliteStorage.create({ dbPath: sb.path, migrationsDir: MIGRATIONS_DIR });
    const llm = new ClassifierBox({ provider: "openai", model, baseUrl });
    const seed2 = args.seed + 1000;
    let { report, poolSize } = await runOnce({ storage, llm, model, tenantId, sampleSize: args.sample, seed: args.seed });
    console.error(
      `dream-contradiction-dryrun: sample=${report.sampled} judged=${report.judged} ` +
        `contradicted=${report.contradicted} still-true=${report.stillTrue} ` +
        `unverifiable=${report.unverifiable} no-transcript=${report.noTranscript} ` +
        `errors=${report.errors} peakInFlight=${report.peakInFlight}`,
    );
    let escalated = false;
    let firstRunContradicted: number | null = null;
    if (report.contradicted < MIN_CONTRADICTED && args.sample < ESCALATED_SAMPLE) {
      firstRunContradicted = report.contradicted;
      escalated = true;
      console.error(
        `dream-contradiction-dryrun: only ${report.contradicted} contradicted (< ${MIN_CONTRADICTED}); escalating to ${ESCALATED_SAMPLE}`,
      );
      ({ report, poolSize } = await runOnce({ storage, llm, model, tenantId, sampleSize: ESCALATED_SAMPLE, seed: seed2 }));
      console.error(
        `dream-contradiction-dryrun: escalated sample=${report.sampled} judged=${report.judged} ` +
          `contradicted=${report.contradicted} still-true=${report.stillTrue} ` +
          `unverifiable=${report.unverifiable} no-transcript=${report.noTranscript} errors=${report.errors}`,
      );
    }

    const generatedAt = new Date().toISOString();
    const finalSample = escalated ? ESCALATED_SAMPLE : args.sample;
    const finalSeed = escalated ? seed2 : args.seed;
    const doc = {
      generatedAt,
      mode: "dry-run",
      apply: report.apply,
      judgeRoute: "env NLM_DREAM_JUDGE_BASE_URL (endpoint value not recorded)",
      model,
      sampleSize: finalSample,
      seed: finalSeed,
      escalated,
      firstRunContradicted,
      poolSize,
      summary: {
        sampled: report.sampled,
        judged: report.judged,
        contradicted: report.contradicted,
        stillTrue: report.stillTrue,
        unverifiable: report.unverifiable,
        noTranscript: report.noTranscript,
        errors: report.errors,
        superseded: report.superseded,
        peakInFlight: report.peakInFlight,
      },
      findings: report.findings,
    };
    mkdirSync(args.outDir, { recursive: true });
    const jsonPath = join(args.outDir, "dream-contradiction-dryrun.json");
    const mdPath = join(args.outDir, "dream-contradiction-dryrun.md");
    writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");
    writeFileSync(
      mdPath,
      renderMarkdown({
        generatedAt,
        model,
        judgeRoute: "explicit NLM_DREAM_JUDGE_BASE_URL (value not recorded in the package)",
        sampleSize: finalSample,
        seed: finalSeed,
        escalated,
        firstRunContradicted,
        firstRunSampleSize: escalated ? args.sample : null,
        poolSize,
        report,
      }),
    );
    console.error(`dream-contradiction-dryrun: wrote ${mdPath}\ndream-contradiction-dryrun: wrote ${jsonPath}`);
  } finally {
    await storage?.close();
    sb.cleanup();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
