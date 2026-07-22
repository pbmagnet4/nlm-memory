/**
 * build-classifier-gold — scripted, durable gold-set builder for the
 * classifier extraction-quality eval (#403). Replaces the manual /tmp/nlm-309
 * rebuild procedure described in docs/eval-classifier.md, which depended on a
 * gold set that lived only in /tmp and vanished on reboot.
 *
 * Selection: ~N sessions (default 30), weighted toward ids seen in
 * ~/.nlm/citation-log.jsonl, with the remainder filled by a seeded
 * stratified sample over runtime x body-length bucket. Deterministic given
 * the same DB snapshot + --seed (default 20260722) — no Math.random anywhere
 * in the selection path. Selection math lives in lib/gold-selection.ts so it
 * can be fixture-tested without touching a real database.
 *
 * Production safety: NEVER reads the live canonical.sqlite in place. Always
 * makes a throwaway read-only copy (+ WAL/SHM, so uncommitted rows are still
 * visible) under a tmp dir first and reads from that copy only — mirrors
 * fact-recall-eval.ts's sandboxCopy. Never writes to ~/.nlm/canonical.sqlite
 * and never restarts the daemon; it is live.
 *
 * Output (durable — NOT /tmp):
 *   $out/gold-bodies.json       [{ id, runtime, cited, body }], bodies capped
 *                                at GOLD_BODY_CAP chars.
 *   $out/references-TODO.json   handoff scaffold for the strong-model
 *                                authorship step. This script does NOT author
 *                                reference.json itself — a human or
 *                                orchestrator fills in each entry's
 *                                decisions/open/entities separately, then
 *                                saves the result as reference.json in the
 *                                same directory. See "Handoff to reference
 *                                authorship" in docs/eval-classifier.md.
 *
 * Run: npx tsx scripts/eval/build-classifier-gold.ts [--n=30] [--seed=20260722]
 *        [--db=<path>] [--out=<dir>]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { parseCitationLog, selectGoldSample, type GoldCandidate } from "./lib/gold-selection.js";

const GOLD_BODY_CAP = 20_000;

interface Args {
  readonly n: number;
  readonly seed: number;
  readonly dbPath: string;
  readonly outDir: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const n = Number.parseInt(get("n") ?? "30", 10);
  const seed = Number.parseInt(get("seed") ?? "20260722", 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--n must be a positive integer, got "${get("n")}"`);
  if (!Number.isFinite(seed)) throw new Error(`--seed must be an integer, got "${get("seed")}"`);
  return {
    n,
    seed,
    dbPath: get("db") ?? process.env["NLM_DB_PATH"] ?? join(homedir(), ".nlm", "canonical.sqlite"),
    outDir: get("out") ?? process.env["NLM_GOLD_DIR"] ?? join(homedir(), ".nlm", "eval-gold"),
  };
}

interface SessionRow {
  readonly id: string;
  readonly runtime: string;
  readonly started_at: string;
  readonly label: string;
  readonly body: string;
}

/** Copy the corpus (+ WAL/SHM if present) into a throwaway sandbox dir. Never opens the live file in place. */
function sandboxCopy(srcDb: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nlm-gold-build-"));
  const dst = join(dir, "canonical.sqlite");
  copyFileSync(srcDb, dst);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, dst + suffix);
  }
  return { path: dst, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readCitedIds(): ReadonlySet<string> {
  const path = process.env["NLM_CITATION_LOG"] ?? join(homedir(), ".nlm", "citation-log.jsonl");
  if (!existsSync(path)) return new Set();
  return parseCitationLog(readFileSync(path, "utf8"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    console.error(`build-classifier-gold: db not found at ${args.dbPath}`);
    process.exit(2);
  }

  const citedIds = readCitedIds();
  console.error(`build-classifier-gold: ${citedIds.size} distinct cited ids from citation log`);

  const sb = sandboxCopy(args.dbPath);
  let rows: SessionRow[];
  try {
    const db = new Database(sb.path, { readonly: true });
    rows = db
      .prepare(
        "SELECT id, runtime, started_at, label, body FROM sessions " +
          "WHERE status = 'closed' AND body IS NOT NULL AND length(body) > 0 ORDER BY id ASC",
      )
      .all() as SessionRow[];
    db.close();
  } finally {
    sb.cleanup();
  }
  console.error(`build-classifier-gold: ${rows.length} closed sessions with a body in the pool`);

  const pool: GoldCandidate[] = rows.map((r) => ({ id: r.id, runtime: r.runtime, bodyLength: r.body.length }));
  const result = selectGoldSample(pool, citedIds, args.n, args.seed);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const goldBodies = result.selectedIds.map((id) => {
    const r = byId.get(id)!;
    return {
      id: r.id,
      runtime: r.runtime,
      cited: citedIds.has(r.id),
      body: r.body.slice(0, GOLD_BODY_CAP),
    };
  });

  const referencesTodo = result.selectedIds.map((id) => {
    const r = byId.get(id)!;
    return {
      id: r.id,
      runtime: r.runtime,
      label: r.label,
      startedAt: r.started_at,
      bodyLength: r.body.length,
      decisions: [] as string[],
      open: [] as string[],
      entities: [] as string[],
      status: "todo",
    };
  });

  mkdirSync(args.outDir, { recursive: true });
  const goldPath = join(args.outDir, "gold-bodies.json");
  const todoPath = join(args.outDir, "references-TODO.json");
  writeFileSync(goldPath, JSON.stringify(goldBodies, null, 2));
  writeFileSync(todoPath, JSON.stringify(referencesTodo, null, 2));

  console.log(`build-classifier-gold: selected ${result.selectedIds.length} sessions`);
  console.log(`  citation-weighted: ${result.citationSelectedIds.length}`);
  console.log(`  stratified fill:   ${result.fillSelectedIds.length}`);
  console.log(`  fill strata: ${JSON.stringify(result.fillStrataCounts)}`);
  console.log(`build-classifier-gold: wrote ${goldPath}`);
  console.log(`build-classifier-gold: wrote ${todoPath}`);
  console.log(
    "\nNext step: author reference.json from references-TODO.json (see " +
      '"Handoff to reference authorship" in docs/eval-classifier.md). ' +
      "This script does not author references itself.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error("build-classifier-gold: fatal", err);
    process.exit(1);
  });
}
