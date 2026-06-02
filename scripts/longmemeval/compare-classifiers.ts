/**
 * Compare multiple LongMemEval-S harness runs by classifier. Reads N
 * results.json files and emits a side-by-side markdown table. This is the
 * publishable artifact for the per-classifier R@5 disclosure.
 *
 * Usage:
 *   node dist/scripts/longmemeval/compare-classifiers.js \
 *     reports/longmemeval/2026-05-31-13-22-12-body-only/results.json \
 *     reports/longmemeval/2026-05-31-14-05-04-ollama-qwen3_4b-instruct-2507-q4_K_M/results.json \
 *     reports/longmemeval/2026-05-31-15-31-09-ollama-phi4-mini_3.8b-q4_K_M/results.json \
 *     reports/longmemeval/2026-05-31-17-12-22-deepseek-deepseek-v4-flash/results.json
 *
 * Prints a markdown comparison to stdout. Pipe to a file to capture.
 */

import { readFileSync } from "node:fs";

interface AggregateScore {
  readonly recallAtK: number;
  readonly sessionBodyHitRate: number;
  readonly n: number;
}

interface ClassifierMeta {
  readonly provider: string;
  readonly model: string;
  readonly cache_ok: number;
  readonly cache_total: number;
  readonly cache_failed: number;
  readonly cache_mean_elapsed_ms: number | null;
  readonly run_classify_attempts: number;
  readonly run_classify_failures: number;
}

interface ResultsFile {
  readonly dataset: string;
  readonly n: number;
  readonly k: number;
  readonly modes: ReadonlyArray<string>;
  readonly classifier: ClassifierMeta | null;
  readonly aggregate: Record<string, AggregateScore>;
  readonly by_question_type: Record<string, Record<string, AggregateScore>>;
  readonly elapsed_seconds: number;
}

function label(file: ResultsFile): string {
  return file.classifier ? `${file.classifier.provider}:${file.classifier.model}` : "body-only";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (paths.length < 2) {
    console.error("usage: compare-classifiers.js <results.json> <results.json> [...]");
    process.exit(1);
  }
  const files = paths.map((p) => ({ path: p, data: JSON.parse(readFileSync(p, "utf8")) as ResultsFile }));

  // Sanity: same k, same dataset
  const k = files[0]!.data.k;
  const modes = files[0]!.data.modes;
  for (const f of files) {
    if (f.data.k !== k) {
      console.error(`mismatched k: ${f.path} has k=${f.data.k}, expected ${k}`);
      process.exit(2);
    }
  }

  const lines: string[] = [];
  lines.push(`# LongMemEval-S — classifier-in-the-loop comparison`);
  lines.push("");
  lines.push(`k=${k}, n per column varies (shown in cells).`);
  lines.push("");
  lines.push(`## Run-level metadata`);
  lines.push("");
  lines.push(`| Classifier | n | Cache ok / fail | Mean classify time | Wall clock |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const f of files) {
    const c = f.data.classifier;
    const cacheCell = c ? `${c.cache_ok} / ${c.cache_failed}` : "n/a";
    const meanCell = c?.cache_mean_elapsed_ms != null ? `${(c.cache_mean_elapsed_ms / 1000).toFixed(1)}s` : "n/a";
    lines.push(`| ${label(f.data)} | ${f.data.n} | ${cacheCell} | ${meanCell} | ${f.data.elapsed_seconds.toFixed(0)}s |`);
  }
  lines.push("");

  lines.push(`## Aggregate R@${k} by mode`);
  lines.push("");
  const header = ["Mode", ...files.map((f) => label(f.data))];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const mode of modes) {
    const cells = [mode];
    for (const f of files) {
      const a = f.data.aggregate[mode];
      cells.push(a ? pct(a.recallAtK) : "—");
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push(`## Session-body-hit by mode`);
  lines.push("");
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const mode of modes) {
    const cells = [mode];
    for (const f of files) {
      const a = f.data.aggregate[mode];
      cells.push(a ? pct(a.sessionBodyHitRate) : "—");
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  // By question type, hybrid mode only (most published comparison)
  const referenceMode = modes.includes("hybrid") ? "hybrid" : modes[0]!;
  lines.push(`## ${referenceMode} R@${k} by question type`);
  lines.push("");
  const allTypes = new Set<string>();
  for (const f of files) for (const t of Object.keys(f.data.by_question_type)) allTypes.add(t);
  const typeList = Array.from(allTypes).sort();
  lines.push(`| Question type | ${files.map((f) => label(f.data)).join(" | ")} |`);
  lines.push(`| --- | ${files.map(() => "---").join(" | ")} |`);
  for (const t of typeList) {
    const cells = [t];
    for (const f of files) {
      const row = f.data.by_question_type[t]?.[referenceMode];
      cells.push(row ? `${pct(row.recallAtK)} (n=${row.n})` : "—");
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

main();
