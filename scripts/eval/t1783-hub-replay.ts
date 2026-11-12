/**
 * T1783 hub-damping replay — the gate for defaulting NLM_HOOK_HUB_DAMP on.
 *
 * Replays every distinct prompt behind the T1782 eval-set through the real
 * production ranking path IN-PROCESS (extractRecallQuery -> RecallService
 * mode=keyword -> selectHits, the exact hook chain) against a COPY of
 * canonical.sqlite — never the live daemon. Each prompt is selected four ways:
 *
 *   base   pre-T1783 behavior
 *   pen    hubness penalty only (score / (1 + alpha*ln(1+inj14d)))
 *   guard  lexical-zero-overlap floor only
 *   both   shipped combination
 *
 * Injection counts for the penalty are causal: for a fire at time t they are
 * the wouldInject appearances in the hook-log inside [t - 14d, t), fixture
 * fires excluded (same filter as docs/eval/T1783-recall-hubs.md).
 *
 * Metrics (labels >= 2 count as relevant; the eval-set pairs ARE the
 * original injections of their prompt, so every replayed hit that matches a
 * pair is labeled):
 *   precision@<=3  micro = relevant labeled injections / labeled injections
 *                  (unlabeled replay hits cannot be judged and are excluded
 *                  from both sides; macro = mean over prompts with labels)
 *   relevant keep  replayed relevant injections vs. the relevant pairs the
 *                  original fire actually injected (the >5% guardrail)
 *   hub presence   fires where one of the named hubs / the measured top-10
 *                  hubs is in the injected set, plus total hub injections
 *
 * Run: npx tsx scripts/eval/t1783-hub-replay.ts --db=./.eval/canonical.sqlite
 *        [--eval=<eval-set.jsonl>] [--hook-log=~/.nlm/hook-log.jsonl]
 *        [--alpha=0.5] [--floor=2.0] [--json=out.json] [--limit=N]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractRecallQuery } from "../../src/core/hook/query-extract.js";
import { applyHubness, HUB_WINDOW_DAYS } from "../../src/core/hook/hubness.js";
import { selectHits, type RecallHitInput } from "../../src/core/hook/select.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import type { LLMClient } from "../../src/ports/llm-client.js";

const DAY_MS = 86_400_000;
const WINDOW_START = Date.parse("2026-10-15T00:00:00Z");
const RECALL_LIMIT = 5; // src/hook/recall-over-http.ts
// Named in the T1782 evidence as hubs injected into unrelated prompts.
const NAMED_HUBS = new Set([
  "cc_64bcc185-c49d-4517-ab3e-592ad1d1c8b9", // nxtgit session pinning
  "cc_d67f180b-5d7c-4375-a287-9661791cead8", // NLM classifier fix
  "cc_sub_a560c937364b2fa24",                // Plan J
  "ha_20260915_e97617",                      // LinkedIn Easy Apply
]);

interface Args {
  db: string;
  evalSet: string;
  hookLog: string;
  alpha: number;
  floor: number;
  json: string | null;
  limit: number;
  recallLimit: number;
  bornFilter: boolean;
  hubness: "raw" | "distinct";
}
function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: ".eval/canonical.sqlite",
    evalSet: join(homedir(), ".nxtos", "state", "t1782", "eval-set.jsonl"),
    hookLog: join(homedir(), ".nlm", "hook-log.jsonl"),
    alpha: 0.5,
    floor: 2.0,
    json: null,
    limit: 0,
    recallLimit: RECALL_LIMIT,
    bornFilter: true,
    hubness: "raw",
  };
  for (const a of argv) {
    const m = /^--(db|eval|hook-log|alpha|floor|json|limit|recall|born|hubness)=(.*)$/.exec(a);
    if (!m) throw new Error(`unknown arg ${a}`);
    const key = m[1]!;
    const value = m[2]!;
    if (key === "alpha") args.alpha = Number(value);
    else if (key === "floor") args.floor = Number(value);
    else if (key === "limit") args.limit = Number(value);
    else if (key === "recall") args.recallLimit = Math.min(100, Math.max(1, Number(value)));
    else if (key === "born") args.bornFilter = value !== "0" && value !== "false";
    else if (key === "hubness") {
      if (value !== "raw" && value !== "distinct") throw new Error("--hubness must be raw|distinct");
      args.hubness = value;
    }
    else if (key === "db") args.db = value;
    else if (key === "eval") args.evalSet = value;
    else if (key === "hook-log") args.hookLog = value;
    else args.json = value;
  }
  return args;
}

interface Pair {
  ts: string;
  prompt: string;
  memory_id: string;
  relevance: number;
}

function loadPairs(path: string): Pair[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Pair);
}

// Hook-log real fires: entries >= window start, fixture previews dropped,
// matching the Part 1 methodology.
interface Fire { t: number; preview: string; ids: string[] }
function loadFires(path: string): Fire[] {
  const out: Fire[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o["kind"] !== undefined) continue;
    if (typeof o["ts"] !== "string") continue;
    const t = Date.parse(o["ts"]);
    if (!Number.isFinite(t) || t < WINDOW_START) continue;
    if (/nxtos-e2e|fixture/i.test(String(o["promptPreview"] ?? ""))) continue;
    if (!Array.isArray(o["wouldInject"])) continue;
    const ids = o["wouldInject"].filter((x): x is string => typeof x === "string");
    if (ids.length > 0) out.push({ t, preview: String(o["promptPreview"] ?? "").slice(0, 80), ids });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Hubness input at time t. HUBNESS=raw (default): raw injection count in
 * [t-14d, t). HUBNESS=distinct: number of DISTINCT prompt previews the id
 * was injected into — true hubness (near many unrelated prompts), blind to a
 * single recurring automation prompt re-firing the same recall.
 */
function countsAt(fires: Fire[], t: number, distinct: boolean): Map<string, number> {
  const from = t - HUB_WINDOW_DAYS * DAY_MS;
  const counts = new Map<string, number>();
  const seen = distinct ? new Map<string, Set<string>>() : null;
  for (const f of fires) {
    if (f.t >= t) break; // sorted; fires after the eval fire are future information
    if (f.t < from) continue;
    for (const id of f.ids) {
      if (seen) {
        let set = seen.get(id);
        if (!set) {
          set = new Set();
          seen.set(id, set);
        }
        set.add(f.preview);
        counts.set(id, set.size);
      } else {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function topHubSet(fires: Fire[], n: number): Set<string> {
  const counts = new Map<string, number>();
  for (const f of fires) for (const id of f.ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id));
}

// Keyword-only recall never touches the LLM; fail loud if that changes.
const NO_LLM: LLMClient = new Proxy({} as LLMClient, {
  get(_t, prop): never {
    throw new Error(`t1783-replay: unexpected LLM call ${String(prop)} in keyword mode`);
  },
});

interface PromptResult {
  prompt: string;
  baselineSkipped: boolean;
  arms: Record<string, { injected: string[] }>;
}

function selectArm(hits: ReadonlyArray<RecallHitInput>): ReadonlyArray<RecallHitInput> {
  return selectHits({
    hits,
    surfaced: new Set<string>(),
    scoreThreshold: 0,
    relativeFloor: 0.9,
    perFireCap: 3,
    perConversationCap: 10,
  });
}

interface ArmStats {
  promptsWithInjections: number;
  injected: number;
  labeled: number;
  relevant: number;
  macroPrecisions: number[];
  originalsRelevant: number;
  relevantKept: number;
  namedHubFires: number;
  topHubFires: number;
  hubInjections: number; // named ∪ top
}

function newArmStats(): ArmStats {
  return {
    promptsWithInjections: 0, injected: 0, labeled: 0, relevant: 0, macroPrecisions: [],
    originalsRelevant: 0, relevantKept: 0,
    namedHubFires: 0, topHubFires: 0, hubInjections: 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pairs = loadPairs(args.evalSet);
  const fires = loadFires(args.hookLog);
  const topHubs = topHubSet(fires, 10);

  const byPrompt = new Map<string, Pair[]>();
  for (const p of pairs) {
    if (!byPrompt.has(p.prompt)) byPrompt.set(p.prompt, []);
    byPrompt.get(p.prompt)!.push(p);
  }
  let prompts = [...byPrompt.entries()].sort((a, b) => Date.parse(a[1][0]!.ts) - Date.parse(b[1][0]!.ts));
  if (args.limit > 0) prompts = prompts.slice(0, args.limit);

  const storage = SqliteStorage.create({
    dbPath: args.db,
    migrationsDir: join(import.meta.dirname, "..", "..", "migrations"),
  });
  const recall = new RecallService({ store: storage.sessions, llm: NO_LLM });

  const armsOf = ["base", "pen", "guard", "both"] as const;
  type Arm = (typeof armsOf)[number];
  const stats: Record<Arm, ArmStats> = { base: newArmStats(), pen: newArmStats(), guard: newArmStats(), both: newArmStats() };
  const results: PromptResult[] = [];
  let skipped = 0;
  let searchErrors = 0;

  for (const [prompt, pp] of prompts) {
    const labels = new Map(pp.map((p) => [p.memory_id, p.relevance]));
    const originalsRelevant = pp.filter((p) => p.relevance >= 2).map((p) => p.memory_id);
    const t = Date.parse(pp[0]!.ts);
    let hits: ReadonlyArray<RecallHitInput> = [];
    try {
      const extracted = extractRecallQuery(prompt);
      if (extracted !== null) {
        const res = await recall.search(DEFAULT_TEAM_ID, { query: extracted, mode: "keyword", limit: args.recallLimit });
        // Temporal replay: the corpus grew since the October fires; a session
        // that started AFTER the fire could not have been injected then, so
        // drop it (otherwise drift, not the fix, decides the top 3).
        hits = res.results
          .filter((r) => !args.bornFilter || Date.parse(r.startedAt) <= t)
          .map((r) => ({ id: r.id, label: r.label, startedAt: r.startedAt, matchScore: r.matchScore, summary: r.summary }));
      } else {
        skipped++;
      }
    } catch (e) {
      searchErrors++;
      console.error(`search failed for "${prompt.slice(0, 60)}": ${String(e)}`);
    }
    const counts = countsAt(fires, t, args.hubness === "distinct");
    const injected: Record<Arm, string[]> = {
      base: selectArm(hits).map((h) => h.id),
      pen: selectArm(applyHubness(hits, { prompt, injectionCounts: counts, alpha: args.alpha, lexicalFloor: 0 })).map((h) => h.id),
      guard: selectArm(applyHubness(hits, { prompt, injectionCounts: counts, alpha: 0, lexicalFloor: args.floor })).map((h) => h.id),
      both: selectArm(applyHubness(hits, { prompt, injectionCounts: counts, alpha: args.alpha, lexicalFloor: args.floor })).map((h) => h.id),
    };
    results.push({ prompt, baselineSkipped: injected.base.length === 0 && hits.length === 0, arms: { base: { injected: injected.base }, pen: { injected: injected.pen }, guard: { injected: injected.guard }, both: { injected: injected.both } } });

    for (const arm of armsOf) {
      const s = stats[arm];
      const ids = injected[arm];
      if (ids.length > 0) s.promptsWithInjections++;
      let pl = 0;
      let pr = 0;
      for (const id of ids) {
        s.injected++;
        const lab = labels.get(id);
        if (lab !== undefined) {
          s.labeled++;
          pl++;
          if (lab >= 2) {
            s.relevant++;
            pr++;
          }
        }
        if (originalsRelevant.includes(id)) s.relevantKept++;
        if (NAMED_HUBS.has(id) || topHubs.has(id)) s.hubInjections++;
      }
      s.originalsRelevant += originalsRelevant.length;
      if (pl > 0) s.macroPrecisions.push(pr / pl);
      if (ids.some((id) => NAMED_HUBS.has(id))) s.namedHubFires++;
      if (ids.some((id) => topHubs.has(id))) s.topHubFires++;
    }
  }

  const fmt = (arm: Arm) => {
    const s = stats[arm];
    const micro = s.labeled > 0 ? s.relevant / s.labeled : 0;
    const macro = s.macroPrecisions.length > 0
      ? s.macroPrecisions.reduce((a, b) => a + b, 0) / s.macroPrecisions.length
      : 0;
    const keep = s.originalsRelevant > 0 ? s.relevantKept / s.originalsRelevant : 0;
    console.log(
      arm.padEnd(6),
      `microPrec=${(micro * 100).toFixed(1)}%`, `macroPrec=${(macro * 100).toFixed(1)}%`,
      `inj=${s.injected}`, `labeled=${s.labeled}`, `relevant=${s.relevant}`,
      `relKeep=${(keep * 100).toFixed(1)}% (${s.relevantKept}/${s.originalsRelevant})`,
      `namedHubFires=${s.namedHubFires}`, `topHubFires=${s.topHubFires}`, `hubInj=${s.hubInjections}`,
    );
    return {
      arm,
      microPrecision: micro,
      macroPrecision: macro,
      injected: s.injected,
      labeled: s.labeled,
      relevant: s.relevant,
      relevantKeep: keep,
      relevantKept: s.relevantKept,
      originalsRelevant: s.originalsRelevant,
      namedHubFires: s.namedHubFires,
      topHubFires: s.topHubFires,
      hubInjections: s.hubInjections,
    };
  };

  console.log(`prompts=${prompts.length} extractSkips=${skipped} searchErrors=${searchErrors}`);
  console.log(`alpha=${args.alpha} floor=${args.floor} window=${HUB_WINDOW_DAYS}d recallLimit=${args.recallLimit} bornFilter=${args.bornFilter} hubness=${args.hubness}`);
  const out = armsOf.map(fmt);
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ args: { ...args, evalSet: undefined }, prompts: prompts.length, skipped, searchErrors, perPrompt: results, arms: out }, null, 1));
    console.log(`wrote ${args.json}`);
  }
  storage.close();
}

await main();
