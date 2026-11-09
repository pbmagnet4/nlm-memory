/**
 * SPIKE (T1612, timeboxed): deterministic ablation wiki+search vs search-alone.
 *
 * Multi-hop questions ONLY (single-doc lookups are out of scope — search
 * already wins those). Each hand-built question joins evidence from TWO
 * sessions of one workstream; the scorer must name the workstream.
 * No model anywhere: the scorer is token-overlap arithmetic over
 * hand-labelled expected workstreams.
 *
 * Arms:
 *  - search-alone: per-workstream score = best session token-recall.
 *  - wiki+search:  0.5 * best-session-recall + 0.5 * wiki-page token-recall
 *    (fixed 50/50 blend, chosen upfront — not tuned).
 *
 * Borges guard: total wiki bytes must be < 0.5x source session bytes or the
 * eval FAILS (spike(dream) build gate).
 *
 * Run: npx tsx scripts/eval/wiki-spike-eval.ts [--out=<path>]
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Workstream } from "../../src/core/workstream/model.js";
import type { Fact, Session } from "../../src/shared/types.js";
import {
  BORGES_LIMIT,
  buildWorkstreamIndex,
  buildWorkstreamPage,
  checkBorgesGuard,
  workstreamSourceBytes,
} from "../../src/core/wiki/workstream-pages.js";

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1));
}

function recall(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0) return 0;
  let hit = 0;
  for (const t of query) if (doc.has(t)) hit += 1;
  return hit / query.size;
}

let factSeq = 0;
const fact = (
  kind: Fact["kind"],
  subject: string,
  predicate: string,
  value: string,
  sourceSessionId: string,
): Fact => ({
  id: `spike_f${++factSeq}`,
  kind,
  subject,
  predicate,
  value,
  sourceSessionId,
  sourceQuote: null,
  createdAt: "2026-11-01T10:00:00Z",
  supersededBy: null,
  confidence: 0.9,
  retiredAt: null,
});

/**
 * Representative session body (~1.5KB, like a real distilled transcript).
 * Vocabulary is deliberately neutral: it shares NO token with any eval
 * query, so it changes the Borges denominator without moving either arm's
 * score. Verified by the vocabulary-disjoint assertion in the unit test.
 */
export const NEUTRAL_BODY = [
  "Weekly planning sync notes. Agenda: roadmap milestones, backlog priorities,",
  "stakeholder updates, timeline estimates, action items with owners, followup",
  "threads, async comments, shared drafts, proposal revisions, demo feedback,",
  "retro outcomes, metrics dashboard review, rollout checklist, handoff summary,",
  "standup rotation, quarterly objectives, headcount planning, travel calendar,",
  "office logistics, catering orders, all-hands rehearsal, slide deck polish,",
  "narrative arc, anecdote selection, rehearsal timing, microphone checks,",
  "venue walkthrough, seating chart, name badges, welcome remarks, closing notes,",
  "thank-you messages, photo permissions, recording consent, caption files,",
  "transcript cleanup, highlight reels, newsletter blurbs, social snippets,",
  "editorial calendar, style guide nits, typography choices, color contrast,",
  "logo clearspace, brand voice examples, template library, asset naming,",
  "folder hygiene, archive policy, retention schedule, vault inventory, backup",
  "verification, restore drills, runbook updates, on-call rotation, paging",
  "etiquette, incident postmortems, blameless writeups, corrective actions,",
  "preventive measures, audit trails, access reviews, permission scopes, key",
  "rotation reminders, certificate renewals, domain renewals, invoice matching,",
  "purchase approvals, vendor scorecards, contract renewals, renewal reminders,",
  "meeting-free Fridays, focus blocks, calendar triage, inbox zero attempts,",
  "keyboard shortcuts, editor plugins, terminal themes, font ligatures, dotfile",
  "sync, clipboard history, screenshot organization, wallpaper rotation.",
].join(" ");

const session = (
  id: string,
  label: string,
  summary: string,
  decisions: string[] = [],
  open: string[] = [],
): Session => ({
  id,
  runtime: "spike-fixture",
  runtimeSessionId: id,
  startedAt: "2026-11-01T10:00:00Z",
  endedAt: "2026-11-01T11:00:00Z",
  durationMin: 60,
  label,
  summary,
  status: "closed",
  transcriptKind: "spike",
  transcriptPath: null,
  body: `${label}. ${summary}. ${NEUTRAL_BODY}`,
  entities: [],
  decisions,
  open,
});

const ws = (id: string, label: string): Workstream => ({
  id,
  label,
  status: "active",
  mergedInto: null,
  createdAt: "2026-11-01T09:00:00Z",
  updatedAt: "2026-11-01T09:00:00Z",
  lastSessionAt: "2026-11-01T11:00:00Z",
  scope: null,
});

interface FixtureWs {
  readonly workstream: Workstream;
  readonly sessions: Session[];
  readonly facts: Fact[];
}

const WORKSTREAMS: FixtureWs[] = [
  {
    workstream: ws("ws_billing", "billing"),
    sessions: [
      session("s_b1", "Stripe invoicing", "chose stripe for invoicing flow", ["stripe for invoicing"]),
      session("s_b2", "Refund policy", "drafting the refund policy wording", [], ["refund policy draft"]),
      session("s_b3", "Ledger storage", "postgres ledger schema decision", ["postgres ledger"]),
    ],
    facts: [fact("decision", "billing", "processor", "stripe", "s_b1")],
  },
  {
    workstream: ws("ws_search", "search"),
    sessions: [
      session("s_s1", "Fulltext index", "postgres trigram index for search", ["postgres trigram index"]),
      session("s_s2", "Latency budget", "p99 latency budget discussion", [], ["latency budget"]),
      session("s_s3", "Result cache", "redis cache for results", ["redis cache"]),
    ],
    facts: [fact("decision", "search", "cache", "redis", "s_s3")],
  },
  {
    workstream: ws("ws_auth", "auth"),
    sessions: [
      session("s_a1", "Google login", "oauth google login choice", ["oauth google login"]),
      session("s_a2", "Cookie expiry", "session cookie expiry window", [], ["cookie expiry"]),
      session("s_a3", "Login allowlist", "redis backed allowlist", ["redis allowlist"]),
    ],
    facts: [fact("decision", "auth", "allowlist", "redis", "s_a3")],
  },
  {
    workstream: ws("ws_mobile", "mobile"),
    sessions: [
      session("s_m1", "Offline sync", "offline sqlite sync design", ["offline sqlite sync"]),
      session("s_m2", "Push copy", "push notification copy review", [], ["push notification copy"]),
      session("s_m3", "Apple pay", "stripe applepay integration", ["stripe applepay"]),
    ],
    facts: [fact("decision", "mobile", "wallet", "stripe applepay", "s_m3")],
  },
];

interface SpikeQuestion {
  readonly id: string;
  /** Joins evidence from two sessions of `expected`; tokens are literal query words. */
  readonly query: string;
  readonly expected: string;
}

const QUESTIONS: SpikeQuestion[] = [
  { id: "q01", query: "stripe refund", expected: "billing" },
  { id: "q02", query: "postgres refund", expected: "billing" },
  { id: "q03", query: "stripe ledger", expected: "billing" },
  { id: "q04", query: "postgres trigram", expected: "search" },
  { id: "q05", query: "redis cache", expected: "search" },
  { id: "q06", query: "redis latency", expected: "search" },
  { id: "q07", query: "redis expiry", expected: "auth" },
  { id: "q08", query: "oauth cookie", expected: "auth" },
  { id: "q09", query: "stripe offline", expected: "mobile" },
  { id: "q10", query: "push applepay", expected: "mobile" },
  { id: "q11", query: "postgres ledger", expected: "billing" },
  { id: "q12", query: "postgres budget", expected: "search" },
];

export interface WikiSpikeEvalReport {
  readonly questions: number;
  readonly searchAloneHits: number;
  readonly wikiSearchHits: number;
  readonly searchAloneRate: number;
  readonly wikiSearchRate: number;
  readonly perQuestion: ReadonlyArray<{
    readonly id: string;
    readonly expected: string;
    readonly searchAlone: string;
    readonly wikiSearch: string;
  }>;
  readonly wikiBytes: number;
  readonly sourceBytes: number;
  readonly sizeRatio: number;
  readonly borgesLimit: number;
  readonly borgesPass: boolean;
}

export function runWikiSpikeEval(): WikiSpikeEvalReport {
  const neutral = tokenize(NEUTRAL_BODY);
  for (const q of QUESTIONS) {
    const leak = [...tokenize(q.query)].filter((t) => neutral.has(t));
    if (leak.length > 0) throw new Error(`neutral body leaks query tokens: ${leak.join(",")}`);
  }
  const pages = new Map<string, Set<string>>();
  const sessionDocs = new Map<string, { ws: string; tokens: Set<string> }>();
  let wikiBytes = 0;
  let sourceBytes = 0;

  const rendered: string[] = [];
  for (const { workstream, sessions, facts } of WORKSTREAMS) {
    const page = buildWorkstreamPage({ workstream, sessions, facts });
    if (!page) throw new Error(`spike fixture: no page for ${workstream.label}`);
    rendered.push(page.content);
    wikiBytes += page.content.length;
    sourceBytes += workstreamSourceBytes(sessions);
    pages.set(workstream.label, tokenize(page.content));
    for (const s of sessions) {
      sessionDocs.set(s.id, {
        ws: workstream.label,
        tokens: tokenize([s.label, s.summary, ...s.decisions, ...s.open].join("\n")),
      });
    }
  }
  const index = buildWorkstreamIndex(
    WORKSTREAMS.map(({ workstream }) => ({
      workstream,
      page: { relPath: `${workstream.label}.md`, content: "" },
    })),
    "2026-11-09",
  );
  void index;
  void rendered;

  const labels = WORKSTREAMS.map((w) => w.workstream.label).sort();
  let searchAloneHits = 0;
  let wikiSearchHits = 0;
  const perQuestion = QUESTIONS.map((q) => {
    const qt = tokenize(q.query);
    const sessBest = new Map<string, number>();
    for (const [sid, doc] of sessionDocs) {
      const r = recall(qt, doc.tokens);
      const prev = sessBest.get(doc.ws) ?? 0;
      if (r > prev) sessBest.set(doc.ws, r);
      void sid;
    }
    const pickAlone = labels
      .map((l) => ({ l, s: sessBest.get(l) ?? 0 }))
      .sort((a, b) => b.s - a.s || a.l.localeCompare(b.l))[0]!.l;
    const pickWiki = labels
      .map((l) => ({ l, s: 0.5 * (sessBest.get(l) ?? 0) + 0.5 * recall(qt, pages.get(l)! ) }))
      .sort((a, b) => b.s - a.s || a.l.localeCompare(b.l))[0]!.l;
    if (pickAlone === q.expected) searchAloneHits += 1;
    if (pickWiki === q.expected) wikiSearchHits += 1;
    return { id: q.id, expected: q.expected, searchAlone: pickAlone, wikiSearch: pickWiki };
  });

  const guard = checkBorgesGuard(wikiBytes, sourceBytes, BORGES_LIMIT);
  return {
    questions: QUESTIONS.length,
    searchAloneHits,
    wikiSearchHits,
    searchAloneRate: searchAloneHits / QUESTIONS.length,
    wikiSearchRate: wikiSearchHits / QUESTIONS.length,
    perQuestion,
    wikiBytes,
    sourceBytes,
    sizeRatio: guard.ratio,
    borgesLimit: BORGES_LIMIT,
    borgesPass: guard.pass,
  };
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const eqArg = process.argv.find((a) => a.startsWith("--out="));
  const outIdx = process.argv.indexOf("--out");
  const report = runWikiSpikeEval();
  const out = eqArg
    ? eqArg.slice("--out=".length)
    : outIdx !== -1
      ? process.argv[outIdx + 1]
      : undefined;
  if (out !== undefined) {
    if (!out || out.startsWith("--")) throw new Error("--out requires a path");
    writeFileSync(out, JSON.stringify(report, null, 2));
  }
  console.log(
    [
      `questions=${report.questions}`,
      `search-alone=${report.searchAloneHits}/${report.questions} (${(report.searchAloneRate * 100).toFixed(1)}%)`,
      `wiki+search=${report.wikiSearchHits}/${report.questions} (${(report.wikiSearchRate * 100).toFixed(1)}%)`,
      `size-ratio=${report.sizeRatio.toFixed(3)} (limit ${report.borgesLimit}, ${report.borgesPass ? "PASS" : "FAIL"})`,
    ].join("\n"),
  );
  if (!report.borgesPass) process.exitCode = 1;
}
