export interface FactEmbedSnapshot {
  readonly active: number;
  readonly missing: number;
  readonly pending: number;
  readonly missingShare: number;
  readonly thresholdShare: number;
  readonly alarm: boolean;
  readonly computedAt: string;
}

let snapshot: FactEmbedSnapshot | null = null;

export function setFactEmbedSnapshot(s: FactEmbedSnapshot): void {
  snapshot = s;
}

export function factEmbedSnapshot(): FactEmbedSnapshot | null {
  return snapshot;
}

export function resetFactEmbedStateForTests(): void {
  snapshot = null;
}
