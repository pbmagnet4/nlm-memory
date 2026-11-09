/**
 * Contradiction-findings → NxtWiki proposals bridge (T1627) — RENDER ONLY.
 *
 * Reads a dream-contradiction dry-run findings JSON (see
 * scripts/eval/dream-contradiction-dryrun.ts) plus an explicit --allow list
 * of human-labeled-TP fact ids, and writes one proposal markdown draft per
 * allowed contradicted finding into the vault proposals queue.
 *
 * Safety invariants (do not weaken):
 *  - Deterministic, zero model calls. Every draft sentence is built from the
 *    JSON fields (fact, evidence quote, session id, judge model, run
 *    provenance) plus the CLI-supplied labeler string. No transcript text is
 *    ever invented beyond the JSON fields.
 *  - Findings with verdict != "contradicted" are never rendered.
 *  - Findings outside --allow are never rendered (FPs stay out by label,
 *    not by heuristic). Allow entries match exact ids or id prefixes.
 *  - Findings missing a grounding field (fact id, subject, predicate,
 *    value, source session, evidence quote) are skipped, never padded.
 *  - Precision-gate invariant: auto-apply stays OFF. This script only stages
 *    drafts for the human adoption flow; it never retires or supersedes a
 *    fact and never touches the corpus.
 *  - No hostnames, IPs, or URLs live here (public-repo rule). Run
 *    provenance records the model name, sample, seed, and date only.
 *
 * Run:
 *   npx tsx scripts/eval/dream-contradiction-proposals.ts
 *     --input=reports/dream-contradiction-dryrun.json
 *     --allow='["fact_25e09a4d", "fact_fea4f038", "fact_b80fda6f"]'
 *     --labeled-by="Edward Chalupa (2026-11-09)"
 *     [--out-dir=proposals]
 *
 * Writes <out-dir>/<queue>/<subject>--<shortid>.md, one per allowed
 * contradicted finding. The queue follows existing vault proposals routing
 * (Agents/ for agent-persona subjects, Operations/ otherwise).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProposalFinding {
  factId: string;
  subject: string;
  predicate: string;
  value: string;
  sourceSessionId: string;
  verdict: string;
  evidenceQuote: string;
  model?: string;
  reason?: string;
}

export interface FindingsDoc {
  findings: ProposalFinding[];
  generatedAt?: string;
  model?: string;
  sampleSize?: number;
  seed?: number;
}

export interface RunMeta {
  generatedAt: string;
  model: string;
  sampleSize: number | string;
  seed: number | string;
}

export interface CliArgs {
  input: string;
  allow: string[];
  labeledBy: string;
  outDir: string;
}

export function parseAllow(raw: string): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string" && e.length > 0);
  } catch {
    return [];
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  return {
    input: get("input") ?? join(process.cwd(), "reports", "dream-contradiction-dryrun.json"),
    allow: parseAllow(get("allow") ?? "[]"),
    labeledBy: get("labeled-by") ?? "",
    outDir: get("out-dir") ?? join(process.cwd(), "proposals"),
  };
}

/** Exact id or id-prefix match (short human labels match full fact ids). */
export function allowMatches(factId: string, allow: string[]): boolean {
  return allow.some((entry) => entry.length > 0 && factId.startsWith(entry));
}

const AGENT_SUFFIXES = [
  "-analyst",
  "-assistant",
  "-agent",
  "-coach",
  "-manager",
  "-strategist",
  "-reviewer",
  "-composer",
  "-director",
  "-engineer",
];

/** Vault proposals queue for a subject; Operations/ when unclear. */
export function queueFor(subject: string): string {
  const lower = subject.toLowerCase();
  if (/^(codex|hermes)(-|$)/.test(lower)) return "Runtimes";
  if (AGENT_SUFFIXES.some((s) => lower.endsWith(s))) return "Agents";
  if (/(-skill|-loop|-markup|-manage)$/.test(lower)) return "Skills";
  return "Operations";
}

function sanitizeSegment(text: string): string {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return clean || "finding";
}

function shortId(factId: string): string {
  const m = /^fact_([0-9a-f]{8})/i.exec(factId);
  if (m?.[1]) return m[1]!.toLowerCase();
  return factId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "unknown";
}

export function draftFilename(f: ProposalFinding): string {
  return `${sanitizeSegment(f.subject)}--${shortId(f.factId)}.md`;
}

function hasGrounding(f: ProposalFinding): boolean {
  return [f.factId, f.subject, f.predicate, f.value, f.sourceSessionId, f.evidenceQuote].every(
    (s) => typeof s === "string" && s.length > 0,
  );
}

/**
 * Render one proposal draft. Returns null when a grounding field is
 * missing — the caller skips such findings instead of padding them.
 */
export function renderDraft(f: ProposalFinding, meta: RunMeta, labeledBy: string): string | null {
  if (f.verdict !== "contradicted" || !hasGrounding(f)) return null;
  const factLine = `\`${f.subject} ${f.predicate}: ${f.value}\``;
  const lines = [
    `# Proposed: correct contradicted fact ${factLine}`,
    "",
    `Sources: ${f.sourceSessionId}`,
    "",
    `- Fact: ${factLine} (id \`${f.factId}\`)`,
    `- Conflict: "${f.evidenceQuote}" (session \`${f.sourceSessionId}\`)`,
    `- Judge: model \`${f.model || meta.model}\` — dry-run sample ${meta.sampleSize}, seed ${meta.seed}, generated ${meta.generatedAt}`,
    `- Human label: TP (labeled by ${labeledBy || "unknown"})`,
    "",
    "Guidance: adopt — if the quoted transcript evidence holds on re-read,",
    "supersede or retire the fact with the source session as provenance;",
    "drop — if the quote is stale, partial, or misread, close this draft with",
    "no corpus change.",
    "",
  ];
  return lines.join("\n");
}

/** Allowed contradicted findings with grounding, in stable fact-id order. */
export function selectFindings(doc: FindingsDoc, allow: string[]): ProposalFinding[] {
  return doc.findings
    .filter((f) => f.verdict === "contradicted")
    .filter((f) => allowMatches(f.factId, allow))
    .filter(hasGrounding)
    .sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
}

export function docMeta(doc: FindingsDoc): RunMeta {
  return {
    generatedAt: doc.generatedAt ?? "unknown",
    model: doc.model ?? "unknown",
    sampleSize: doc.sampleSize ?? "unknown",
    seed: doc.seed ?? "unknown",
  };
}

/** Write one draft per finding; returns the written file paths. */
export function writeDrafts(
  findings: ProposalFinding[],
  meta: RunMeta,
  opts: { outDir: string; labeledBy: string },
): string[] {
  const written: string[] = [];
  for (const f of findings) {
    const body = renderDraft(f, meta, opts.labeledBy);
    if (body === null) continue;
    const dir = join(resolve(opts.outDir), queueFor(f.subject));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, draftFilename(f));
    writeFileSync(path, body);
    written.push(path);
  }
  return written;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const doc = JSON.parse(readFileSync(args.input, "utf-8")) as FindingsDoc;
  if (!Array.isArray(doc.findings)) {
    console.error("dream-contradiction-proposals: no findings array in input");
    process.exit(2);
  }
  const meta = docMeta(doc);
  const selected = selectFindings(doc, args.allow);
  const written = writeDrafts(selected, meta, { outDir: args.outDir, labeledBy: args.labeledBy });
  for (const p of written) console.error(`dream-contradiction-proposals: wrote ${p}`);
  console.error(
    `dream-contradiction-proposals: findings=${doc.findings.length} selected=${selected.length} wrote=${written.length}`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("dream-contradiction-proposals.ts");
if (invokedDirectly) main();
