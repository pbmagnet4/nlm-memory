import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { hostname, loadavg } from "node:os";
import { groupedBootstrap, scoreContext } from "./score.js";
import type { CaseArmResult, ContextCase, ContextManifest, CostEvent, EvalArm, EvalDeps, MemoryContextReport, PairedCase } from "./types.js";

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadManifest(path: string): Promise<{ manifest: ContextManifest; cases: ContextCase[]; hash: string }> {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as ContextManifest;
  if (manifest.schema !== 1 || manifest.mode !== "keyword" || manifest.cache !== "disabled") throw new Error("unsupported context manifest contract");
  const casesPath = resolve(dirname(path), manifest.cases.path);
  const casesBytes = readFileSync(casesPath);
  if (sha256(casesBytes) !== manifest.cases.sha256) throw new Error("case hash mismatch");
  if (await fileSha256(manifest.snapshot.path) !== manifest.snapshot.sha256) throw new Error("snapshot hash mismatch");
  const cases = JSON.parse(casesBytes.toString()) as ContextCase[];
  const families = new Map<string, string>();
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);
    if (families.has(c.sourceFamily) && families.get(c.sourceFamily) !== c.split) throw new Error(`family crosses split: ${c.sourceFamily}`);
    families.set(c.sourceFamily, c.split);
    if (!c.question || !c.sourceFamily || !["dev", "holdout"].includes(c.split)) throw new Error("invalid case");
    for (const r of c.expected.sourceRanges) {
      if (r.start < 0 || r.end <= r.start || r.text.length !== r.end - r.start) throw new Error(`invalid UTF-16 range: ${c.id}`);
    }
  }
  return { manifest, cases: cases.filter((c) => c.split === "dev"), hash: sha256(raw) };
}

async function execute(arm: EvalArm, c: ContextCase, deps: EvalDeps, manifest: ContextManifest): Promise<CaseArmResult> {
  const started = deps.now();
  const events = new Map<string, CostEvent>();
  const emit = (event: CostEvent): void => { events.set(event.id, event); };
  emit({ id: "retrieval", stage: "retrieval", status: "started", input: JSON.stringify({ question: c.question, workstream: c.workstream }), output: null, usage: null, durationMs: null });
  let answer = null;
  let error = null;
  try {
    const bundle = await arm.run({ question: c.question, ...(c.workstream ? { workstream: c.workstream } : {}) }, emit);
    emit({ id: "reader", stage: "reader", status: "started", input: JSON.stringify({ question: c.question, bundle }), output: null, usage: null, durationMs: null });
    answer = await deps.reader.read({ question: c.question, bundle }, emit);
  } catch (e) { error = String(e); }
  const ledger = [...events.values()];
  const tokens = deps.tokenizer;
  const incrementalTokens = tokens && ledger.every((e) => e.status === "ok" && e.output !== null)
    ? ledger.reduce((sum, e) => sum + tokens.count(e.input) + tokens.count(e.output!), 0) + tokens.count(manifest.toolInstructions) + tokens.count(manifest.toolSchema) : null;
  return { answer, error, events: ledger, incrementalTokens,
    totalTokens: incrementalTokens === null || !tokens ? null : incrementalTokens + tokens.count(manifest.initialContext),
    durationMs: deps.now() - started,
    score: answer ? scoreContext(c, answer) : { sufficient: false, missingClaims: c.expected.claims, missingAlternatives: c.expected.alternatives, missingRanges: c.expected.sourceRanges } };
}

const p95 = (values: number[]): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]! : null;

export async function runMemoryContextEval(input: { manifestPath: string; baseline: string; candidate: string; outputPath: string }, deps: EvalDeps): Promise<MemoryContextReport> {
  const { manifest, cases, hash } = await loadManifest(input.manifestPath);
  if (JSON.stringify(deps.tokenizer?.metadata ?? null) !== JSON.stringify(manifest.tokenizer)) throw new Error("tokenizer revision mismatch");
  if (JSON.stringify(deps.reader.metadata) !== JSON.stringify(manifest.reader)) throw new Error("reader revision mismatch");
  if (!cases.length) throw new Error("no development cases");
  const loadStart = loadavg();
  const baseline = await deps.openArm(input.baseline, manifest);
  let candidate: EvalArm | undefined;
  const perCase: PairedCase[] = [];
  try {
    candidate = await deps.openArm(input.candidate, manifest);
    for (const [index, c] of cases.entries()) {
      const arms = [baseline, candidate];
      const order = index % 2 ? [1, 0] : [0, 1];
      const result: CaseArmResult[] = [];
      for (const i of order) result[i] = await execute(arms[i]!, c, deps, manifest);
      perCase.push({ id: c.id, family: c.sourceFamily, category: c.category, answerable: c.expected.answerable, baseline: result[0]!, candidate: result[1]! });
    }
  } finally { try { await candidate?.close(); } finally { await baseline.close(); } }
  const strata: MemoryContextReport["strata"] = {};
  const failures: MemoryContextReport["failures"] = [];
  for (const row of perCase) {
    for (const key of ["overall", row.category, row.answerable ? "answerable-coverage" : "no-answer-success"]) {
      const s = strata[key] ?? { n: 0, baseline: 0, candidate: 0 };
      s.n++; s.baseline += Number(row.baseline.score.sufficient); s.candidate += Number(row.candidate.score.sufficient); strata[key] = s;
    }
    for (const arm of ["baseline", "candidate"] as const) {
      if (row[arm].error) failures.push({ id: row.id, arm, error: row[arm].error! });
      for (const event of row[arm].events) if (event.status !== "ok") failures.push({ id: row.id, arm, error: `${event.stage} ${event.status}; usage may be unavailable` });
    }
  }
  const total = (arm: "baseline" | "candidate"): number | null => perCase.some((r) => r[arm].totalTokens === null) ? null : perCase.reduce((s, r) => s + r[arm].totalTokens!, 0);
  const perSupported = (arm: "baseline" | "candidate"): number | null => total(arm) === null || !strata["overall"]![arm] ? null : total(arm)! / strata["overall"]![arm];
  const answerMetrics = (arm: "baseline" | "candidate") => {
    const metric = (rows: PairedCase[], correct: (r: PairedCase) => boolean) => {
      const n = rows.filter(correct).length;
      return { correct: n, total: rows.length, rate: rows.length ? n / rows.length : null };
    };
    return {
      answerableCoverage: metric(perCase.filter((r) => r.answerable), (r) => r[arm].score.sufficient),
      noAnswerSuccess: metric(perCase.filter((r) => !r.answerable), (r) => r[arm].score.sufficient),
      abstentionPrecision: metric(perCase.filter((r) => r[arm].answer?.abstained === true), (r) => !r.answerable && r[arm].score.sufficient),
    };
  };
  const report: MemoryContextReport = {
    manifest: { ...manifest, sha256: hash, baseline: baseline.commit, candidate: candidate!.commit, split: "dev" }, perCase, strata,
    answerMetrics: { baseline: answerMetrics("baseline"), candidate: answerMetrics("candidate") },
    characterDiagnostics: { baseline: perCase.reduce((sum, r) => sum + r.baseline.events.reduce((n, e) => n + e.input.length + (e.output?.length ?? 0), 0), 0), candidate: perCase.reduce((sum, r) => sum + r.candidate.events.reduce((n, e) => n + e.input.length + (e.output?.length ?? 0), 0), 0) },
    tokenTotals: { incremental: { baseline: total("baseline") === null || !deps.tokenizer ? null : total("baseline")! - perCase.length * deps.tokenizer.count(manifest.initialContext), candidate: total("candidate") === null || !deps.tokenizer ? null : total("candidate")! - perCase.length * deps.tokenizer.count(manifest.initialContext) }, baseline: total("baseline"), candidate: total("candidate"), perSupportedAnswer: { baseline: perSupported("baseline"), candidate: perSupported("candidate") }, unavailable: deps.tokenizer ? failures.length ? "failed or incomplete stages" : null : "pinned consumer tokenizer unavailable" },
    latency: { baselineP95Ms: p95(perCase.map((r) => r.baseline.durationMs)), candidateP95Ms: p95(perCase.map((r) => r.candidate.durationMs)), conditions: { ...manifest.environment, observedHost: hostname(), observedLoadStart: JSON.stringify(loadStart), observedLoadEnd: JSON.stringify(loadavg()), node: process.version, sqlTiming: "unavailable" } }, failures,
    confidenceIntervals: groupedBootstrap(perCase.map((r) => ({ family: r.family, baseline: Number(r.baseline.score.sufficient), candidate: Number(r.candidate.score.sufficient) }))),
    promotion: { eligible: false, reasons: ["development-only measurement; holdout sealed", ...(manifest.labelAudit !== "complete" ? ["source label audit pending"] : []), ...(!deps.tokenizer ? ["consumer token measurements unavailable"] : []), "extractive literal evidence diagnostic; blinded supported-answer review still required"] },
  };
  writeFileSync(input.outputPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  return report;
}
