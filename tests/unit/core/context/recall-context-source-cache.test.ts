import { describe, expect, it, vi } from "vitest";
import { recallContext, type ContextDeps } from "../../../../src/core/context/recall-context.js";
import type { FactHit, Session } from "../../../../src/shared/types.js";

/**
 * Hybrid recall publishes its fact lane twice — once when the lexical lane finds
 * the hit, once with the merged result — and both publishes hydrate the sources
 * behind them. Both publishes quoting the same fact means hydrate is asked for
 * the same session body twice inside one request. These fixtures drive exactly
 * that shape and count the body reads, so the request-local cache has to earn
 * every one it skips.
 */
const QUOTE = "alpha uses duckdb";
const BODY = `# session\n\n${QUOTE}\n`;
/** Sixteen hex chars — the shape `bodyVersion()` produces. */
const V1 = "aaaaaaaaaaaaaaaa";
const V2 = "bbbbbbbbbbbbbbbb";

function sessionRow(over: Partial<Session> = {}): Session {
  return {
    id: "s1", runtime: "pi", runtimeSessionId: "r1", startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null, durationMin: 1, label: "L", summary: "S", status: "closed",
    transcriptKind: "md", transcriptPath: null, body: "", bodyVersion: null,
    entities: [], decisions: [], open: [], ...over,
  } as Session;
}

/**
 * `anchor: "missing"` never counts as a current assessment, so a quoted fact
 * always asks for the full body; an unquoted fact leaves its source at metadata.
 */
function quotedFact(quote: string | null): FactHit {
  return {
    id: "f1", kind: "attribute", subject: "alpha", predicate: "uses", value: "duckdb",
    sourceSessionId: "s1", sourceQuote: quote, sourceAnchor: { status: "missing" },
    confidence: 0.9, matchScore: 1, matchedIn: [],
  } as unknown as FactHit;
}

interface Harness {
  /** bodyVersion reported by each `getByIds` round; the last entry repeats. */
  readonly metadata?: (string | null | undefined)[];
  /** Rounds whose tenant-scoped metadata read returns nothing at all. */
  readonly hiddenMetadataRounds?: number[];
  /** Body returned by each `getById`; the last entry repeats. */
  readonly bodies?: { body: string; bodyVersion: string | null }[];
  /** Quoted facts handed to each publish (progressive first, final second). */
  readonly facts?: (FactHit | null)[];
}

function setup(opts: Harness) {
  const facts = opts.facts ?? [quotedFact(QUOTE), quotedFact(QUOTE)];
  const metadata = opts.metadata ?? [V1];
  const bodies = opts.bodies ?? [{ body: BODY, bodyVersion: V1 }];
  let metadataRound = 0;
  let readRound = 0;
  const store = {
    getByIds: vi.fn(async () => {
      const round = metadataRound++;
      if (opts.hiddenMetadataRounds?.includes(round)) return [];
      return [sessionRow({ body: "", bodyVersion: metadata[Math.min(round, metadata.length - 1)] })];
    }),
    getById: vi.fn(async () => {
      const round = readRound++;
      const next = bodies[Math.min(round, bodies.length - 1)];
      return sessionRow({ body: next.body, bodyVersion: next.bodyVersion });
    }),
    resolveSuccessors: vi.fn(async () => new Map<string, string>()),
  };
  let publish = 0;
  const deps = {
    recall: {
      search: vi.fn(async () => ({
        query: "alpha", entity: null, kind: null, mode: "hybrid", limit: 4, total: 0, results: [],
      })),
    },
    factRecall: {
      search: vi.fn(async (_tenant: string, _input: unknown, options: Record<string, unknown>) => {
        // Lexical progress publish, exactly as RecallService fires it mid-search.
        await (options.onPartialFacts as (r: { results: FactHit[] }) => Promise<void>)({
          results: [facts[publish++]].filter(Boolean) as FactHit[],
        });
        return {
          query: "alpha", subject: null, predicate: null, kind: null, mode: "hybrid", limit: 12,
          total: 1, results: [facts[publish++]].filter(Boolean) as FactHit[],
        };
      }),
    },
    store,
    now: () => Date.now(),
  } as unknown as ContextDeps;
  const bodyReads = () => (deps.store as unknown as { getById: { mock: { calls: unknown[][] } } }).getById.mock.calls;
  return { deps, store, bodyReads, run: () => recallContext("tenant-a", { query: "alpha", mode: "hybrid" }, deps) };
}

describe("recall_context source hydration cache", () => {
  it("reads a quoted legacy source once when two publishes share it", async () => {
    const { run, bodyReads, store } = setup({});
    const result = await run();
    expect(bodyReads().map((c) => c[1])).toEqual(["s1"]);
    // The metadata re-check is cheap and still runs per publish — the cache
    // skips body reads only, never the version check.
    expect(store.getByIds).toHaveBeenCalledTimes(2);
    expect(result.sources.map((s) => s.body)).toEqual([BODY]);
    expect(result.coverage.facts).toBe("complete");
  });

  it("refetches when the body version moved between publishes", async () => {
    const { run, bodyReads } = setup({
      metadata: [V1, V2],
      bodies: [{ body: BODY, bodyVersion: V1 }, { body: "re-ingested", bodyVersion: V2 }],
    });
    const result = await run();
    expect(bodyReads()).toHaveLength(2);
    expect(result.sources.map((s) => s.body)).toEqual(["re-ingested"]);
  });

  it("refetches a legacy source whose version is null", async () => {
    const { run, bodyReads } = setup({ metadata: [null], bodies: [{ body: BODY, bodyVersion: null }] });
    const result = await run();
    expect(bodyReads()).toHaveLength(2);
    expect(result.sources.map((s) => s.body)).toEqual([BODY]);
  });

  it("counts a hydrated empty body as a read body, not a metadata placeholder", async () => {
    const { run, bodyReads } = setup({ bodies: [{ body: "", bodyVersion: V1 }] });
    const result = await run();
    expect(bodyReads()).toHaveLength(1);
    expect(result.sources.map((s) => s.body)).toEqual([""]);
  });

  it("still reads the body the first time a source is needed for real", async () => {
    // Round one cites the session without a quote, so it stays at metadata
    // (`body: ""`); round two quotes it. The placeholder must not pass for a
    // hydrated empty body.
    const { run, bodyReads } = setup({ facts: [quotedFact(null), quotedFact(QUOTE)] });
    const result = await run();
    expect(bodyReads()).toHaveLength(1);
    expect(result.sources.map((s) => s.body)).toEqual([BODY]);
  });

  it("refetches when the tenant-scoped metadata check stops answering", async () => {
    // The cache is keyed by id alone, so ownership has to be re-proved by the
    // tenant-filtered metadata read. A row that stops coming back is not a
    // version match, and a body never gets handed to a tenant we cannot
    // re-confirm against.
    const { run, bodyReads } = setup({ hiddenMetadataRounds: [1] });
    await run();
    expect(bodyReads()).toHaveLength(2);
    // Both reads went through the tenant-scoped store, not a cache shortcut.
    expect(new Set(bodyReads().map((c) => c[0]))).toEqual(new Set(["tenant-a"]));
  });
});
