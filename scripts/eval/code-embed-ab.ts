/**
 * Code-lane embedder eval over the production code-exemplar corpus.
 *
 * Gold: each session that produced live exemplars contributes one query — the
 * session's label (a short natural-language description of the work) — and
 * every exemplar from that session is relevant. Documents are embedded two ways:
 *   - production: composeEmbedText(task_context, code), exactly what the
 *     capture path stores (task_context and the label summarise the same
 *     session, so this arm has lexical overlap by construction);
 *   - code-only: the code alone, the harder pure code-retrieval case.
 * Retrieval is brute-force cosine over the whole corpus, scored R@1/R@5/R@10
 * (any relevant exemplar in the top k) and MRR.
 *
 * The embedder is the configured code lane: NLM_EMBED_BASE_URL +
 * NLM_CODE_EMBED_MODEL (+ NLM_EMBED_API_KEY), the same transport the daemon
 * builds. Override the env to score another model.
 *
 * Run: npx tsx scripts/eval/code-embed-ab.ts [--db=<path>] [--json=<out>] [--concurrency=8]
 */

import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoloadEnv } from "../../src/llm/env-autoload.js";
import { OpenAICodeEmbedderClient } from "../../src/llm/openai-code-embedder-client.js";
import { composeEmbedText } from "@core/exemplars/embed-text.js";

interface Row {
  id: string;
  session_id: string;
  label: string;
  task_context: string;
  code: string;
}

interface ArmMetrics {
  arm: string;
  queries: number;
  docs: number;
  r1: number;
  r5: number;
  r10: number;
  mrr: number;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function embedAll(
  texts: ReadonlyArray<string>,
  embed: (t: string) => Promise<Float32Array>,
  concurrency: number,
): Promise<Float32Array[]> {
  const out = new Array<Float32Array>(texts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < texts.length) {
        const i = next++;
        out[i] = await embed(texts[i]!);
      }
    }),
  );
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function score(
  arm: string,
  queries: ReadonlyArray<{ vec: Float32Array; relevant: ReadonlySet<number> }>,
  docs: ReadonlyArray<Float32Array>,
): ArmMetrics {
  let r1 = 0;
  let r5 = 0;
  let r10 = 0;
  let rr = 0;
  for (const q of queries) {
    const ranked = docs.map((d, i) => ({ i, s: dot(q.vec, d) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => q.relevant.has(r.i)) + 1;
    if (rank === 1) r1++;
    if (rank <= 5) r5++;
    if (rank <= 10) r10++;
    rr += 1 / rank;
  }
  const pct = (n: number): number => Math.round((n / queries.length) * 1000) / 10;
  return {
    arm,
    queries: queries.length,
    docs: docs.length,
    r1: pct(r1),
    r5: pct(r5),
    r10: pct(r10),
    mrr: Math.round((rr / queries.length) * 1000) / 1000,
  };
}

async function main(): Promise<void> {
  autoloadEnv();
  const baseUrl = process.env["NLM_EMBED_BASE_URL"];
  if (!baseUrl) throw new Error("NLM_EMBED_BASE_URL is required (OpenAI-compatible /v1 endpoint)");
  const model = process.env["NLM_CODE_EMBED_MODEL"];
  const client = new OpenAICodeEmbedderClient({
    baseUrl,
    ...(model ? { model } : {}),
    ...(process.env["NLM_EMBED_API_KEY"] ? { apiKey: process.env["NLM_EMBED_API_KEY"] } : {}),
  });
  const concurrency = Number.parseInt(arg("concurrency") ?? "8", 10);
  const dbPath = arg("db") ?? join(homedir(), ".nlm", "canonical.sqlite");

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare<[], Row>(
      "SELECT e.id, e.session_id, s.label, e.task_context, e.code FROM code_exemplars e " +
        "JOIN sessions s ON s.id = e.session_id " +
        "WHERE e.retired_at IS NULL AND s.label IS NOT NULL AND length(s.label) > 10 ORDER BY e.id",
    )
    .all();
  db.close();

  const bySession = new Map<string, { label: string; relevant: Set<number> }>();
  rows.forEach((r, i) => {
    const entry = bySession.get(r.session_id) ?? { label: r.label, relevant: new Set<number>() };
    entry.relevant.add(i);
    bySession.set(r.session_id, entry);
  });
  const sessions = [...bySession.values()];
  console.error(`code-embed-ab: model=${model ?? "(default)"} docs=${rows.length} queries=${sessions.length}`);

  const t0 = Date.now();
  const embedDoc = async (t: string): Promise<Float32Array> => (await client.embed(t, "document")).vector;
  const queryVecs = await embedAll(
    sessions.map((s) => s.label),
    async (t) => (await client.embed(t, "query")).vector,
    concurrency,
  );
  const prodDocs = await embedAll(rows.map((r) => composeEmbedText(r.task_context, r.code)), embedDoc, concurrency);
  const codeDocs = await embedAll(rows.map((r) => r.code), embedDoc, concurrency);
  const embedSeconds = Math.round((Date.now() - t0) / 1000);

  const queries = sessions.map((s, i) => ({ vec: queryVecs[i]!, relevant: s.relevant }));
  const metrics = [score("production", queries, prodDocs), score("code-only", queries, codeDocs)];
  for (const m of metrics) {
    console.error(
      `  ${m.arm.padEnd(10)} R@1 ${m.r1}%  R@5 ${m.r5}%  R@10 ${m.r10}%  MRR ${m.mrr}  (q=${m.queries}, docs=${m.docs})`,
    );
  }
  console.error(`code-embed-ab: embedded ${queries.length + 2 * rows.length} texts in ${embedSeconds}s`);

  const jsonOut = arg("json");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ model, dbPath, embedSeconds, metrics }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
