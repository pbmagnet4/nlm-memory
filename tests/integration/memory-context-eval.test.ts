import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { runMemoryContextEval, sha256 } from "../../src/core/eval/context/run.js";
import type { ContextCase, ContextManifest, EvalDeps } from "../../src/core/eval/context/types.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import { cachedEmbeddingClient, contextArguments, loadQueryVectors, sourceRepetition, createModelAttemptRecorder, isolatedArmEnvironment, extractiveReader, openPinnedArm } from "../../scripts/eval/memory-context.js";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nlm-context-eval-test-")); dirs.push(dir);
  const db = join(dir, "snapshot.sqlite"); writeFileSync(db, "synthetic snapshot");
  const cases: ContextCase[] = ["dev", "holdout"].map((split) => ({ id: split, question: "why SQLite single writer", category: "rationale", sourceFamily: split, split: split as "dev" | "holdout", expected: { answerable: true, claims: ["SQLite", "single writer"], alternatives: [], sourceRanges: [{ sourceId: "source", start: 0, end: "SQLite uses a single writer".length, text: "SQLite uses a single writer" }] } }));
  const casesPath = join(dir, "cases.json"); writeFileSync(casesPath, JSON.stringify(cases));
  const manifest: ContextManifest = { schema: 1, snapshot: { path: db, sha256: sha256(readFileSync(db)) }, cases: { path: casesPath, sha256: sha256(readFileSync(casesPath)) }, tenantId: "team_local", tokenizer: { name: "synthetic-character-counter", revision: "test-only-1" }, reader: extractiveReader.metadata, model: null, prompt: { name: "extractive", revision: "1" }, providerRole: null, initialContext: "same initial context", toolInstructions: "memory context", toolSchema: "{query:string}", mode: "keyword", cache: "disabled", labelAudit: "pending", thresholds: { qualityGain: 0.05, qualityLowerBound: -0.02, tokenRatio: 1.1, latencyBudgetMs: 1500 }, environment: { fixture: "synthetic" }, adversarialMatrix: {} };
  const manifestPath = join(dir, "manifest.json");
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest)); save();
  return { dir, db, cases, casesPath, manifest, manifestPath, save };
}
const bundle = JSON.stringify({ facts: [], sessions: [{ id: "source", summary: "SQLite", passages: [{ text: "SQLite uses a single writer" }] }] });
function dependencies(fail = false): EvalDeps {
  return { tokenizer: { metadata: { name: "synthetic-character-counter", revision: "test-only-1" }, count: (s) => s.length }, reader: extractiveReader, now: () => 1, async openArm(commit) {
    return { commit, async close() {}, async run(input, emit) {
      const event = { id: "retrieval", stage: "retrieval" as const, status: "started" as const, input: JSON.stringify(input), output: null, usage: null, durationMs: null }; emit(event);
      if (fail) { emit({ ...event, id: "embedding", stage: "embedding", status: "failed" }); throw new Error("embed failed"); }
      emit({ ...event, status: "ok", output: bundle, durationMs: 1 }); return bundle;
    } };
  } };
}
describe("memory context evaluator", () => {
  it("keeps holdout sealed and identical evidence/costs deterministic", async () => {
    const f = fixture();
    const report = await runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, dependencies());
    expect(report.perCase.map((c) => c.id)).toEqual(["dev"]);
    expect(report.perCase[0]!.baseline.score).toEqual(report.perCase[0]!.candidate.score);
    expect(report.tokenTotals.baseline).toBe(report.tokenTotals.candidate);
    expect(report.perCase[0]!.baseline.events.map((e) => e.stage)).toEqual(["retrieval", "reader"]);
    expect(report.promotion.eligible).toBe(false);
  });
  it("requires frozen registration, retains holdout identity and consumes it once", async () => {
    const f = fixture();
    const registrationPath = join(f.dir, "registration.json");
    f.manifest.mode = "default"; f.manifest.cache = "frozen-query-vectors"; f.save();
    const baseline = "a".repeat(40), candidate = "b".repeat(40);
    writeFileSync(registrationPath, JSON.stringify({ schema: 1, purpose: "literal-diagnostic-only", baseline, candidate,
      manifestSha256: sha256(readFileSync(f.manifestPath)), fixedN: 1, contrasts: ["candidate-minus-baseline"] }));
    const input = { manifestPath: f.manifestPath, baseline, candidate, outputPath: join(f.dir, "heldout.json"),
      holdout: { registrationPath, sha256: sha256(readFileSync(registrationPath)) } };
    await expect(runMemoryContextEval({ ...input, candidate: "c".repeat(40) }, dependencies())).rejects.toThrow("invalid preregistration");
    await expect(runMemoryContextEval({ ...input, holdout: { registrationPath, sha256: "wrong" } }, dependencies())).rejects.toThrow("preregistration hash mismatch");
    const report = await runMemoryContextEval(input, dependencies());
    expect(report.perCase.map((row) => row.id)).toEqual(["holdout"]);
    expect(report.manifest.split).toBe("holdout");
    expect(report.promotion.eligible).toBe(false);
    await expect(runMemoryContextEval(input, dependencies())).rejects.toThrow("EEXIST");
  });
  it("retains a consumed attempt when fixed holdout N is wrong", async () => {
    const f = fixture(); const registrationPath = join(f.dir, "registration.json");
    const commit = "a".repeat(40);
    writeFileSync(registrationPath, JSON.stringify({ schema: 1, purpose: "literal-diagnostic-only", baseline: commit, candidate: commit,
      manifestSha256: sha256(readFileSync(f.manifestPath)), fixedN: 2, contrasts: ["candidate-minus-baseline"] }));
    const input = { manifestPath: f.manifestPath, baseline: commit, candidate: commit, outputPath: join(f.dir, "heldout.json"),
      holdout: { registrationPath, sha256: sha256(readFileSync(registrationPath)) } };
    await expect(runMemoryContextEval(input, dependencies())).rejects.toThrow("fixed holdout sample mismatch");
    expect(readFileSync(`${registrationPath}.consumed`, "utf8")).toContain(input.holdout.sha256);
  });
  it("reports false abstentions in the predicted-abstention precision denominator", async () => {
    const f = fixture();
    f.cases.push({ ...f.cases[0]!, id: "negative-dev", category: "no-answer", sourceFamily: "negative", expected: { answerable: false, claims: [], alternatives: [], sourceRanges: [] } });
    writeFileSync(f.casesPath, JSON.stringify(f.cases)); f.manifest.cases.sha256 = sha256(readFileSync(f.casesPath)); f.save();
    const deps = dependencies();
    deps.reader = { metadata: extractiveReader.metadata, async read() { return { text: "Insufficient evidence", abstained: true, evidence: [] }; } };
    const report = await runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, deps);
    expect(report.answerMetrics.baseline.answerableCoverage).toEqual({ correct: 0, total: 1, rate: 0 });
    expect(report.answerMetrics.baseline.noAnswerSuccess).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(report.answerMetrics.baseline.abstentionPrecision).toEqual({ correct: 1, total: 2, rate: 0.5 });
  });
  it("counts only supported answerable cases in tokens per supported answer", async () => {
    const f = fixture();
    f.cases.push({ ...f.cases[0]!, id: "negative-dev", category: "no-answer", question: "missing information", sourceFamily: "negative", expected: { answerable: false, claims: [], alternatives: [], sourceRanges: [] } });
    writeFileSync(f.casesPath, JSON.stringify(f.cases)); f.manifest.cases.sha256 = sha256(readFileSync(f.casesPath)); f.save();
    const deps = dependencies();
    deps.reader = { metadata: extractiveReader.metadata, async read(input, emit) {
      const answer = input.question === "missing information" ? { text: "Insufficient evidence", abstained: true, evidence: [] } : { text: "SQLite uses a single writer", abstained: false, evidence: [{ sourceId: "source", text: "SQLite uses a single writer" }] };
      emit({ id: "reader", stage: "reader", status: "ok", input: JSON.stringify(input), output: JSON.stringify(answer), usage: null, durationMs: 0 }); return answer;
    } };
    const report = await runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, deps);
    expect(report.strata["overall"]!.baseline).toBe(2);
    expect(report.tokenTotals.perSupportedAnswer.baseline).toBe(report.tokenTotals.baseline);
  });
  it("retains two immediate model attempts with unique invocation IDs", async () => {
    const f = fixture(); const deps = dependencies();
    deps.openArm = async (commit) => ({ commit, async close() {}, async run(_input, emit) {
      const record = createModelAttemptRecorder(emit); record("embed", ["query"]); record("embed", ["query"]); return bundle;
    } });
    const report = await runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, deps);
    const attempts = report.perCase[0]!.baseline.events.filter((e) => e.stage === "embedding");
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map((e) => e.id)).size).toBe(2);
    expect(report.failures.filter((f) => f.arm === "baseline" && f.error.startsWith("embedding"))).toHaveLength(2);
    expect(report.tokenTotals.baseline).toBeNull();
  });
  it("replaces inherited production HOME, XDG and runtime path overrides", () => {
    const env = isolatedArmEnvironment("/isolated", { HOME: "/external", XDG_DATA_HOME: "/external/data", NLM_CLAUDE_PROJECTS_ROOT: "/external/claude", NLM_STATE_ROOT: "/external/state", CODEX_HOME: "/external/codex", NLM_QUERY_LOG: "/external/log", PATH: "/bin" });
    expect(env.TMPDIR).toBe("/isolated/tmp"); expect(env.HOME).toBe("/isolated/home"); expect(env.XDG_DATA_HOME).toBe("/isolated/data"); expect(env.NLM_CLAUDE_PROJECTS_ROOT).toBe("/isolated/home/.claude/projects");
    expect(env.NLM_STATE_ROOT).toBe("/isolated/state"); expect(env.CODEX_HOME).toBe("/isolated/home/.codex"); expect(env.NLM_QUERY_LOG).toBe("/isolated/queries.jsonl");
  });
  it("preserves pending and failed model calls and unknown cost", async () => {
    const f = fixture();
    const report = await runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, dependencies(true));
    expect(report.failures).toHaveLength(6);
    expect(report.perCase[0]!.baseline.events.map((e) => e.status)).toEqual(["started", "failed"]);
    expect(report.tokenTotals.baseline).toBeNull();
  });
  it("rejects families crossing split and changed frozen cases", async () => {
    const f = fixture();
    f.cases[1]!.sourceFamily = "dev"; writeFileSync(f.casesPath, JSON.stringify(f.cases));
    await expect(runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, dependencies())).rejects.toThrow("hash mismatch");
    f.manifest.cases.sha256 = sha256(readFileSync(f.casesPath)); f.save();
    await expect(runMemoryContextEval({ manifestPath: f.manifestPath, baseline: "a", candidate: "a", outputPath: join(f.dir, "report.json") }, dependencies())).rejects.toThrow("family crosses split");
  });
  it("executes the real compact handler at a pinned commit on isolated synthetic copies", async () => {
    const f = fixture(); rmSync(f.db);
    const storage = SqliteStorage.create({ dbPath: f.db, migrationsDir: resolve("migrations") }); await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: "source", label: "SQLite single writer", summary: "SQLite uses a single writer", body: "SQLite uses a single writer" }), "team_local");
    await storage.close();
    f.manifest.snapshot.sha256 = sha256(readFileSync(f.db)); f.manifest.tokenizer = null; f.save();
    const external = join(f.dir, "external"); mkdirSync(external);
    writeFileSync(join(external, "outside-sentinel.jsonl"), JSON.stringify({ query: f.cases[0]!.question }));
    vi.stubEnv("NLM_CLAUDE_PROJECTS_ROOT", external); vi.stubEnv("XDG_DATA_HOME", external);
    const parent = join(homedir(), ".nxtos", "worktrees");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const report = await runMemoryContextEval({ manifestPath: f.manifestPath, baseline: revision, candidate: revision, outputPath: join(f.dir, "report.json") }, { tokenizer: null, reader: extractiveReader, now: () => performance.now(), openArm: async (commit, manifest) => {
      const beforeOpen = new Set(existsSync(parent) ? readdirSync(parent) : []);
      const arm = await openPinnedArm(resolve("."), commit, manifest);
      const created = readdirSync(parent).filter((name) => name.startsWith("nlm-context-eval-") && !beforeOpen.has(name));
      const run = arm.run.bind(arm);
      arm.run = async (input, emit) => {
        const result = await run(input, emit);
        for (const name of created) await vi.waitFor(() => {
          const log = join(parent, name, "queries.jsonl");
          expect(readFileSync(log, "utf8")).not.toContain("outside-sentinel");
        });
        return result;
      };
      return arm;
    } });
    expect(report.failures).toEqual([]);
    expect(report.perCase[0]!.baseline.score.sufficient).toBe(true);
    expect(report.perCase[0]!.baseline.answer).toEqual(report.perCase[0]!.candidate.answer);
    expect(sha256(readFileSync(f.db))).toBe(f.manifest.snapshot.sha256);
    expect(report.manifest.baseline).toBe(revision);
  }, 60_000);
});


describe("frozen ranking-arm support", () => {
  it("distinguishes omitted production default from explicit keyword and hybrid", () => {
    expect(contextArguments({ question: "beacon" }, "default")).toEqual({ query: "beacon" });
    expect(contextArguments({ question: "beacon" }, "hybrid")).toEqual({ query: "beacon", mode: "hybrid" });
    expect(contextArguments({ question: "beacon" })).toEqual({ query: "beacon", mode: "keyword" });
  });
  it("verifies immutable vectors, records logical calls, and leaves billed usage unknown", async () => {
    const f = fixture(); const path = join(f.dir, "vectors.json");
    writeFileSync(path, JSON.stringify({ schema: 1, caseSha256: f.manifest.cases.sha256, dimension: 2, reportedModel: "synthetic", rows: [{ query: "beacon", kind: "query", model: "synthetic", vector: [1, 0] }] }));
    const hash = sha256(readFileSync(path));
    expect(() => loadQueryVectors(path, "wrong", f.manifest.cases.sha256)).toThrow("hash mismatch");
    const events: import("../../src/core/eval/context/types.js").CostEvent[] = [];
    const client = cachedEmbeddingClient(loadQueryVectors(path, hash, f.manifest.cases.sha256), (event) => events.push(event));
    expect([...(await client.embed("beacon", "query")).vector]).toEqual([1, 0]);
    await expect(client.embed("missing", "query")).rejects.toThrow("forbids missing");
    await expect(client.embed("beacon", "document")).rejects.toThrow("forbids missing");
    expect(events.map((e) => e.status)).toEqual(["ok", "failed", "failed"]);
    expect(events.every((e) => e.usage === null)).toBe(true);
  });
  it("runs cached default and both-hybrid through pinned services with one shared logical embedding", async () => {
    const f = fixture(); rmSync(f.db);
    const storage = SqliteStorage.create({ dbPath: f.db, migrationsDir: resolve("migrations") }); await storage.init();
    storage.embeddingConfig.upsertLane({ lane: "prose", provider: "openai", model: "synthetic", dim: 768 }, new Date(0).toISOString());
    storage.sessions.insertSessionForTest(makeSession({ id: "source", label: "SQLite", summary: "SQLite uses a single writer", body: "SQLite uses a single writer" }), "team_local");
    await storage.close();
    f.manifest.snapshot.sha256 = sha256(readFileSync(f.db)); f.manifest.tokenizer = null;
    const path = join(f.dir, "vectors.json");
    writeFileSync(path, JSON.stringify({ schema: 1, caseSha256: f.manifest.cases.sha256, dimension: 768, reportedModel: "synthetic", rows: [{ query: f.cases[0]!.question, kind: "query", model: "synthetic", vector: [1, ...Array<number>(767).fill(0)] }] }));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    for (const mode of ["keyword", "default", "hybrid"] as const) {
      const arm = await openPinnedArm(resolve("."), revision, f.manifest, { mode, queryVectors: { path, sha256: sha256(readFileSync(path)) } });
      try {
        const events: import("../../src/core/eval/context/types.js").CostEvent[] = [];
        await arm.run({ question: f.cases[0]!.question }, (event) => events.push(event));
        expect(events.filter((event) => event.stage === "embedding")).toHaveLength(mode === "keyword" ? 0 : 1);
        expect(events.filter((event) => event.stage === "embedding").every((event) => event.status === "ok")).toBe(true);
      } finally { await arm.close(); }
    }
  }, 60_000);
  it("reports copied sessions separately from source components without claiming independent truth", () => {
    expect(sourceRepetition(["copy-a", "copy-b", "distinct", "copy-a"], new Map([["copy-a", "parent"], ["copy-b", "parent"], ["distinct", "other"]])))
      .toEqual({ sourceSessions: 3, knownSourceComponents: 2, unclassifiedSources: 0, independentEvidence: null });
  });
});
