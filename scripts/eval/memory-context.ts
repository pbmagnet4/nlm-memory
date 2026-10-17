import { spawn, execFileSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, loadavg, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import type { LLMClient } from "../../src/ports/llm-client.js";
import { runMemoryContextEval, sha256 } from "../../src/core/eval/context/run.js";
import type { ContextManifest, CostEvent, EvalArm, EvidenceReader, ReaderAnswer } from "../../src/core/eval/context/types.js";

export const extractiveReader: EvidenceReader = {
  metadata: { name: "literal-bundle-reader", revision: "1" },
  async read(input, emit) {
    const start = performance.now();
    emit({ id: "reader", stage: "reader", status: "started", input: JSON.stringify(input), output: null, usage: null, durationMs: null });
    const bundle = JSON.parse(input.bundle) as {
      facts?: { value: string; sourceQuote?: string; source: { id: string } }[];
      sessions?: { id: string; summary: string; passages?: { text: string }[] }[];
    };
    const evidence = [
      ...(bundle.facts ?? []).filter((f) => f.sourceQuote).map((f) => ({ sourceId: f.source.id, text: f.sourceQuote! })),
      ...(bundle.sessions ?? []).flatMap((s) => (s.passages ?? []).map((p) => ({ sourceId: s.id, text: p.text }))),
    ];
    const text = [...(bundle.facts ?? []).map((f) => f.value), ...(bundle.sessions ?? []).map((s) => s.summary), ...evidence.map((e) => e.text)].join("\n");
    const answer: ReaderAnswer = { text: text || "Insufficient evidence", abstained: !(bundle.facts?.length || bundle.sessions?.length), evidence };
    emit({ id: "reader", stage: "reader", status: "ok", input: JSON.stringify(input), output: JSON.stringify(answer), usage: null, durationMs: performance.now() - start });
    return answer;
  },
};

export function createModelAttemptRecorder(emit: (event: CostEvent) => void): (method: string, args: unknown[]) => void {
  let sequence = 0;
  return (method, args) => emit({ id: `model-${++sequence}`, stage: method === "embed" ? "embedding" : "router", status: "failed", input: JSON.stringify(args), output: null, usage: null, durationMs: null });
}

export interface PinnedArmOptions {
  mode?: "keyword" | "default" | "hybrid";
  policy?: "cap2" | "cap1" | "tie-only";
  queryVectors?: { path: string; sha256: string };
}
interface QueryVectorCache {
  schema: number;
  caseSha256: string;
  reportedModel: string;
  dimension: number;
  rows: { query: string; kind: string; model: string; vector: number[] }[];
}

export function loadQueryVectors(path: string, digest: string, casesDigest: string): QueryVectorCache {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== digest) throw new Error("query vector cache hash mismatch");
  const cache = JSON.parse(bytes.toString()) as QueryVectorCache;
  if (cache.schema !== 1 || cache.caseSha256 !== casesDigest || !cache.reportedModel || !Number.isInteger(cache.dimension) || cache.dimension < 1) throw new Error("query vector cache metadata mismatch");
  const queries = new Set<string>();
  for (const row of cache.rows) {
    if (!row.query || row.kind !== "query" || row.model !== cache.reportedModel || queries.has(row.query)
      || row.vector.length !== cache.dimension || !row.vector.every(Number.isFinite)) throw new Error("invalid frozen query vector");
    queries.add(row.query);
  }
  return cache;
}

export function cachedEmbeddingClient(cache: QueryVectorCache, emit: (event: CostEvent) => void): LLMClient {
  const rows = new Map(cache.rows.map((row) => [row.query, row]));
  let sequence = 0;
  return new Proxy({} as LLMClient, { get(_target, method) { return async (...args: unknown[]) => {
    const event: CostEvent = { id: `model-${++sequence}`, stage: method === "embed" ? "embedding" : "router", status: "failed",
      input: JSON.stringify(args.slice(0, 2)), output: null, usage: null, durationMs: null };
    const row = method === "embed" && args[1] === "query" ? rows.get(String(args[0])) : undefined;
    if (!row) { emit(event); throw new Error(`frozen quality cache forbids missing/model call: ${String(method)}`); }
    emit({ ...event, status: "ok", output: JSON.stringify({ cache: "frozen-query-vector", model: row.model, dimensions: row.vector.length, providerCalls: 0 }) });
    return { vector: Float32Array.from(row.vector), model: row.model };
  }; } });
}

export function contextArguments(input: { question: string; workstream?: string }, mode: PinnedArmOptions["mode"] = "keyword") {
  return { query: input.question, ...(mode === "default" ? {} : { mode }), ...(input.workstream ? { workstream: input.workstream } : {}) };
}

export function sourceRepetition(sourceIds: readonly string[], components: ReadonlyMap<string, string>) {
  const ids = [...new Set(sourceIds)];
  return { sourceSessions: ids.length, knownSourceComponents: new Set(ids.flatMap((id) => components.has(id) ? [components.get(id)!] : [])).size,
    unclassifiedSources: ids.filter((id) => !components.has(id)).length, independentEvidence: null };
}

export function isolatedArmEnvironment(dir: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "PATHEXT"]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  return { ...env, TMPDIR: join(dir, "tmp"), TMP: join(dir, "tmp"), TEMP: join(dir, "tmp"), HOME: join(dir, "home"), XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"),
    NLM_CLAUDE_PROJECTS_ROOT: join(dir, "home", ".claude", "projects"), CODEX_HOME: join(dir, "home", ".codex"),
    NLM_HOME: join(dir, "state"), NLM_STATE_ROOT: join(dir, "state"), NLM_FORMAT: "json", NLM_QUERY_LOG: join(dir, "queries.jsonl"), NLM_FACT_QUERY_LOG: join(dir, "facts.jsonl") };
}

function runnerSource(worktree: string, db: string, manifest: ContextManifest, options: PinnedArmOptions): string {
  const mod = (path: string): string => JSON.stringify(pathToFileURL(join(worktree, path)).href);
  return `import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { SqliteStorage } from ${mod("src/core/storage/sqlite-storage.ts")};
import { RecallService } from ${mod("src/core/recall/recall-service.ts")};
import * as factModule from ${mod("src/core/recall-facts/fact-recall-service.ts")};
import { recallContextHandler } from ${mod("src/mcp/server.ts")};
import { createModelAttemptRecorder, cachedEmbeddingClient, loadQueryVectors, contextArguments } from ${JSON.stringify(import.meta.url)};
const options=${JSON.stringify(options)};
const cache=options.queryVectors?loadQueryVectors(options.queryVectors.path,options.queryVectors.sha256,${JSON.stringify(manifest.cases.sha256)}):null;
const send = (x) => process.stdout.write('NLM_EVAL:'+JSON.stringify(x)+'\\n');
const recordAttempt = createModelAttemptRecorder(event => send({event}));
const llm = cache ? cachedEmbeddingClient(cache,event=>send({event})) : new Proxy({}, {get(_t, method) { return async (...args) => {
 recordAttempt(String(method),args); throw new Error('keyword control forbids model call: '+String(method));
}}});
const storage = SqliteStorage.create({dbPath:${JSON.stringify(db)},migrationsDir:${JSON.stringify(join(worktree, "migrations"))}});
await storage.init();
if(cache){const config=storage.embeddingConfig.getLane('prose');if(config?.model!==cache.reportedModel||config?.dim!==cache.dimension)throw new Error('snapshot embedding model/dimension mismatch');}
const ranking = options.policy ? factModule.corroborationRanking(options.policy==='cap2'?2:1,options.policy!=='cap1') : undefined;
const deps = {workstreams:{store:storage.workstreams,sessions:storage.sessions,facts:storage.facts,exemplars:storage.exemplars},store:storage.sessions,factStore:storage.facts,recall:new RecallService({store:storage.sessions,llm}),factRecall:new factModule.FactRecallService({factStore:storage.facts,llm,...(ranking?{corroborationRanking:ranking}:{})})};
send({ready:true});
try {
 for await (const line of createInterface({input:process.stdin})) {
  const input=JSON.parse(line); const start=performance.now();
  const args=contextArguments(input,options.mode);
  const event={id:'retrieval',stage:'retrieval',status:'started',input:JSON.stringify(args),output:null,usage:null,durationMs:null}; send({event});
  try {
   const result=await recallContextHandler(deps,${JSON.stringify(manifest.tenantId)},args);
   const text=result.content.filter((c)=>c.type==='text').map((c)=>c.text).join('\\n');
   send({event:{...event,status:result.isError?'failed':'ok',output:text,durationMs:performance.now()-start}});
   send(result.isError?{error:text}:{bundle:text});
  } catch(e) {send({event:{...event,status:'failed',durationMs:performance.now()-start}});send({error:String(e)});}
 }
} finally { await storage.close(); }
`;
}

export async function openPinnedArm(repo: string, revision: string, manifest: ContextManifest, options: PinnedArmOptions = {}): Promise<EvalArm> {
  if (options.queryVectors) loadQueryVectors(options.queryVectors.path, options.queryVectors.sha256, manifest.cases.sha256);
  const commit = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: repo, encoding: "utf8" }).trim();
  const parent = join(homedir(), ".nxtos", "worktrees");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "nlm-context-eval-"));
  const worktree = join(dir, "code");
  let registered = false;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  const cleanup = async (): Promise<void> => {
    if (child && child.exitCode === null && child.signalCode === null) { child.stdin!.end(); child.kill("SIGTERM"); }
    await exited;
    try { if (registered) execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, stdio: "pipe" }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, commit], { cwd: repo, stdio: "pipe" });
    registered = true;
    symlinkSync(join(repo, "node_modules"), join(worktree, "node_modules"));
    const db = join(dir, "canonical.sqlite");
    copyFileSync(manifest.snapshot.path, db, constants.COPYFILE_FICLONE);
    chmodSync(db, 0o600);
    const runner = join(dir, "runner.mts");
    writeFileSync(runner, runnerSource(worktree, db, manifest, options), { mode: 0o600 });
    for (const path of ["home/.claude/projects", "home/.codex", "home/.pi/agent/sessions", "data/muse/sessions", "config", "cache", "state", "tmp"]) mkdirSync(join(dir, path), { recursive: true });
    child = spawn(process.execPath, ["--import", pathToFileURL(join(repo, "node_modules/tsx/dist/loader.mjs")).href, runner], {
      cwd: worktree, stdio: ["pipe", "pipe", "pipe"],
      env: { ...isolatedArmEnvironment(dir, process.env), TSX_TSCONFIG_PATH: join(worktree, "tsconfig.json") },
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    const lines: string[] = [];
    let pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
    let stopped: Error | undefined;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith("NLM_EVAL:")) return;
      const value = line.slice(9);
      if (pending) { const waiter = pending; pending = undefined; waiter.resolve(value); } else lines.push(value);
    });
    exited = new Promise((done) => {
      child!.once("exit", (code, signal) => { stopped = new Error(`arm exited ${code ?? signal}: ${stderr}`); pending?.reject(stopped); done(undefined); });
      child!.once("error", (error) => { stopped = error; pending?.reject(error); done(undefined); });
    });
    const next = async (): Promise<Record<string, unknown>> => {
      const line = lines.shift();
      if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
      if (stopped) throw stopped;
      return JSON.parse(await new Promise<string>((resolve, reject) => { pending = { resolve, reject }; })) as Record<string, unknown>;
    };
    if (!(await next())["ready"]) throw new Error("arm did not initialize");
    return { commit, metadata: { ...options, mode: options.mode ?? "keyword", cacheQualityOnly: !!options.queryVectors, livePerformanceAvailable: false, providerCalls: 0, embeddingUsage: null, weightDigest: null }, close: cleanup, async run(input, emit) {
      child!.stdin!.write(JSON.stringify(input) + "\n");
      for (;;) {
        const response = await next();
        if (response["event"]) emit(response["event"] as CostEvent);
        if (typeof response["error"] === "string") throw new Error(response["error"]);
        if (typeof response["bundle"] === "string") return response["bundle"];
      }
    } };
  } catch (error) { await cleanup(); throw error; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (key: string): string => {
    const index = args.indexOf(`--${key}`);
    const value = index < 0 ? undefined : args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`required --${key} <value>`);
    return value;
  };
  const optional = (key: string): string | undefined => args.includes(`--${key}`) ? get(key) : undefined;
  const mode = (key: string): PinnedArmOptions["mode"] => {
    const value = optional(key) ?? "keyword";
    if (!["keyword", "default", "hybrid"].includes(value)) throw new Error(`invalid --${key}`);
    return value as PinnedArmOptions["mode"];
  };
  const policy = optional("candidate-policy");
  if (policy && !["cap2", "cap1", "tie-only"].includes(policy)) throw new Error("invalid --candidate-policy");
  const vectors = optional("vectors");
  const queryVectors = vectors ? { path: resolve(vectors), sha256: get("vectors-sha256") } : undefined;
  const manifestPath = resolve(get("manifest"));
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as ContextManifest;
  if (raw.tokenizer !== null) throw new Error("this CLI has no pinned consumer tokenizer; set manifest tokenizer null, or supply an audited EvalDeps counter programmatically");
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const outputPath = resolve(get("out"));
  if (existsSync(outputPath)) throw new Error("refusing to overwrite report");
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  let opened = 0;
  const report = await runMemoryContextEval({ manifestPath, baseline: get("baseline"), candidate: get("candidate"), outputPath }, {
    tokenizer: null, reader: extractiveReader,
    openArm: (commit, manifest) => {
      const candidate = opened++ === 1;
      return openPinnedArm(repo, commit, manifest, {
        mode: mode(candidate ? "candidate-mode" : "baseline-mode")!,
        ...(candidate && policy ? { policy: policy as NonNullable<PinnedArmOptions["policy"]> } : {}),
        ...(queryVectors ? { queryVectors } : {}),
      });
    }, now: () => performance.now(),
  });
  console.log(JSON.stringify({ out: outputPath, n: report.perCase.length, strata: report.strata, failures: report.failures.length,
    promotion: report.promotion, runEnvironment: { host: hostname(), load: loadavg() } }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e: unknown) => { console.error(String(e)); process.exitCode = 1; });
