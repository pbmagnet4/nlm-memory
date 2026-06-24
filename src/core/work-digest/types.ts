/** A half-open-ish activity interval in epoch milliseconds (end >= start). */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** One session's in-day message timestamps plus its resolved topic. */
export interface SessionActivity {
  readonly sessionId: string;
  readonly topic: string;
  readonly timestampsMs: ReadonlyArray<number>;
  readonly workstreamId?: string | null;
}

/** Attention: active minutes attributed to one topic. `meta` is an opaque
 *  extension seam (Section 7.1 of the design) — NLM core never reads it. */
export interface TopicShare {
  readonly topic: string;
  readonly activeMinutes: number;
  readonly share: number;
  readonly meta?: Record<string, unknown>;
}

export interface FocusStats {
  readonly contextSwitches: number;
  readonly longestBlockMin: number;
  readonly deepWorkRatio: number;
  readonly projectsTouched: number;
}

export interface ProgressStats {
  readonly decisions: ReadonlyArray<string>;
  readonly openLoops: ReadonlyArray<string>;
}

export interface Coverage {
  readonly sessions: number;
  readonly activeTimeMeasured: number;
  readonly activeTimeSkipped: number;
}

export interface WorkDigest {
  readonly date: string;
  readonly idleThresholdMin: number;
  readonly scopeNote: string;
  readonly coverage: Coverage;
  readonly activeMinutes: number;
  readonly byTopic: ReadonlyArray<TopicShare>;
  readonly focus: FocusStats;
  readonly progress: ProgressStats;
}
