/**
 * Daily digest text composer.
 *
 * Pure function: takes the raw shapes the daemon returns and emits the digest
 * body. No I/O, no Telegram, no fetch — those live in the CLI adapter so this
 * module stays unit-testable without HTTP fixtures.
 *
 * The 7-day numbers come from the server-computed stats (`/api/recall/stats`).
 * The 24-hour slice is derived locally from `recent`, because the server's
 * stats window is fixed at 7 days and we want a tighter view for the morning
 * push. Probe/test queries are filtered out of both windows.
 */

import { isProbe } from "../telemetry/probe-filter.js";
import type { OutcomeCoverage } from "../outcome/coverage.js";
import type { JobSnapshot } from "../jobs/job-supervisor.js";

export interface RecallStats {
  readonly total: number;
  readonly hit_rate: number;
  readonly top_queries: ReadonlyArray<{ readonly query: string; readonly count: number }>;
}

export interface RecentEntry {
  readonly ts: string;
  readonly source?: string;
  readonly query?: string | null;
}

/**
 * True cited-precision over hook-surfaced sessions — the honest "was the recall
 * useful" metric, distinct from the surfacing rate. `precisionAtK` is null when
 * no conversations were scoreable in the window (no citations / empty hook-log).
 */
export interface DigestPrecision {
  readonly precisionAtK: number | null;
  readonly conversationCount: number;
}

export interface ComposeInput {
  readonly stats: RecallStats;
  readonly recent: ReadonlyArray<RecentEntry>;
  readonly port: number;
  readonly hookAlert: string | null;
  readonly precision?: DigestPrecision | null;
  /** Tier-B outcome rollup over sessions ended in the last 30 days (#352 phase 2). */
  readonly outcomeCoverage?: OutcomeCoverage | null;
  /**
   * JobSupervisor's reprocess snapshot (#414). Null/absent covers both "never
   * started" and "daemon restarted mid-run" — the supervisor holds no
   * persisted state across restarts, so a fresh process reports `idle` the
   * same as one that never ran, and that's rendered as "no active job".
   */
  readonly job?: JobSnapshot | null;
  /** Override "now" for deterministic tests; defaults to Date.now(). */
  readonly now?: Date;
}

export function composeDigest(input: ComposeInput): string {
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;

  const real24h: RecentEntry[] = [];
  for (const e of input.recent) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (isProbe(e.query)) continue;
    real24h.push(e);
  }

  const sources = new Map<string, number>();
  const queries = new Map<string, number>();
  for (const e of real24h) {
    const src = e.source ?? "?";
    sources.set(src, (sources.get(src) ?? 0) + 1);
    if (e.query) queries.set(e.query, (queries.get(e.query) ?? 0) + 1);
  }
  const sourceStr =
    [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join(" · ") || "none";
  const topQ = [...queries.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // 7-day real-traffic estimate: strip probes from the server's top_queries
  // counters. The server-side top_queries is capped (typically 20) so this is
  // a floor on probe traffic, not an exact subtraction. Good enough to keep
  // the morning numbers honest.
  const probes7d = input.stats.top_queries.reduce(
    (sum, { query, count }) => (isProbe(query) ? sum + count : sum),
    0,
  );
  const total7d = input.stats.total;
  const real7d = Math.max(total7d - probes7d, 0);

  const topLines = topQ.length === 0
    ? "  (none)"
    : topQ.map(([q, _], i) => `  ${i + 1}. ${truncate(q, 80)}`).join("\n");

  const todayStr = formatDay(now);
  const alertBlock = input.hookAlert ? `${input.hookAlert}\n\n` : "";

  return (
    `NLM digest — ${todayStr}\n` +
    `\n` +
    alertBlock +
    `Last 24h (real traffic): ${real24h.length} queries · ${sourceStr}\n` +
    `Last 7d: ${real7d} real / ${total7d} total · surfaced ${pct(input.stats.hit_rate)}\n` +
    `Recall precision (cited/surfaced): ${formatPrecision(input.precision)}\n` +
    `${formatOutcomeCoverage(input.outcomeCoverage)}\n` +
    `${formatJobLine(input.job, now)}\n` +
    `\n` +
    `Top real queries (24h):\n` +
    `${topLines}\n` +
    `\n` +
    `UI: http://localhost:${input.port}/ui/`
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatPrecision(p: DigestPrecision | null | undefined): string {
  if (!p || p.precisionAtK === null) return "n/a (no scored conversations yet)";
  return `${pct(p.precisionAtK)} (${p.conversationCount} conv)`;
}

function formatOutcomeCoverage(c: OutcomeCoverage | null | undefined): string {
  if (!c || c.total === 0) return "tier-b outcomes (30d): no sessions ended in window";
  const share = (n: number) => pct(n / c.total);
  return (
    `tier-b outcomes (30d, ${c.total} sessions): ` +
    `held ${share(c.held)} · overturned ${share(c.overturned)} · built-upon ${share(c.builtUpon)} · ` +
    `re-derived ${share(c.reDerivedLater)} · unobserved ${share(c.unobserved)}`
  );
}

/**
 * One-line reprocess status for the digest. `idle` and the null/absent case
 * render identically ("no active job") — see the `job` field doc above for
 * why a daemon restart mid-run collapses to the same line as never-started.
 */
function formatJobLine(job: JobSnapshot | null | undefined, now: Date): string {
  if (!job) return "Jobs: no active job";
  const { name, processed, total, restarts, restartsTotal, lastAdvanceAt } = job;
  switch (job.state) {
    case "running": {
      const advance = lastAdvanceAt ? `last advance ${formatAgo(lastAdvanceAt, now)}` : "no progress yet";
      // restartsTotal is the lifetime respawn count for this run (never
      // reset by progress, unlike `restarts`) — surfaced only when >0 so an
      // OOM-churning run that keeps making progress between crashes isn't
      // silently indistinguishable from a clean one.
      const restartSuffix =
        restartsTotal > 0 ? `, ${restartsTotal} restart${restartsTotal === 1 ? "" : "s"}` : "";
      return `Jobs: ${name} ${processed}/${total}, ${advance}${restartSuffix}`;
    }
    case "stalled": {
      const advance = lastAdvanceAt ? `last advance ${formatAgo(lastAdvanceAt, now)}` : "no progress yet";
      return `Jobs: ${name} stalled at ${processed}/${total}, ${advance}`;
    }
    case "completed":
      return `Jobs: ${name} completed ${processed}/${total}`;
    case "exhausted":
      // `restarts` at exhaustion already counts the refused final attempt
      // (see job-alert.ts's buildJobAlertEvent) — "fruitless" frames the
      // count as restarts that led nowhere, not restarts still to come.
      return (
        `Jobs: ${name} gave up after ${restarts} fruitless restart${restarts === 1 ? "" : "s"} ` +
        `(${processed}/${total} processed)`
      );
    case "stopped":
      return `Jobs: ${name} stopped at ${processed}/${total}`;
    case "idle":
    default:
      return "Jobs: no active job";
  }
}

function formatAgo(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

function formatDay(d: Date): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]!;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${weekday} ${y}-${m}-${day}`;
}
