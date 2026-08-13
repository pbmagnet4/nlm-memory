export type EmbedFailureKind = "chunk" | "fact";

const state: Record<EmbedFailureKind, number> = { chunk: 0, fact: 0 };

export function recordEmbedFailure(kind: EmbedFailureKind): void {
  state[kind] += 1;
}

export function embedFailureSnapshot(): Readonly<Record<EmbedFailureKind, number>> {
  return Object.freeze({ ...state });
}

export function resetEmbedFailureForTests(): void {
  state.chunk = 0;
  state.fact = 0;
}
