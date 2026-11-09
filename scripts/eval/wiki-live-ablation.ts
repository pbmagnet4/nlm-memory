/**
 * T1612 live-corpus wiki ablation: wiki+search vs search-alone.
 *
 * Replaces the synthetic spike signal (12/12 vs 9/12 on a 12-question
 * fixture with keyword-overlap scoring) with a live measurement: 50
 * hand-built multi-hop questions against a SANDBOX COPY of the live NLM
 * corpus, both arms driven by the REAL RecallService keyword path.
 *
 * Arms (same corpus, same query, same K — only the ranking differs):
 *  - search-alone: RecallService.search (mode=keyword, no rewrite) top-K.
 *  - wiki+search:  RecallService.search (mode=keyword, depth candidates)
 *    re-ranked by the fixed 50/50 blend (see lib/wiki-live-scoring.ts):
 *    0.5 * normalized recall score + 0.5 * workstream-page token recall.
 *    Pages are built by the real builder (buildWorkstreamPage) over full
 *    workstream membership. Blend declared upfront — never tuned.
 *
 * Safety invariants (do not weaken):
 *  - The live DB is NEVER opened. Every read goes through a throwaway copy
 *    under the OS temp dir (same sandbox-copy pattern as fact-recall-eval.ts
 *    and dream-contradiction-dryrun.ts, WAL/SHM included), removed afterwards.
 *  - Keyword mode with rewrite unset makes zero LLM calls: fully
 *    deterministic, no model, no judge, no in-flight caps needed.
 *  - No daemon restarts, no config/env changes. The string "apply" does not
 *    appear as an operation anywhere in this file.
 *  - Borges guard: total wiki bytes must be < 0.5x source session bytes or
 *    the eval FAILS. Source bytes include bodies (read-only aggregate over
 *    the sandbox copy), matching the spike's body-inclusive semantics.
 *
 * Question bar: every question joins evidence from TWO live sessions (each
 * contributes >= 1 distinctive query token — asserted at runtime, so a
 * stale/edited corpus fails loudly instead of scoring silently). Labeled ids
 * were verified against the live corpus at build time; existence is
 * re-asserted on every run.
 *
 * Run: npx tsx scripts/eval/wiki-live-ablation.ts [--db=<path>]
 *        [--out-dir=reports] [--limit=10] [--depth=30]
 *
 * Writes <out-dir>/wiki-live-ablation.md + .json (live-corpus content —
 * do NOT commit these; commit only this script, the scoring lib, and tests).
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { RecallService } from "@core/recall/recall-service.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { SqliteStorage } from "@core/storage/sqlite-storage.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { Session } from "@shared/types.js";
import {
  BORGES_LIMIT,
  buildWorkstreamPage,
  checkBorgesGuard,
  workstreamSourceBytes,
} from "@core/wiki/workstream-pages.js";
import {
  blendedRerank,
  recallAtK,
  tokenize,
  tokenRecall,
} from "./lib/wiki-live-scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

interface LiveQuestion {
  readonly id: string;
  /** Keyword-style query; terms drawn from BOTH labeled sessions. */
  readonly query: string;
  /** Exactly the two sessions whose join the question needs. */
  readonly relevant: readonly [string, string];
}

const QUESTIONS: LiveQuestion[] = [
  { id: "q01", query: "Prova rename postgres dump restore settlement kill switch stripe", relevant: ["cc_3814fed4-7d39-464d-8f7f-5a3cd80b864c", "cc_sub_a0d04ca55d189813f"] },
  { id: "q02", query: "six-layer judge harness quarantine PoLL multi-model panel self-preference", relevant: ["cc_93274009-5024-46db-848e-88ffd96f2380", "cc_sub_a44e1eadabaa7336c"] },
  { id: "q03", query: "x402 Stripe phases AP2 ERC-8004 pluggable settlement adapters", relevant: ["cc_a0aa2b08-1f8e-4983-862f-ddbe80c0d082", "cc_sub_a302c79dfd3da95ca"] },
  { id: "q04", query: "evaluate_and_settle fail-closed JudgeVerdict reject settlement_enabled flag Settings", relevant: ["cc_sub_af43300e473f806a5", "cc_sub_a0d04ca55d189813f"] },
  { id: "q05", query: "Pexels ArticleImage hero articles index footer attribution", relevant: ["cc_7b7eab6c-913b-491f-9bd9-8928d049f93a", "cc_sub_a4058bc785195c8ea"] },
  { id: "q06", query: "articles resources 301 redirects canonical therapists locations duplicate", relevant: ["cc_sub_a1efcb97a0a9df6fd", "cc_a7b5bda3-df7b-48ef-a662-ed440a9d2648"] },
  { id: "q07", query: "stripe_customers RLS migration cold outreach dedicated infrastructure Resend deliverability", relevant: ["cc_fbac94d9-90aa-45b6-a231-b56eea9405ea", "cc_a89849c2-e6f0-4d94-9239-90a41ceb6005"] },
  { id: "q08", query: "gsc-mcp inline scripts burnout Reddit signals 28-day clicks", relevant: ["cc_04557fc9-c65b-434f-97e7-c9ec6f8bca3e", "ha_20260430_ecbf5c"] },
  { id: "q09", query: "underwater drone venture NocoDB Idea Bank Validated REST curl", relevant: ["cc_35b5b230-c712-4986-b906-9496699ea654", "cc_sub_a4f47d9128e2de304"] },
  { id: "q10", query: "MissionGraph Waypoint relative coordinates GPS denied DepthRange post_init", relevant: ["cc_sub_ac8b44a54bc4788d3", "cc_sub_aaf97c1e52fcbc1dd"] },
  { id: "q11", query: "pyproject setuptools explicit include package venv gitignore build-backend", relevant: ["cc_sub_a07dcec4e5b91880d", "cc_sub_a3a98974d1398b3f8"] },
  { id: "q12", query: "bridge-mcp-server scp brace expansion tar OpenWebUI Docker update Metal", relevant: ["cc_sub_acompact-6f43385cc96fb4ed", "cc_sub_acompact-5e645edab30d7cd8"] },
  { id: "q13", query: "3000 invoice check Go High Level Next.js CRM pricing Friends Family discount", relevant: ["cc_29b697dd", "cc_76bab668"] },
  { id: "q14", query: "Airtable dispatch-first intake Twilio Resend Trade Referral Urgent duplicate", relevant: ["cc_a43fc790-9ff2-4eb1-83ff-b88d09ddeb91", "cc_8084df04-28cb-4195-9f3b-ce8c0b336057"] },
  { id: "q15", query: "city pages no-index Cleburne Terrell 301 redirects fire-restoration mold-remediation robots", relevant: ["cc_6eccd661-9bdc-4775-b4e2-db2db32ba288", "cc_80ca8a34-e6a9-45ef-894f-b5d39ba1c4c8"] },
  { id: "q16", query: "near-black warm gold email templates Lexical editor Payload CMS", relevant: ["cc_sub_a4cf20e5e2417d366", "cc_3d3cabd4-0dd5-4a0c-b9ff-eb93c065e52c"] },
  { id: "q17", query: "Nonlinear OS brand ventures Article JSON-LD BreadcrumbList blog", relevant: ["cc_c246266c-2631-4429-9a8e-b88335ea76af", "hm_cron_090050"] },
  { id: "q18", query: "Listmonk authenticated subscriber API Telegram bot token chat nonlinearos cron", relevant: ["hm_cron_090013", "ha_90d3f239048c"] },
  { id: "q19", query: "cron jobs wiped recreated blog pipeline newsletter Telegram token chat", relevant: ["ha_7adc3e161bd2", "ha_bf23cab7abb1"] },
  { id: "q20", query: "Astro Tailwind version pin devDependencies sitemap pnpm patch routes", relevant: ["cc_sub_a1ffed7a4dbd6af6c", "cc_sub_a0de5eb0d81a1f2a7"] },
  { id: "q21", query: "Vitest Vite compatibility banned-adjective word-count Levenshtein FAQ schema", relevant: ["cc_sub_a392417d8d067f92f", "cc_sub_ab219cbd395e2e44b"] },
  { id: "q22", query: "BaseLayout Inter HeroImage llms AVIF WebP fallback", relevant: ["cc_sub_a14aa4192d8e08468", "cc_sub_a1c7ef194cd41a020"] },
  { id: "q23", query: "clickable TOC two-pass PDF auth signup aria-describedby", relevant: ["cc_sub_a6e298ce74e1d3fbb", "cc_sub_ae516340f113a6a40"] },
  { id: "q24", query: "NOCODB_API_KEY log_model_run training Spec STATUS Outline deferred", relevant: ["cc_sub_a3fa38c1edea35633", "cc_sub_a30550984dc6c9385"] },
  { id: "q25", query: "NSImage MenuBarExtra jitter Docker restart POST action conflict", relevant: ["cc_25b144a7-e50b-4dd3-b24a-3aedb9565878", "cc_beaf5c33-c86d-4e11-b041-bf5393c58d8f"] },
  { id: "q26", query: "DeepSeek sync profiles Sync Models button KV cache VRAM toggle", relevant: ["cc_e84b3083-c684-4745-9e6b-e52adf4cce0e", "cc_8afd4422-d7c6-4481-9467-3186dea38b9e"] },
  { id: "q27", query: "LaunchAgent GUI session reinstall SwiftPM NxtBarCore approved brief", relevant: ["cc_c8051c15-bca5-4b29-ae5f-bd604f7f5b20", "cc_sub_a538f6153801af5b1"] },
  { id: "q28", query: "GA4 conversion events GTM dataLayer ga4-admin-mcp key events", relevant: ["cc_8df8f0b2", "cc_1d2b977e"] },
  { id: "q29", query: "two-tier lead routing Qualified Match Featured Plus legal bucket eminent domain", relevant: ["cc_216558fe", "cc_637983ba-b822-4394-98f9-eb2c492d713c"] },
  { id: "q30", query: "per-property wiki ui-review Squarespace quick-fix Klement phobia", relevant: ["cc_e7ca4522", "cc_c0de999a"] },
  { id: "q31", query: "Postiz LinkedIn OAuth compiled cold campaign NocoDB", relevant: ["cc_96e1b587-a71a-44d4-833d-25dc4f76c911", "cc_f75f752a-5a18-48b8-a41b-1e802be8cb71"] },
  { id: "q32", query: "Camofox discovery DeepSeek drafting consolidated Switch Set routing modes", relevant: ["cc_6b3c5343-a7b6-4d15-a49a-30c0b03149b8", "cc_sub_a7242094524588d6b"] },
  { id: "q33", query: "engagement-weighted score humanize typing cap Telegram Gmail scoring window", relevant: ["cc_sub_a11110b61e655996c", "cc_sub_ac107dfa5adff39a9"] },
  { id: "q34", query: "Postgres NocoDB Qdrant 3-layer memory policy drafting Camofox parameter discovery", relevant: ["cc_sub_ad439893fbd56f298", "cc_sub_a18d6bd12d99681a5"] },
  { id: "q35", query: "Sonnet consensus Haiku primitive Config Set centralized", relevant: ["cc_7314d0d6", "cc_sub_a0ed7333db4570173"] },
  { id: "q36", query: "Healthie HIPAA LMS createClient createNote interest enrollment CTA", relevant: ["cc_f17477c6-4c8b-41a5-ae33-265a6e8e13b3", "cc_5f5e509f-9836-422e-b92f-e2a33bc9b4f9"] },
  { id: "q37", query: "Astro hybrid static deprecated sitemap Partytown vercel adapter SSR API", relevant: ["cc_sub_a28e4819fd4d5f53b", "cc_sub_a03a565ae121b7947"] },
  { id: "q38", query: "BaseLayout GTM Partytown MobileNav stub skip-link duplication", relevant: ["cc_sub_a81088f84c483a095", "cc_sub_af52aa01402bbf0af"] },
  { id: "q39", query: "Toast beer metadata Southside Cellar pilot approval zod env validation", relevant: ["cc_0799d257", "ha_20260604_6fb0b8"] },
  { id: "q40", query: "jsdom smoke React rendering package scripts self-evaluation gates", relevant: ["ha_20260604_eb22ed", "ha_20260604_d9e76f"] },
  { id: "q41", query: "DBClient generic CRUD entities NocoDB adapter constants table IDs", relevant: ["ha_20260604_34137d", "ha_20260604_4ab327"] },
  { id: "q42", query: "Zod domain types inferred mocked fetch integration seed fixtures", relevant: ["ha_20260604_afe220", "ha_20260604_e75797"] },
  { id: "q43", query: "Gmail compose re-authentication agreement v4 local markdown template", relevant: ["cc_1c935ad4", "cc_df69aefd"] },
  { id: "q44", query: "Shopify visual editor React Flow diagnostic CRO GA4 GSC journey", relevant: ["cc_sub_a2af4c450908534f4", "cc_e8a7fe9b-95c8-4859-a250-c6ded10b799b"] },
  { id: "q45", query: "Curriculum Auditor pitch Gardening discarded monetization framework proposals", relevant: ["cc_sub_a02263e5d514cd5ed", "cc_0d2709c6-d0bb-4d6b-9f30-31474cb264e4"] },
  { id: "q46", query: "NocoDB bootstrap subagents overwriting utf-8 Unicode helper scripts", relevant: ["ha_20260613_85279647", "ha_20260613_2a4ba2"] },
  { id: "q47", query: "multi-ngram corpus density FinBERT placeholder signal", relevant: ["cc_05c36191-f998-4dc9-bc26-ad378d181976", "cc_sub_a3da565ac1211e098"] },
  { id: "q48", query: "QLoRA domain adaptation autoresearch OptiQ proxy duplicate weights", relevant: ["cc_3d425ebe-d8eb-4304-b94f-1848f76d4036", "cc_7323e734-ace5-42cc-a1a8-21854f26c731"] },
  { id: "q49", query: "sysctl memory guard overnight OOM NxtOps credential scan aborted", relevant: ["cc_f0debe6b-d9c8-4298-ac84-134cfd6468df", "cc_sub_a2cf81c0ba985c7e5"] },
  { id: "q50", query: "Hermes profile adapter dual-entry orchestration paper trading edge evaluation", relevant: ["cc_a18b0ec1-0ee8-4197-8afd-58a45221abcb", "hm_20260424_419ab3"] },
];

function sessionDoc(s: Session): Set<string> {
  return tokenize([s.label, s.summary, ...s.decisions, ...s.open, ...s.entities].join("\n"));
}

/** Keyword mode never touches the LLM: every method throws. */
function unreachableLlm(): LLMClient {
  const boom = (): never => {
    throw new Error("wiki-live-ablation: keyword arm must not call the LLM");
  };
  return { embed: boom, classify: boom, nameWorkstream: boom, rewriteForRecall: boom };
}

/**
 * Read-only aggregate of body chars over workstream-bound sessions in the
 * sandbox copy (never the live DB). Chunked to stay under SQLite's variable
 * cap. Tenant is fixed to the local team, matching every other read here.
 */
function sumBodyChars(sandboxDb: string, ids: ReadonlyArray<string>): number {
  if (ids.length === 0) return 0;
  const db = new Database(sandboxDb, { readonly: true });
  try {
    let total = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM sessions WHERE tenant_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
        )
        .get(DEFAULT_TEAM_ID, ...chunk) as { n: number };
      total += row.n;
    }
    return total;
  } finally {
    db.close();
  }
}

/** Copy the corpus (+ WAL/SHM if present) into a throwaway sandbox dir. */
function sandboxCopy(srcDb: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nlm-wiki-live-"));
  const dst = join(dir, "canonical.sqlite");
  copyFileSync(srcDb, dst);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, dst + suffix);
  }
  return { path: dst, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface CliArgs {
  dbPath: string;
  outDir: string;
  limit: number;
  depth: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const limit = Number.parseInt(get("limit") ?? "10", 10);
  const depth = Number.parseInt(get("depth") ?? "30", 10);
  return {
    dbPath: get("db") ?? join(homedir(), ".nlm", "canonical.sqlite"),
    outDir: get("out-dir") ?? join(process.cwd(), "reports"),
    limit: Number.isInteger(limit) && limit > 0 ? limit : 10,
    depth: Number.isInteger(depth) && depth > 0 ? depth : 30,
  };
}

export interface WikiLiveAblationReport {
  readonly questions: number;
  readonly limit: number;
  readonly depth: number;
  readonly blend: string;
  readonly searchAloneMeanRecall: number;
  readonly wikiSearchMeanRecall: number;
  readonly searchAloneFullHits: number;
  readonly wikiSearchFullHits: number;
  readonly deltaPp: number;
  readonly perQuestion: ReadonlyArray<{
    readonly id: string;
    readonly searchAloneRecall: number;
    readonly wikiSearchRecall: number;
  }>;
  readonly wikiBytes: number;
  readonly sourceBytes: number;
  readonly sizeRatio: number;
  readonly borgesLimit: number;
  readonly borgesPass: boolean;
  readonly verdict: "wiki-wins" | "no-difference" | "wiki-loses";
}

function pct(x: number): number {
  return Math.round(x * 1000) / 10;
}

export async function runWikiLiveAblation(args: CliArgs): Promise<WikiLiveAblationReport> {
  if (!existsSync(args.dbPath)) throw new Error(`corpus not found at ${args.dbPath}`);
  if (QUESTIONS.length < 50) throw new Error(`need >= 50 questions, have ${QUESTIONS.length}`);

  const sb = sandboxCopy(args.dbPath);
  try {
    const storage = SqliteStorage.create({ dbPath: sb.path, migrationsDir: MIGRATIONS_DIR });
    try {
      const recall = new RecallService({ store: storage.sessions, llm: unreachableLlm() });

      // 1. Verify every labeled id exists and earns its label: each of the
      //    two sessions must share >= 1 query token (else the join is fake).
      const labeledIds = [...new Set(QUESTIONS.flatMap((q) => q.relevant))];
      const labeled = await storage.sessions.getByIds(DEFAULT_TEAM_ID, labeledIds);
      const byId = new Map(labeled.map((s) => [s.id, s]));
      for (const q of QUESTIONS) {
        const qt = tokenize(q.query);
        for (const id of q.relevant) {
          const s = byId.get(id);
          if (!s) throw new Error(`${q.id}: labeled session missing from corpus: ${id}`);
          const overlap = [...qt].filter((t) => sessionDoc(s).has(t));
          if (overlap.length === 0) {
            throw new Error(`${q.id}: labeled session ${id} shares no query token — join unverified`);
          }
        }
      }

      // 2. Build wiki pages over real workstream membership.
      const workstreams = await storage.workstreams.listAll(DEFAULT_TEAM_ID);
      const pageTokens = new Map<string, Set<string>>();
      let wikiBytes = 0;
      let sourceBytes = 0;
      let pagesBuilt = 0;
      const allMemberIds: string[] = [];
      for (const w of workstreams) {
        const memberIds = await storage.sessions.listSessionIdsByWorkstreams(DEFAULT_TEAM_ID, [w.id]);
        if (memberIds.length === 0) continue;
        const sessions = await storage.sessions.getByIds(DEFAULT_TEAM_ID, memberIds);
        const facts = await storage.facts.listBySessions(DEFAULT_TEAM_ID, memberIds);
        sourceBytes += workstreamSourceBytes(sessions);
        allMemberIds.push(...memberIds);
        const page = buildWorkstreamPage({ workstream: w, sessions, facts });
        if (!page) continue;
        pagesBuilt += 1;
        wikiBytes += page.content.length;
        pageTokens.set(w.id, tokenize(page.content));
      }
      // Bodies are nulled by getByIds, but they are the bulk of source
      // session bytes (and the spike denominator included them). Add them
      // via a read-only aggregate over the SAME sandbox copy — no live
      // reads, no writes, no src changes. LENGTH() counts characters vs
      // JS .length code units; the gap is negligible against a 0.5 guard.
      sourceBytes += sumBodyChars(sb.path, allMemberIds);
      const guard = checkBorgesGuard(wikiBytes, sourceBytes, BORGES_LIMIT);

      // 3. Session -> workstream membership for the wiki term, resolved per
      //    question over the full rerank pool (mapping only labeled ids
      //    would zero the wiki term for every other candidate and rig the
      //    re-rank). Unbound / pageless sessions score a 0 wiki term.

      // 4. Score both arms per question on the REAL recall path.
      let recallSumAlone = 0;
      let recallSumWiki = 0;
      let fullAlone = 0;
      let fullWiki = 0;
      const perQuestion: Array<{ readonly id: string; readonly searchAloneRecall: number; readonly wikiSearchRecall: number }> = [];
      for (const q of QUESTIONS) {
        const qt = tokenize(q.query);
        const alone = await recall.search(DEFAULT_TEAM_ID, { query: q.query, mode: "keyword", limit: args.limit });
        const aloneIds = alone.results.map((h) => h.id);
        const deep = await recall.search(DEFAULT_TEAM_ID, { query: q.query, mode: "keyword", limit: args.depth });
        const wsOf = await storage.sessions.getWorkstreamIds(
          DEFAULT_TEAM_ID,
          deep.results.map((h) => h.id),
        );
        const reranked = blendedRerank(
          deep.results.map((h, i) => ({
            id: h.id,
            score: h.matchScore,
            wikiRecall: tokenRecall(qt, pageTokens.get(wsOf.get(h.id) ?? "") ?? new Set<string>()),
            rank: i,
          })),
        ).slice(0, args.limit);
        const rAlone = recallAtK(q.relevant, aloneIds);
        const rWiki = recallAtK(q.relevant, reranked);
        recallSumAlone += rAlone;
        recallSumWiki += rWiki;
        if (rAlone === 1) fullAlone += 1;
        if (rWiki === 1) fullWiki += 1;
        perQuestion.push({ id: q.id, searchAloneRecall: rAlone, wikiSearchRecall: rWiki });
      }

      const n = QUESTIONS.length;
      const searchAloneMeanRecall = recallSumAlone / n;
      const wikiSearchMeanRecall = recallSumWiki / n;
      return {
        questions: n,
        limit: args.limit,
        depth: args.depth,
        blend: "fixed 50/50 (recall-norm + wiki-page-recall)",
        searchAloneMeanRecall,
        wikiSearchMeanRecall,
        searchAloneFullHits: fullAlone,
        wikiSearchFullHits: fullWiki,
        deltaPp: pct(wikiSearchMeanRecall - searchAloneMeanRecall),
        perQuestion,
        wikiBytes,
        sourceBytes,
        sizeRatio: guard.ratio,
        borgesLimit: BORGES_LIMIT,
        borgesPass: guard.pass,
        verdict:
          wikiSearchMeanRecall > searchAloneMeanRecall
            ? "wiki-wins"
            : wikiSearchMeanRecall < searchAloneMeanRecall
              ? "wiki-loses"
              : "no-difference",
      };
    } finally {
      await storage.close();
    }
  } finally {
    sb.cleanup();
  }
}

function renderMarkdown(r: WikiLiveAblationReport): string {
  const lines = [
    "# T1612 wiki live ablation report",
    "",
    "Live-corpus measurement — DO NOT COMMIT (live corpus content).",
    "",
    "Method: 50 hand-built 2-session multi-hop questions against a sandbox",
    "copy of the live corpus. Both arms run the REAL RecallService keyword",
    `path (mode=keyword, no rewrite — deterministic, zero LLM calls). K=${r.limit},`,
    `rerank depth=${r.depth}. Wiki arm re-ranks by a single blend declared`,
    `upfront (${r.blend}), pages from the real buildWorkstreamPage builder.`,
    "",
    "| arm | mean recall@K | full hits (both sessions) |",
    "|---|---|---|",
    `| search-alone | ${pct(r.searchAloneMeanRecall)}% | ${r.searchAloneFullHits}/${r.questions} |`,
    `| wiki+search | ${pct(r.wikiSearchMeanRecall)}% | ${r.wikiSearchFullHits}/${r.questions} |`,
    "",
    `Delta: ${r.deltaPp >= 0 ? "+" : ""}${r.deltaPp}pp (verdict: ${r.verdict}).`,
    "",
    `Borges guard: wiki bytes / source session bytes = ${r.sizeRatio.toFixed(3)}`,
    `(limit ${r.borgesLimit}, ${r.borgesPass ? "PASS" : "FAIL"}). Denominator`,
    "includes bodies via a read-only aggregate over the sandbox copy,",
    "matching the spike's body-inclusive semantics.",
    "",
    "## Per-question recall",
    "",
    "| q | search-alone | wiki+search |",
    "|---|---|---|",
    ...r.perQuestion.map((p) => `| ${p.id} | ${p.searchAloneRecall.toFixed(2)} | ${p.wikiSearchRecall.toFixed(2)} |`),
    "",
  ];
  return lines.join("\n");
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runWikiLiveAblation(args).then(
    (report) => {
      writeFileSync(join(args.outDir, "wiki-live-ablation.json"), JSON.stringify(report, null, 2));
      writeFileSync(join(args.outDir, "wiki-live-ablation.md"), renderMarkdown(report));
      console.log(
        [
          `questions=${report.questions} K=${report.limit} depth=${report.depth}`,
          `search-alone mean-recall=${pct(report.searchAloneMeanRecall)}% full=${report.searchAloneFullHits}/${report.questions}`,
          `wiki+search mean-recall=${pct(report.wikiSearchMeanRecall)}% full=${report.wikiSearchFullHits}/${report.questions}`,
          `delta=${report.deltaPp >= 0 ? "+" : ""}${report.deltaPp}pp verdict=${report.verdict}`,
          `size-ratio=${report.sizeRatio.toFixed(3)} (limit ${report.borgesLimit}, ${report.borgesPass ? "PASS" : "FAIL"})`,
        ].join("\n"),
      );
      if (!report.borgesPass) process.exitCode = 1;
    },
    (err) => {
      console.error(`wiki-live-ablation: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
