/**
 * Blind labelling of fact-judge decisions (T734 / E3). See docs/fact-judge.md.
 *
 *   NLM_LABELER_BASE_URL=... NLM_LABELER_MODEL=... [NLM_LABELER_API_KEY=...] \
 *   tsx scripts/eval/fact-judge-label.ts <replayDir> [--n=100] [--seed=734] [--out=labels.json] [--recheck-model=<id>]
 *
 * Samples decisions from <replayDir>/judge-log.jsonl, stratified: every
 * mutating decision up to half the sample, the rest KEEP_BOTH split between the
 * conflict and other arms. The labeler is a different model family than the
 * judge and sees only the facts, never the decision, the arm, or which model
 * produced it. Per item it gives (1) an independent resolution and (2) a
 * correct/incorrect verdict on a proposed resolution shown without provenance.
 * False-supersession rate = share of sampled SKIP_NEW / SUPERSEDE_OLD decisions
 * the labeler marks incorrect. --recheck-model re-labels a seeded 10% with a
 * second model.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chatOnce, type ChatOptions } from "./lib/chat-client.js";
import { JUDGE_SYSTEM_PROMPT, parseJudgeReply, buildJudgePrompt, type JudgeAction } from "../../src/core/facts/write-judge.js";
import type { Fact } from "../../src/shared/types.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

interface LogRow {
  newId: string;
  action: JudgeAction;
  targetId: string | null;
  candidateIds: string[];
  applied: boolean;
}
interface FactRow {
  id: string;
  kind: Fact["kind"];
  subject: string;
  predicate: string;
  value: string;
  source_session_id: string;
  created_at: string;
}

const rank = (seed: string, id: string): string => createHash("sha1").update(`${seed}:${id}`).digest("hex");

const VERDICT_SYSTEM = `You audit decisions in a memory store of (subject, predicate, value) facts. A NEW fact arrived next to EXISTING facts. A PROPOSED resolution is given. Decide whether it is correct.

Resolutions: KEEP_BOTH (both can be true, or they are different things), SKIP_NEW (the new fact restates an existing one), SUPERSEDE_OLD (the new fact is a newer value of the same single-valued attribute, so one existing fact is out of date; the old one is kept but marked outdated).

Reply with one JSON object only: {"verdict":"correct"|"incorrect","reason":"<one short sentence>"}`;

function parseVerdict(raw: string): "correct" | "incorrect" | null {
  const m = raw.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = (JSON.parse(m[0]) as { verdict?: unknown }).verdict;
    return v === "correct" || v === "incorrect" ? v : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!dir) throw new Error("usage: fact-judge-label.ts <replayDir> [--n=100]");
  const baseUrl = process.env["NLM_LABELER_BASE_URL"];
  const model = process.env["NLM_LABELER_MODEL"];
  if (!baseUrl || !model) throw new Error("set NLM_LABELER_BASE_URL and NLM_LABELER_MODEL");
  const opts = (m: string): ChatOptions => ({
    baseUrl,
    model: m,
    ...(process.env["NLM_LABELER_API_KEY"] ? { apiKey: process.env["NLM_LABELER_API_KEY"] } : {}),
    temperature: 0,
    maxTokens: 8192,
    timeoutMs: 240_000,
  });

  const n = Number(flag("n") ?? 100);
  const seed = flag("seed") ?? "734";
  const log = readFileSync(join(dir, "judge-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogRow);
  const set = JSON.parse(readFileSync(join(dir, "replay-set.json"), "utf8")) as { conflictIds: string[] };
  const conflict = new Set(set.conflictIds);
  const withCands = log.filter((r) => r.candidateIds.length > 0);
  const byRank = (rs: LogRow[]): LogRow[] => [...rs].sort((a, b) => rank(seed, a.newId).localeCompare(rank(seed, b.newId)));
  const mutating = byRank(withCands.filter((r) => r.action !== "KEEP_BOTH")).slice(0, n / 2);
  const keepConf = byRank(withCands.filter((r) => r.action === "KEEP_BOTH" && conflict.has(r.newId)));
  const keepOther = byRank(withCands.filter((r) => r.action === "KEEP_BOTH" && !conflict.has(r.newId)));
  const rest = n - mutating.length;
  const sample = [...mutating, ...keepConf.slice(0, Math.ceil(rest / 2)), ...keepOther.slice(0, Math.floor(rest / 2))].slice(0, n);

  const db = new Database(join(dir, "canonical.sqlite"), { readonly: true });
  const get = db.prepare<[string], FactRow>("SELECT id, kind, subject, predicate, value, source_session_id, created_at FROM facts WHERE id = ?");
  const toFact = (r: FactRow): Fact => ({ ...r, sourceSessionId: r.source_session_id, sourceQuote: null, createdAt: r.created_at, supersededBy: null, confidence: 1 });

  const recheckModel = flag("recheck-model");
  const recheckIds = new Set(
    recheckModel ? sample.map((r) => r.newId).sort((a, b) => rank(seed + "r", a).localeCompare(rank(seed + "r", b))).slice(0, Math.max(1, Math.round(sample.length / 10))) : [],
  );

  const items: Array<Record<string, unknown>> = [];
  for (const [i, row] of sample.entries()) {
    const fresh = toFact(get.get(row.newId)!);
    const cands = row.candidateIds.map((id) => get.get(id)).filter((r): r is FactRow => r !== undefined).map(toFact);
    const facts = buildJudgePrompt(fresh, cands);
    const labelOf = (id: string | null): string => (id === null ? "none" : `e${row.candidateIds.indexOf(id) + 1}`);
    const proposed = row.action === "KEEP_BOTH" ? "KEEP_BOTH" : `${row.action} target ${labelOf(row.targetId)}`;
    const ask = async (m: string): Promise<{ independent: string; verdict: string | null; verdictRaw?: string | undefined }> => {
      const indep = parseJudgeReply(await chatOnce(opts(m), JUDGE_SYSTEM_PROMPT, facts), cands);
      const verdictRaw = await chatOnce(opts(m), VERDICT_SYSTEM, `${facts}\n\nPROPOSED: ${proposed}`);
      const verdict = parseVerdict(verdictRaw);
      return {
        verdictRaw: verdict === null ? verdictRaw.slice(0, 400) : undefined,
        independent: indep ? (indep.action === "KEEP_BOTH" ? "KEEP_BOTH" : `${indep.action} ${indep.targetId}`) : "unparsed",
        verdict,
      };
    };
    const primary = await ask(model);
    const second = recheckModel && recheckIds.has(row.newId) ? await ask(recheckModel) : null;
    items.push({
      newId: row.newId,
      arm: conflict.has(row.newId) ? "conflict" : "other",
      action: row.action,
      decision: row.action === "KEEP_BOTH" ? "KEEP_BOTH" : `${row.action} ${row.targetId}`,
      labeler: primary,
      ...(second ? { recheck: second } : {}),
    });
    if ((i + 1) % 10 === 0) console.error(`${i + 1}/${sample.length}`);
  }

  const mut = items.filter((x) => x["action"] !== "KEEP_BOTH");
  const bad = mut.filter((x) => (x["labeler"] as { verdict: string | null }).verdict === "incorrect");
  const unparsed = items.filter((x) => (x["labeler"] as { verdict: string | null }).verdict === null).length;
  const keep = items.filter((x) => x["action"] === "KEEP_BOTH");
  const keepMissed = keep.filter((x) => (x["labeler"] as { verdict: string | null }).verdict === "incorrect");
  const summary = {
    sampled: items.length,
    mutatingSampled: mut.length,
    falseSupersession: { incorrect: bad.length, of: mut.length, rate: mut.length ? bad.length / mut.length : null },
    keepBothMarkedIncorrect: { incorrect: keepMissed.length, of: keep.length },
    unparsedVerdicts: unparsed,
    independentAgreement: items.filter((x) => (x["labeler"] as { independent: string }).independent === x["decision"]).length,
    labeler: model,
  };
  writeFileSync(flag("out") ?? join(dir, "labels.json"), JSON.stringify({ summary, items }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
