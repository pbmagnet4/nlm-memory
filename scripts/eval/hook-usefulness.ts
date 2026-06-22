/**
 * Hook-usefulness eval — the keystone metric for recall QUALITY on the hot path.
 *
 * The blended hook precision (cited / surfaced, ~1%) badly undercounts real
 * usefulness: agents use injected context without ever calling cite_session. A
 * manual n=13 read (NocoDB #357) found ~27% weighted usefulness vs ~1% cited —
 * a 27x gap — AND ~46% genuinely off-topic injections. Tuning floors/rerankers
 * against the 1% citation signal optimizes a phantom. This harness makes the
 * real number reproducible so recall-mode changes can be judged honestly.
 *
 * Method (judge the artifact, never self-grade):
 *   1. Read the hook-log: live, gate=evaluate, fires that injected a session.
 *   2. Join conversationId -> the local Claude Code transcript; extract the
 *      ASSISTANT response that followed the matching user prompt (text blocks
 *      until the next user turn — not just the first tool-preamble).
 *   3. Load the injected session's summary+body from canonical.sqlite (RO).
 *   4. A local judge model decides: did the response USE information from the
 *      injected context that is not in the prompt and not generic?
 *      used / partial / unused.
 *   5. Report usefulness@sample = (used + 0.5*partial)/N, plus the off-topic
 *      (unused) rate, against the cited rate over the same sample.
 *
 * Run: npx tsx scripts/eval/hook-usefulness.ts [--limit=30] [--days=30]
 *        [--model=qwen3.5:4b] [--verbose] [--json=<out>]
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { classifyPrompt } from "../../src/core/hook/gate.js";
import { topicalWordCount } from "../../src/hook/recent-context.js";

type Band = "all" | "thin" | "specific";

interface Args {
  limit: number;
  days: number;
  model: string;
  ollamaUrl: string;
  verbose: boolean;
  json: string | null;
  band: Band;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  return {
    limit: Number.parseInt(get("limit") ?? "30", 10),
    days: Number.parseInt(get("days") ?? "30", 10),
    model: get("model") ?? "qwen3.5:4b",
    ollamaUrl: get("ollama") ?? process.env["OLLAMA_URL"] ?? "http://localhost:11434",
    verbose: argv.includes("--verbose"),
    json: get("json") ?? null,
    band: (get("band") ?? "all") as Band,
  };
}

interface Fire {
  conversationId: string;
  prompt: string;
  injectedId: string;
  ts: string;
}

function readFires(days: number, band: Band = "all"): Fire[] {
  const path = join(homedir(), ".nlm", "hook-log.jsonl");
  const cutoff = Date.now() - days * 86_400_000;
  const seen = new Set<string>();
  const out: Fire[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d["mode"] !== "live" || d["gate"] !== "evaluate") continue;
    const inj = (d["wouldInject"] as string[] | undefined) ?? [];
    if (inj.length === 0) continue;
    const ts = String(d["ts"] ?? "");
    if (Date.parse(ts) < cutoff) continue;
    const cid = String(d["conversationId"] ?? "");
    const prompt = String(d["promptPreview"] ?? "");
    // Measure usefulness on fires that would STILL fire under the current gate —
    // historical entries predate the content gate, so re-apply it here.
    if (classifyPrompt(prompt) !== "evaluate") continue;
    // Optional topical-word band: "thin" (<3, context-recall's target) vs
    // "specific" (>=3, never augmented) — to measure each band's recall separately.
    if (band !== "all") {
      const topical = topicalWordCount(prompt);
      if (band === "thin" && topical >= 3) continue;
      if (band === "specific" && topical < 3) continue;
    }
    const key = `${cid}:${prompt.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ conversationId: cid, prompt, injectedId: inj[0]!, ts });
  }
  return out;
}

function evenStride<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const stride = items.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.floor(i * stride)]!);
  return out;
}

function textOf(msg: unknown): string {
  if (typeof msg !== "object" || msg === null) return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** Assistant text that followed the user turn matching `prompt`. Pure + tested-shape. */
export function responseAfterPrompt(transcript: string, prompt: string): string | null {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  const needle = prompt.trim().slice(0, 25);
  if (!needle) return null;
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!["type"] === "user" && textOf(rows[i]!["message"]).trim().startsWith(needle)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  const parts: string[] = [];
  for (let i = idx + 1; i < rows.length; i++) {
    if (rows[i]!["type"] === "user") break;
    if (rows[i]!["type"] === "assistant") {
      const t = textOf(rows[i]!["message"]).trim();
      if (t) parts.push(t);
    }
  }
  const joined = parts.join(" ").trim();
  return joined ? joined.slice(0, 1500) : null;
}

function walkJsonl(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJsonl(p, out);
    else if (ent.name.endsWith(".jsonl")) out.push(p);
  }
}

let TRANSCRIPTS: string[] | null = null;
function locateTranscript(cid: string): string | null {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return null;
  if (TRANSCRIPTS === null) {
    TRANSCRIPTS = [];
    walkJsonl(base, TRANSCRIPTS);
  }
  return (
    TRANSCRIPTS.find((p) => p.endsWith(`${cid}.jsonl`)) ??
    TRANSCRIPTS.find((p) => p.includes(cid)) ??
    null
  );
}

type Verdict = "used" | "partial" | "unused";

async function judge(
  args: Args,
  prompt: string,
  context: string,
  response: string,
): Promise<{ verdict: Verdict; reason: string }> {
  const res = await fetch(`${args.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      stream: false,
      think: false,
      format: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["used", "partial", "unused"] },
          reason: { type: "string" },
        },
        required: ["verdict", "reason"],
      },
      options: { temperature: 0 },
      messages: [
        {
          role: "system",
          content:
            "You judge whether an assistant's RESPONSE used information from an INJECTED prior-session " +
            "context. Judge the response against the context only — never grade the assistant's quality. " +
            "verdict=used: the response clearly draws on specific information from the injected context " +
            "that is not already in the prompt and not generic. verdict=partial: the context is on-topic " +
            "and plausibly informed the response but no specific borrowed detail is visible. " +
            "verdict=unused: the injected context is off-topic or absent from the response. " +
            'Output JSON {"verdict":"...","reason":"..."}.',
        },
        {
          role: "user",
          content: `USER PROMPT:\n${prompt}\n\nINJECTED CONTEXT:\n${context}\n\nASSISTANT RESPONSE:\n${response}`,
        },
      ],
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const parsed = JSON.parse(data.message?.content ?? "{}") as { verdict?: Verdict; reason?: string };
  return { verdict: parsed.verdict ?? "unused", reason: parsed.reason ?? "" };
}

function citedSet(days: number): Set<string> {
  // (conversationId|citedId) pairs from the citation log, for the cited-rate baseline.
  const path = join(homedir(), ".nlm", "citation-log.jsonl");
  const cutoff = Date.now() - days * 86_400_000;
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (Date.parse(String(d["ts"] ?? "")) < cutoff) continue;
      const conv = String(d["conversationId"] ?? d["conversation_id"] ?? "");
      const cited = String(d["citedId"] ?? d["cited_id"] ?? "");
      if (conv && cited) out.add(`${conv}|${cited}`);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(join(homedir(), ".nlm", "canonical.sqlite"), { readonly: true });
  const summStmt = db.prepare<[string], { label: string; summary: string; body: string }>(
    "SELECT label, COALESCE(summary,'') AS summary, COALESCE(substr(body,1,600),'') AS body FROM sessions WHERE id = ?",
  );
  const cited = citedSet(args.days);

  const fires = evenStride(readFires(args.days, args.band), args.limit * 2);
  const counts = { used: 0, partial: 0, unused: 0 };
  let scored = 0;
  let citedHits = 0;

  for (const f of fires) {
    if (scored >= args.limit) break;
    const tpath = locateTranscript(f.conversationId);
    if (!tpath) continue;
    const response = responseAfterPrompt(readFileSync(tpath, "utf8"), f.prompt);
    if (!response) continue;
    const row = summStmt.get(f.injectedId);
    if (!row) continue;
    const context = `${row.label}\n${row.summary}\n${row.body}`.trim();

    const { verdict, reason } = await judge(args, f.prompt, context, response);
    counts[verdict] += 1;
    scored += 1;
    if (cited.has(`${f.conversationId}|${f.injectedId}`)) citedHits += 1;

    if (args.verbose) {
      console.error(
        `[${verdict.toUpperCase().padEnd(7)}] ${JSON.stringify(f.prompt.slice(0, 60))}\n` +
          `    inj: ${row.label}\n    why: ${reason}`,
      );
    }
  }
  db.close();

  const usefulness = scored > 0 ? (counts.used + 0.5 * counts.partial) / scored : 0;
  const citedRate = scored > 0 ? citedHits / scored : 0;
  const report = {
    sample: scored,
    used: counts.used,
    partial: counts.partial,
    unused: counts.unused,
    usefulnessAtSample: Number(usefulness.toFixed(3)),
    clearUseRate: Number((counts.used / Math.max(1, scored)).toFixed(3)),
    offTopicRate: Number((counts.unused / Math.max(1, scored)).toFixed(3)),
    citedRate: Number(citedRate.toFixed(3)),
    undercountFactor: citedRate > 0 ? Number((usefulness / citedRate).toFixed(1)) : null,
    model: args.model,
    days: args.days,
  };
  console.log("hook-usefulness — judged real usage vs citation");
  console.log(`  sample scored:   ${report.sample}`);
  console.log(`  used / partial / unused: ${counts.used} / ${counts.partial} / ${counts.unused}`);
  console.log(`  usefulness@sample: ${(usefulness * 100).toFixed(1)}%   (off-topic ${(report.offTopicRate * 100).toFixed(1)}%)`);
  console.log(`  cited rate (same sample): ${(citedRate * 100).toFixed(1)}%   undercount x${report.undercountFactor ?? "n/a"}`);
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
}

await main();
