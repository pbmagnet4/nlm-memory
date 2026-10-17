export type ContextCategory = "exact" | "scoped" | "rationale" | "temporal" | "ambiguity" | "no-answer";
export interface SourceRange { sourceId: string; start: number; end: number; text: string }
export interface ContextCase {
  id: string;
  question: string;
  workstream?: string;
  category: ContextCategory;
  sourceFamily: string;
  split: "dev" | "holdout";
  expected: { answerable: boolean; claims: readonly string[]; alternatives: readonly string[]; sourceRanges: readonly SourceRange[] };
}
export interface Revision { name: string; revision: string }
export interface TokenCounter { readonly metadata: Revision; count(text: string): number }
export interface ReaderAnswer { text: string; abstained: boolean; evidence: readonly { sourceId: string; text: string }[] }
export interface EvidenceReader {
  readonly metadata: Revision;
  read(input: { question: string; bundle: string }, emit: (event: CostEvent) => void): Promise<ReaderAnswer>;
}
export interface CostEvent {
  id: string;
  stage: "retrieval" | "expansion" | "reader" | "router" | "reranker" | "embedding";
  status: "started" | "ok" | "failed";
  input: string;
  output: string | null;
  usage: { input: number | null; output: number | null; cached: number | null; billed: number | null } | null;
  durationMs: number | null;
}
export interface ContextManifest {
  schema: 1;
  snapshot: { path: string; sha256: string };
  cases: { path: string; sha256: string };
  tenantId: string;
  tokenizer: Revision | null;
  reader: Revision;
  model: Revision | null;
  prompt: Revision;
  providerRole: string | null;
  initialContext: string;
  toolInstructions: string;
  toolSchema: string;
  mode: "keyword";
  cache: "disabled";
  labelAudit: "pending" | "complete";
  thresholds: { qualityGain: number; qualityLowerBound: number; tokenRatio: number; latencyBudgetMs: number };
  environment: Record<string, string>;
  adversarialMatrix: Record<string, string>;
}
export interface EvalArm {
  commit: string;
  run(input: { question: string; workstream?: string }, emit: (event: CostEvent) => void): Promise<string>;
  close(): Promise<void>;
}
export interface EvalDeps {
  tokenizer: TokenCounter | null;
  reader: EvidenceReader;
  openArm(commit: string, manifest: ContextManifest): Promise<EvalArm>;
  now(): number;
}
export interface ContextScore { sufficient: boolean; missingClaims: readonly string[]; missingAlternatives: readonly string[]; missingRanges: readonly SourceRange[] }
export interface CaseArmResult {
  score: ContextScore;
  answer: ReaderAnswer | null;
  events: CostEvent[];
  incrementalTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  error: string | null;
}
export interface PairedCase { id: string; family: string; category: ContextCategory; answerable: boolean; baseline: CaseArmResult; candidate: CaseArmResult }
export interface ConfidenceInterval { groups: number; samples: number; delta: number | null; lower: number | null; upper: number | null }
export interface MemoryContextReport {
  manifest: ContextManifest & { sha256: string; baseline: string; candidate: string; split: "dev" };
  perCase: PairedCase[];
  strata: Record<string, { n: number; baseline: number; candidate: number }>;
  answerMetrics: Record<"baseline" | "candidate", { answerableCoverage: { correct: number; total: number; rate: number | null }; noAnswerSuccess: { correct: number; total: number; rate: number | null }; abstentionPrecision: { correct: number; total: number; rate: number | null } }>;
  characterDiagnostics: { baseline: number; candidate: number };
  tokenTotals: { incremental: { baseline: number | null; candidate: number | null }; baseline: number | null; candidate: number | null; perSupportedAnswer: { baseline: number | null; candidate: number | null }; unavailable: string | null };
  latency: { baselineP95Ms: number | null; candidateP95Ms: number | null; conditions: Record<string, string> };
  failures: { id: string; arm: string; error: string }[];
  confidenceIntervals: ConfidenceInterval;
  promotion: { eligible: false; reasons: string[] };
}
