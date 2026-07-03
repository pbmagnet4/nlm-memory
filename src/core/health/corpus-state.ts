import type { CorpusStats } from "@core/metrics/corpus-stats.js";

export interface CorpusSnapshot extends CorpusStats {
  readonly state: "ok" | "warn" | "alert";
  readonly lastComputedAt: string;
}

let snapshot: CorpusSnapshot | null = null;

export function setCorpusSnapshot(s: CorpusSnapshot): void {
  snapshot = s;
}

export function corpusSnapshot(): CorpusSnapshot | null {
  return snapshot;
}

export function resetForTests(): void {
  snapshot = null;
}
