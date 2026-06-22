/**
 * Reranker ablation: does the citation-frequency reranker actually rank cited
 * sessions higher than raw recall does?
 *
 * Method (no corpus replay needed — the hook-log already captured the real
 * production candidate sets with base scores):
 *   - A "gold positive" is a (conversation, session) pair the agent explicitly
 *     cited via tool_use. mcp_tool / unknown conversations are dropped — they
 *     can't be joined to a query fire.
 *   - For every hook fire whose conversation is gold and whose candidate hits
 *     contain a gold positive, we have an eval sample: the positive's rank in
 *     the raw-score order (base) vs. after the production reranker (applyBoosts).
 *   - Boosts are built LEAVE-ONE-CONVERSATION-OUT: when scoring conversation C,
 *     the citation boosts come from every OTHER conversation. This avoids the
 *     circularity of letting a session's own citation inflate its rank, and
 *     measures the real question: do PRIOR citations help FUTURE recall?
 *
 * Reuses the production reranker (src/core/recall/reranker.ts), not a copy, so
 * the number reflects what ships.
 *
 * Usage:
 *   npm run eval:reranker            # last 365d of logs
 *   npx tsx scripts/eval/reranker-ablation.ts --days 30
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCitationBoosts, applyBoosts } from "../../src/core/recall/reranker.js";
import type { CitationEntry } from "../../src/core/recall/citation-log.js";

export interface Fire {
  readonly conversationId: string;
  readonly hits: ReadonlyArray<{ id: string; score: number }>;
}

export interface GoldCitation {
  readonly conversationId: string;
  readonly citedId: string;
}

export interface RerankerEvalResult {
  samples: number;
  mrrBase: number;
  mrrReranked: number;
  recallAt1Base: number;
  recallAt1Reranked: number;
  recallAt3Base: number;
  recallAt3Reranked: number;
  recallAt5Base: number;
  recallAt5Reranked: number;
  improved: number;
  hurt: number;
  unchanged: number;
  goldPositives: number;
  reachablePositives: number;
  unreachablePositives: number;
}

function rankOf(ordered: ReadonlyArray<{ id: string }>, id: string): number {
  const idx = ordered.findIndex((r) => r.id === id);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx + 1;
}

export function evaluateReranker(
  fires: ReadonlyArray<Fire>,
  citations: ReadonlyArray<GoldCitation>,
): RerankerEvalResult {
  const goldByConv = new Map<string, Set<string>>();
  for (const c of citations) {
    if (!goldByConv.has(c.conversationId)) goldByConv.set(c.conversationId, new Set());
    goldByConv.get(c.conversationId)!.add(c.citedId);
  }

  // Reranker boost source — every gold citation, shaped as CitationEntry.
  const allEntries: Array<CitationEntry & { conversationId: string }> = citations.map((c) => ({
    conversationId: c.conversationId,
    citedId: c.citedId,
    kind: "tool_use",
  }));

  // Union of candidate ids surfaced per conversation (for reachability).
  const surfacedByConv = new Map<string, Set<string>>();
  for (const f of fires) {
    if (!surfacedByConv.has(f.conversationId)) surfacedByConv.set(f.conversationId, new Set());
    const s = surfacedByConv.get(f.conversationId)!;
    for (const h of f.hits) s.add(h.id);
  }

  let goldPositives = 0;
  let reachablePositives = 0;
  for (const [conv, ids] of goldByConv) {
    const surfaced = surfacedByConv.get(conv);
    for (const id of ids) {
      goldPositives += 1;
      if (surfaced?.has(id)) reachablePositives += 1;
    }
  }

  let samples = 0;
  let mrrBaseSum = 0;
  let mrrRerankedSum = 0;
  let r1b = 0, r1r = 0, r3b = 0, r3r = 0, r5b = 0, r5r = 0;
  let improved = 0, hurt = 0, unchanged = 0;

  for (const fire of fires) {
    const gold = goldByConv.get(fire.conversationId);
    if (!gold) continue;
    const hitIds = new Set(fire.hits.map((h) => h.id));
    const positivesHere = [...gold].filter((id) => hitIds.has(id));
    if (positivesHere.length === 0) continue;

    const base = [...fire.hits].sort((a, b) => b.score - a.score);
    const boosts = buildCitationBoosts(
      allEntries.filter((e) => e.conversationId !== fire.conversationId),
    );
    const reranked = applyBoosts(
      fire.hits.map((h) => ({ id: h.id, matchScore: h.score })),
      boosts,
    ).sort((a, b) => b.matchScore - a.matchScore);

    for (const pid of positivesHere) {
      const rb = rankOf(base, pid);
      const rr = rankOf(reranked, pid);
      samples += 1;
      mrrBaseSum += 1 / rb;
      mrrRerankedSum += 1 / rr;
      if (rb <= 1) r1b += 1;
      if (rr <= 1) r1r += 1;
      if (rb <= 3) r3b += 1;
      if (rr <= 3) r3r += 1;
      if (rb <= 5) r5b += 1;
      if (rr <= 5) r5r += 1;
      if (rr < rb) improved += 1;
      else if (rr > rb) hurt += 1;
      else unchanged += 1;
    }
  }

  const div = samples || 1;
  return {
    samples,
    mrrBase: mrrBaseSum / div,
    mrrReranked: mrrRerankedSum / div,
    recallAt1Base: r1b / div,
    recallAt1Reranked: r1r / div,
    recallAt3Base: r3b / div,
    recallAt3Reranked: r3r / div,
    recallAt5Base: r5b / div,
    recallAt5Reranked: r5r / div,
    improved,
    hurt,
    unchanged,
    goldPositives,
    reachablePositives,
    unreachablePositives: goldPositives - reachablePositives,
  };
}

// ── I/O glue (only runs when invoked directly) ────────────────────────────────

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const days = daysIdx !== -1 ? Number.parseInt(args[daysIdx + 1] ?? "365", 10) || 365 : 365;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const hookLogPath = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
  const citationLogPath = process.env["NLM_CITATION_LOG"] ?? join(homedir(), ".nlm", "citation-log.jsonl");

  const ORPHAN = new Set(["mcp_tool", "unknown", ""]);

  const citeRows = await readJsonl(citationLogPath);
  let orphanedCitations = 0;
  const citations: GoldCitation[] = [];
  for (const r of citeRows) {
    if (r["kind"] !== "tool_use") continue;
    const conv = typeof r["conversation_id"] === "string" ? r["conversation_id"] : "";
    const cited = typeof r["cited_id"] === "string" ? r["cited_id"] : "";
    if (!cited) continue;
    if (ORPHAN.has(conv)) {
      orphanedCitations += 1;
      continue;
    }
    citations.push({ conversationId: conv, citedId: cited });
  }

  const hookRows = await readJsonl(hookLogPath);
  const fires: Fire[] = [];
  for (const r of hookRows) {
    if (typeof r["kind"] === "string") continue; // stop-hook entry
    const ts = typeof r["ts"] === "string" ? Date.parse(r["ts"]) : 0;
    if (!ts || ts < cutoff) continue;
    const conv = typeof r["conversationId"] === "string" ? r["conversationId"] : "";
    if (ORPHAN.has(conv)) continue;
    const rawHits = Array.isArray(r["hits"]) ? r["hits"] : [];
    const hits = rawHits
      .map((h) => (h && typeof h === "object" ? (h as Record<string, unknown>) : null))
      .filter((h): h is Record<string, unknown> => h !== null && typeof h["id"] === "string")
      .map((h) => ({ id: h["id"] as string, score: typeof h["score"] === "number" ? h["score"] : 0 }));
    if (hits.length === 0) continue;
    fires.push({ conversationId: conv, hits });
  }

  const res = evaluateReranker(fires, citations);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const delta = (a: number, b: number) => {
    const d = b - a;
    return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;
  };

  console.log(`Reranker ablation — last ${days}d`);
  console.log(`  gold positives: ${res.goldPositives} (${res.reachablePositives} reachable, ${res.unreachablePositives} never surfaced)`);
  console.log(`  orphaned tool_use citations (mcp_tool/unknown, unusable): ${orphanedCitations}`);
  console.log(`  eval samples (fire × reachable positive): ${res.samples}`);
  console.log("");
  console.log(`            base      reranked   delta`);
  console.log(`  MRR       ${res.mrrBase.toFixed(3)}     ${res.mrrReranked.toFixed(3)}      ${(res.mrrReranked - res.mrrBase >= 0 ? "+" : "")}${(res.mrrReranked - res.mrrBase).toFixed(3)}`);
  console.log(`  R@1       ${pct(res.recallAt1Base).padEnd(9)} ${pct(res.recallAt1Reranked).padEnd(10)} ${delta(res.recallAt1Base, res.recallAt1Reranked)}`);
  console.log(`  R@3       ${pct(res.recallAt3Base).padEnd(9)} ${pct(res.recallAt3Reranked).padEnd(10)} ${delta(res.recallAt3Base, res.recallAt3Reranked)}`);
  console.log(`  R@5       ${pct(res.recallAt5Base).padEnd(9)} ${pct(res.recallAt5Reranked).padEnd(10)} ${delta(res.recallAt5Base, res.recallAt5Reranked)}`);
  console.log("");
  console.log(`  samples improved: ${res.improved} | hurt: ${res.hurt} | unchanged: ${res.unchanged}`);
}

// Skip the I/O entrypoint when imported under Vitest; run it otherwise.
if (!process.env["VITEST"]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
