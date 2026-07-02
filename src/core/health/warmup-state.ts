interface WarmupState {
  fts5: boolean;
  textEmbedder: boolean;
}

const state: WarmupState = { fts5: false, textEmbedder: false };

export function markWarm(stage: keyof WarmupState): void {
  state[stage] = true;
}

export function warmupSnapshot(): { fts5: boolean; textEmbedder: boolean; ready: boolean } {
  return { fts5: state.fts5, textEmbedder: state.textEmbedder, ready: state.fts5 && state.textEmbedder };
}

export function resetWarmupState(): void {
  state.fts5 = false;
  state.textEmbedder = false;
}
