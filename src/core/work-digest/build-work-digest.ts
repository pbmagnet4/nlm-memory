import type { SessionStore } from "@ports/session-store.js";
import { activeSpans } from "./active-spans.js";
import { mergeIntervals } from "./merge-active.js";
import { attribute } from "./attribute.js";
import { readTranscriptTimestamps } from "./read-transcript-timestamps.js";
import { defaultTopicProvider, workstreamTopicProvider, type TopicProvider } from "./topics.js";
import { resolveWorkstreamId } from "@core/workstream/resolve.js";
import type { Interval, SessionActivity, WorkDigest } from "./types.js";

const SCOPE_NOTE = "Agent-assisted active time. Excludes meetings and work without an agent.";

export interface BuildWorkDigestDeps {
  readonly store: Pick<SessionStore, "listByDateRange">;
  readonly topicProvider?: TopicProvider;
  readonly idleThresholdMin?: number;
  readonly deepBlockMin?: number;
  readonly readTimestamps?: (path: string, fromMs: number, toMs: number) => number[];
  readonly workstreams?: Pick<import("@ports/workstream-store.js").WorkstreamStore, "listAll">;
}

/** Local-midnight window for `date` (YYYY-MM-DD) in the process timezone. */
function dayWindow(date: string): { fromMs: number; toMs: number; fromIso: string; toIso: string } {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromMs: from.getTime(), toMs: to.getTime(), fromIso: from.toISOString(), toIso: to.toISOString() };
}

export async function buildWorkDigest(deps: BuildWorkDigestDeps, tenantId: string, date: string): Promise<WorkDigest> {
  const idleThresholdMin = deps.idleThresholdMin ?? 5;
  const deepBlockMin = deps.deepBlockMin ?? 25;
  const topicProvider = deps.topicProvider ?? defaultTopicProvider;
  const readTs = deps.readTimestamps ?? readTranscriptTimestamps;

  const provider = deps.workstreams ? workstreamTopicProvider(topicProvider) : topicProvider;
  const wsList = deps.workstreams ? await deps.workstreams.listAll() : [];
  const wsById = new Map(wsList.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const wsLabel = new Map(wsList.map((w) => [w.id, w.label]));
  function resolveWs(id: string | null | undefined): { id: string; label: string } | null {
    if (!id) return null;
    const live = resolveWorkstreamId(id, wsById);
    const label = wsLabel.get(live);
    return label ? { id: live, label } : null;
  }

  const { fromMs, toMs, fromIso, toIso } = dayWindow(date);
  const sessions = await deps.store.listByDateRange(tenantId, fromIso, toIso);

  const activities: SessionActivity[] = [];
  const allSpans: Interval[] = [];
  const decisions = new Set<string>();
  const openLoops = new Set<string>();
  let measured = 0;
  let skipped = 0;

  for (const s of sessions) {
    for (const d of s.decisions) decisions.add(d);
    for (const o of s.open) openLoops.add(o);

    const timestampsMs = s.transcriptPath ? readTs(s.transcriptPath, fromMs, toMs) : [];
    if (timestampsMs.length === 0) {
      skipped++;
      continue;
    }
    measured++;
    const ws = resolveWs(s.workstreamId);
    const topic = provider({ entities: s.entities, label: s.label, ...(ws ? { workstreamLabel: ws.label } : {}) });
    activities.push({ sessionId: s.id, topic, timestampsMs, ...(ws ? { workstreamId: ws.id } : {}) });
    for (const span of activeSpans(timestampsMs, idleThresholdMin)) allSpans.push(span);
  }

  const { merged, totalMinutes } = mergeIntervals(allSpans);
  const { byTopic, focus } = attribute(merged, activities, { deepBlockMin });

  return {
    date,
    idleThresholdMin,
    scopeNote: SCOPE_NOTE,
    coverage: { sessions: sessions.length, activeTimeMeasured: measured, activeTimeSkipped: skipped },
    activeMinutes: Math.round(totalMinutes * 10) / 10,
    byTopic,
    focus,
    progress: { decisions: [...decisions], openLoops: [...openLoops] },
  };
}
