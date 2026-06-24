import type { Interval, SessionActivity, TopicShare, FocusStats } from "./types.js";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function countIn(ts: ReadonlyArray<number>, iv: Interval): number {
  let n = 0;
  for (const t of ts) if (t >= iv.start && t <= iv.end) n++;
  return n;
}

/**
 * Attribute each merged active interval to a topic and derive attention +
 * focus. v1 uses dominant-session attribution: the whole interval goes to the
 * session with the most messages in it (the bounded simplification over
 * fractional splitting documented in the design). Focus is derived from the
 * ordered, attributed segments: adjacent same-topic segments collapse into
 * blocks; a topic change between blocks is one context switch.
 */
export function attribute(
  merged: ReadonlyArray<Interval>,
  sessions: ReadonlyArray<SessionActivity>,
  opts: { deepBlockMin: number },
): { byTopic: TopicShare[]; focus: FocusStats } {
  const segments: Array<{ topic: string; minutes: number; workstreamId: string | null }> = [];
  for (const iv of merged) {
    const minutes = (iv.end - iv.start) / 60_000;
    let best: SessionActivity | undefined;
    let bestN = -1;
    for (const s of sessions) {
      const n = countIn(s.timestampsMs, iv);
      if (n > bestN) {
        bestN = n;
        best = s;
      }
    }
    segments.push({ topic: best ? best.topic : "uncategorized", minutes, workstreamId: best?.workstreamId ?? null });
  }

  const totalMin = segments.reduce((t, s) => t + s.minutes, 0);

  const byTopicMap = new Map<string, number>();
  for (const seg of segments) byTopicMap.set(seg.topic, (byTopicMap.get(seg.topic) ?? 0) + seg.minutes);

  const wsByTopic = new Map<string, string>();
  for (const seg of segments) if (seg.workstreamId && !wsByTopic.has(seg.topic)) wsByTopic.set(seg.topic, seg.workstreamId);

  const byTopic: TopicShare[] = [...byTopicMap.entries()]
    .map(([topic, mins]) => {
      const wsId = wsByTopic.get(topic);
      return {
        topic,
        activeMinutes: round1(mins),
        share: totalMin ? round2(mins / totalMin) : 0,
        ...(wsId ? { meta: { workstream_id: wsId } } : {}),
      };
    })
    .sort((a, b) => b.activeMinutes - a.activeMinutes);

  const blocks: Array<{ topic: string; minutes: number }> = [];
  for (const seg of segments) {
    const last = blocks[blocks.length - 1];
    if (last && last.topic === seg.topic) last.minutes += seg.minutes;
    else blocks.push({ topic: seg.topic, minutes: seg.minutes });
  }

  const contextSwitches = Math.max(0, blocks.length - 1);
  const longestBlockMin = blocks.reduce((mx, b) => Math.max(mx, b.minutes), 0);
  const deepMin = blocks
    .filter((b) => b.minutes >= opts.deepBlockMin)
    .reduce((t, b) => t + b.minutes, 0);
  const deepWorkRatio = totalMin ? round2(deepMin / totalMin) : 0;

  return {
    byTopic,
    focus: {
      contextSwitches,
      longestBlockMin: round1(longestBlockMin),
      deepWorkRatio,
      projectsTouched: byTopicMap.size,
    },
  };
}
