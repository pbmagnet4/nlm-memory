import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, chmodSync, constants, copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { hostname, loadavg } from "node:os";
import { autoloadEnv } from "../../src/llm/env-autoload.js";
import { isolatedArmEnvironment } from "./memory-context.js";

const [snapshot, output, base = "69f4c3faa46f3424918172bb899a1086c092f42c"] = process.argv.slice(2);
if (!snapshot || !output) throw new Error("usage: request-budget-performance.ts <snapshot.sqlite> <private-output-dir> [base]");
const repo = process.cwd();
const out = resolve(output);
function sourceHash(): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) { hash.update(path.slice(repo.length)); hash.update(readFileSync(path)); }
    }
  };
  walk(join(repo,"src"));
  return hash.digest("hex");
}
const candidateSourceHash = sourceHash();
mkdirSync(out, { recursive: true, mode: 0o700 });
const pinned = join(out, "baseline-code");
mkdirSync(pinned, { recursive: true });
const archive = execFileSync("git", ["archive", base, "src", "migrations", "tsconfig.json", "package.json"], { cwd: repo, maxBuffer: 100 * 1024 * 1024 });
execFileSync("tar", ["-xf", "-", "-C", pinned], { input: archive });
symlinkSync(join(repo, "node_modules"), join(pinned, "node_modules"));
autoloadEnv();
const configuredEnv: NodeJS.ProcessEnv = {};
for (const key of ["NLM_EMBED_PROVIDER", "NLM_EMBED_BASE_URL", "NLM_EMBED_MODEL", "NLM_EMBED_API_KEY", "NLM_OLLAMA_URL", "NLM_BUNDLED_MODEL_DIR"]) {
  if (process.env[key] !== undefined) configuredEnv[key] = process.env[key];
}
function source(code: string, dbPath: string, candidate: boolean): string {
  const mod = (p: string) => JSON.stringify(pathToFileURL(join(code, p)).href);
  return `import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { SqliteStorage } from ${mod("src/core/storage/sqlite-storage.ts")};
import { RecallService } from ${mod("src/core/recall/recall-service.ts")};
import { FactRecallService } from ${mod("src/core/recall-facts/fact-recall-service.ts")};
import { recallContextHandler } from ${mod("src/mcp/server.ts")};
import { buildEmbedder } from ${mod("src/llm/build-embedder.ts")};
import { LLMUnreachableError } from ${mod("src/ports/llm-client.ts")};
${candidate ? `import { SqliteSemanticReader } from ${mod("src/core/storage/sqlite-semantic-reader.ts")};` : ""}
const send = (value) => process.stdout.write('BUDGET:'+JSON.stringify(value)+'\\n');
let sql = []; let embeddings = []; let workerSql = []; let mode = 'live';
const live = buildEmbedder();
const llm = new Proxy(live, { get(target, key) {
 if (key === 'embed') return async (...args) => {
  const start = performance.now(); let status = 'failed';
  try { if (mode === 'outage') throw new LLMUnreachableError('injected-outage');
   const result = await target.embed(...args); status = 'ok'; return result;
  } finally { embeddings.push({ms:performance.now()-start,status,usage:null}); }
 };
 if (['classify','complete','rewriteForRecall','nameWorkstream'].includes(String(key))) return async () => { throw new Error('generative call prohibited'); };
 const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
}});
let storage; let deps;
async function open() {
 storage = SqliteStorage.create({dbPath:${JSON.stringify(dbPath)},migrationsDir:${JSON.stringify(join(code, "migrations"))}});
 await storage.init();
 const db = storage.rawDb();
 const prepare = db.prepare.bind(db);
 db.prepare = (query) => {
   const statement = prepare(query);
   return new Proxy(statement, {get(target,key) {
     const value = Reflect.get(target,key);
     if (['all','get','run'].includes(String(key))) return (...args) => {const start=performance.now();try{return value.apply(target,args);}finally{sql.push({ms:performance.now()-start,operation:query.includes("vec_distance_L2(fe.embedding")?"fact_semantic_exact":query.includes("vec_distance_L2(sec.embedding")?"session_semantic_exact":query.includes("embedding MATCH")?"semantic_knn":query.includes("facts_fts")?"fact_keyword":query.includes("sessions_fts")?"session_keyword":"other"});}};
     return typeof value === 'function' ? value.bind(target) : value;
   }});
 };
 ${candidate ? `await storage.sessions.semanticReader.close();
 const reader = new SqliteSemanticReader(db.name, (lane,ms) => workerSql.push({lane,ms}));
 storage.sessions.semanticReader = reader;
 const { SqliteFactStore } = await import(${mod("src/core/storage/sqlite-fact-store.ts")});
 const factStore = new SqliteFactStore(db, reader);` : "const factStore = storage.facts;"}
 deps = {store:storage.sessions,factStore,workstreams:{store:storage.workstreams,sessions:storage.sessions,facts:factStore,exemplars:storage.exemplars},
 recall:new RecallService({store:storage.sessions,llm}),factRecall:new FactRecallService({factStore,llm})};
}
await open();
const scope = storage.rawDb().prepare("SELECT workstream_id id, COUNT(*) n FROM sessions WHERE tenant_id = ? AND workstream_id IS NOT NULL GROUP BY workstream_id ORDER BY n DESC LIMIT 1").get('team_local');
send({ready:true,scope:scope?.id});
try {
 for await (const line of createInterface({input:process.stdin})) {
  const input=JSON.parse(line); mode=input.model??'live';
  if(input.reset){await storage.close();await open();}
  sql=[];embeddings=[];workerSql=[];
  const start=performance.now();
  const results=await Promise.all(input.inputs.map(async (args) => {
   const begin=performance.now();
   const result=await recallContextHandler(deps,'team_local',args);
   return {ms:performance.now()-begin,error:!!result.isError,bundle:result.content[0]?.text};
  }));
  send({ms:performance.now()-start,results,sql,workerSql,embeddings,consumerTokens:null});
 }
} finally {await storage.close();}
`;
}
interface RunResult { ms: number; results: { ms: number; error: boolean; bundle: string }[]; sql: { ms: number; operation: string }[]; workerSql: { lane: string; ms: number }[]; embeddings: { ms: number; status: string }[] }
async function openArm(name: string, code: string, candidate: boolean) {
  const dir = join(out, name);
  for (const path of ["home/.claude/projects", "home/.codex/sessions", "home/.pi/agent/sessions", "data/muse/sessions", "config", "cache", "state", "tmp"]) mkdirSync(join(dir, path), { recursive: true });
  const db = join(dir, "canonical.sqlite");
  copyFileSync(resolve(snapshot!), db, constants.COPYFILE_FICLONE); chmodSync(db, 0o600);
  const runner = join(dir, "runner.mts"); writeFileSync(runner, source(code, db, candidate), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(repo, "node_modules/tsx/dist/loader.mjs")).href, runner], {
    cwd: code, stdio: ["pipe", "pipe", "pipe"], env: { ...isolatedArmEnvironment(dir, process.env), ...configuredEnv, TSX_TSCONFIG_PATH: join(code, "tsconfig.json") },
  });
  let pending: { resolve: (x: unknown) => void; reject: (e: Error) => void } | undefined;
  const received: unknown[] = [];
  let failure: Error | undefined;
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("BUDGET:")) return;
    const value: unknown = JSON.parse(line.slice(7));
    if (pending) { const waiter = pending; pending = undefined; waiter.resolve(value); } else received.push(value);
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", (status) => { failure = new Error(`arm ${name} exited ${status}`); pending?.reject(failure); resolve(); });
    child.on("error", (error) => { failure = error; pending?.reject(error); resolve(); });
  });
  const next = async (): Promise<unknown> => {
    if (received.length) return received.shift();
    if (failure) throw failure;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([new Promise((resolve, reject) => { pending = { resolve, reject }; }),
        new Promise((_, reject) => { timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`arm ${name} exceeded 60 second watchdog`)); }, 60_000); })]);
    } finally { clearTimeout(timer!); }
  };
  try {
    const ready = await next() as { ready?: boolean; scope?: string };
    if (!ready.ready) throw new Error("arm initialization failed");
    return { scope: ready.scope, async run(args: unknown): Promise<RunResult> { child.stdin.write(JSON.stringify(args) + "\n"); return await next() as RunResult; },
      async close() { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGTERM"), 10_000); await exited; clearTimeout(timer); writeFileSync(join(dir, "stderr.log"), stderr, { mode: 0o600 }); } };
  } catch (error) { child.kill("SIGTERM"); await exited; writeFileSync(join(dir, "stderr.log"), stderr, { mode: 0o600 }); throw error; }
}
const arms: Partial<Record<"baseline" | "candidate", Awaited<ReturnType<typeof openArm>>>> = {};
const records: { stratum: string; workload: string; repetition: number; arm: string; result: RunResult }[] = [];
const query = "SQLite retrieval memory workstream";
const percentile = (values: number[], p: number) => [...values].sort((a,b)=>a-b)[Math.max(0, Math.ceil(values.length*p)-1)] ?? null;
try {
  arms.baseline = await openArm("baseline", pinned, false);
  arms.candidate = await openArm("candidate", repo, true);
  const workloads = [
    { name: "default-broad", args: { query } },
    { name: "hybrid-both", args: { query, mode: "hybrid" } },
    { name: "hybrid-scoped", args: { query, mode: "hybrid", workstream: arms.baseline.scope } },
  ];
  const runPair = async (stratum: string, workload: typeof workloads[number], repetition: number, model = "live", count = 1, reset = false, record = true) => {
    for (const arm of (repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) as ("baseline" | "candidate")[]) {
      const result = await arms[arm]!.run({ inputs: Array.from({length:count},()=>workload.args), model, reset });
      if (record) {
        const row = {stratum, workload:workload.name,repetition,arm,result}; records.push(row);
        appendFileSync(join(out,"measurements.jsonl"),JSON.stringify(row)+"\n",{mode:0o600});
      }
    }
  };
  for (const workload of workloads) {
    console.log(JSON.stringify({phase:"steady",workload:workload.name}));
    for(let i=0;i<5;i++) await runPair("warmup",workload,i,"live",1,false,false);
    for(let i=0;i<30;i++) await runPair("steady",workload,i);
  }
  for (const [stratum, model, count, reset, repetitions] of [["cold-connection","live",1,true,6],["injected-outage","outage",1,false,30],["loaded-four","live",4,false,30]] as const) {
    console.log(JSON.stringify({phase:stratum}));
    for(let i=0;i<5;i++) await runPair("warmup",workloads[1]!,i,model,count,reset,false);
    for(let i=0;i<repetitions;i++) await runPair(stratum,workloads[1]!,i,model,count,reset);
  }
} finally {
  await Promise.all(Object.values(arms).map((arm)=>arm.close()));
  const summary: Record<string,unknown> = {};
  for(const row of records) {
    const key = `${row.stratum}/${row.workload}/${row.arm}`;
    if (summary[key]) continue;
    const selected=records.filter((r)=>`${r.stratum}/${r.workload}/${r.arm}`===key);
    const times=selected.flatMap((r)=>r.result.results.map((x)=>x.ms));
    const sql=selected.flatMap((r)=>r.result.sql.map((x)=>x.ms)); const worker=selected.flatMap((r)=>r.result.workerSql.map((x)=>x.ms));
    summary[key]={n:times.length,p50:percentile(times,.5),p95:percentile(times,.95),max:percentile(times,1),errors:selected.flatMap((r)=>r.result.results).filter((x)=>x.error).length,
      mainSqlP95:percentile(sql,.95),mainSqlMax:percentile(sql,1),workerSqlP95:percentile(worker,.95),workerSqlMax:percentile(worker,1),embeddingCalls:selected.flatMap((r)=>r.result.embeddings).length,
      embeddingFailures:selected.flatMap((r)=>r.result.embeddings).filter((e)=>e.status!=="ok").length,
      embeddingP50:percentile(selected.flatMap((r)=>r.result.embeddings.map((e)=>e.ms)),.5),
      embeddingP95:percentile(selected.flatMap((r)=>r.result.embeddings.map((e)=>e.ms)),.95),
      declaredModeUnavailable:selected.flatMap((r)=>r.result.results).filter((x)=>{try{return !!JSON.parse(x.bundle).modeUnavailable;}catch{return false;}}).length,
      coverageAbsentResponses:selected.flatMap((r)=>r.result.results).filter((x)=>{try{return !JSON.parse(x.bundle).coverage;}catch{return true;}}).length,
      incompleteResponses:selected.flatMap((r)=>r.result.results).filter((x)=>{try{const c=JSON.parse(x.bundle).coverage;return c&&(c.facts!=="complete"||c.sessions!=="complete");}catch{return true;}}).length,
      sqlOperations:Object.fromEntries([...new Set(selected.flatMap((r)=>r.result.sql.map((x)=>x.operation)))].map((operation)=>{
        const times=selected.flatMap((r)=>r.result.sql.filter((x)=>x.operation===operation).map((x)=>x.ms));
        return [operation,{n:times.length,p95:percentile(times,.95),max:percentile(times,1)}];
      }))};
  }
  const comparisons=records.filter((r)=>r.arm==="baseline").map((row)=>{
    const candidate=records.find((r)=>r.arm==="candidate"&&r.stratum===row.stratum&&r.workload===row.workload&&r.repetition===row.repetition);
    const evidence=(text:string)=>{try{const b=JSON.parse(text);return JSON.stringify({facts:b.facts,sessions:b.sessions});}catch{return text;}};
    const recordCounts = row.result.results.map((result, i) => {
      const baseline = result.error ? {} : JSON.parse(result.bundle);
      const candidateResult = candidate?.result.results[i];
      const next = !candidateResult || candidateResult.error ? {} : JSON.parse(candidateResult.bundle);
      return Object.fromEntries(["facts", "sessions"].map((lane) => {
        const before = new Set<string>((baseline[lane] ?? []).map((x: {id:string}) => x.id));
        const after = new Set<string>((next[lane] ?? []).map((x: {id:string}) => x.id));
        return [lane, { baseline: before.size, candidate: after.size, omittedBaseline: [...before].filter((id) => !after.has(id)).length,
          addedCandidate: [...after].filter((id) => !before.has(id)).length }];
      }));
    });
    return {stratum:row.stratum,workload:row.workload,repetition:row.repetition,recordCounts,equalEvidence:!!candidate&&row.result.results.every((r,i)=>!r.error&&!candidate.result.results[i]!.error&&evidence(r.bundle)===evidence(candidate.result.results[i]!.bundle))};
  });
  const report={base,candidate:"working tree",candidateSourceHash,candidateSourceChangedDuringRun:sourceHash()!==candidateSourceHash,snapshot:resolve(snapshot),host:hostname(),loadavg:loadavg(),createdAt:new Date().toISOString(),summary,comparisons,consumerTokens:null,supportedAnswerAccuracy:null,
    limitations:["Actual pinned prior handler; both arms use isolated empty transcript roots and disposable snapshot clones before migrations.","Cold means fresh connections/workers, not flushed OS/model cache.","Outage is deterministic injected provider failure, not a live gateway outage.","Loaded stratum is four concurrent full requests in one executor process.","Embedding attempts use only the preconfigured gateway; no generative calls. Provider token usage unavailable.","Evidence equality is a preservation diagnostic, not independently adjudicated supported-answer accuracy. No speed promotion from this report alone.","Worker SQL durations are reported on completed reads only; cancelled native reads may outlive response settlement until worker exit."]};
  writeFileSync(join(out,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({summary, unequalEvidence:comparisons.filter((x)=>!x.equalEvidence).length,privateReport:join(out,"report.json")}));
  // Each disposable database and code archive is owned by this benchmark; keep only reports/runners.
  for (const name of ["baseline", "candidate"]) for (const suffix of ["", "-wal", "-shm"]) rmSync(join(out,name,"canonical.sqlite"+suffix),{force:true});
  rmSync(pinned,{recursive:true,force:true});
}
