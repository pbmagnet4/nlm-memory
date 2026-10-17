// sqlite-vec v0.1.9 rejects k > 4096; verified against the installed extension.
const NATIVE_K_LIMIT = 4096;

/** Stop only when unseen global neighbors cannot affect eligible top-k (including ties). */
export function completeSemanticTopK<Candidate extends { distance: number }, Hit extends { distance: number }>(
  k: number,
  fetch: (window: number) => readonly Candidate[],
  eligibleTopK: (candidates: readonly Candidate[]) => readonly Hit[],
  exactFallback: () => readonly Hit[],
): readonly Hit[] {
  let window = Math.min(NATIVE_K_LIMIT, k * 4);
  while (true) {
    const candidates = fetch(window);
    const hits = eligibleTopK(candidates);
    const kth = hits[k - 1];
    if (candidates.length < window || (kth !== undefined && candidates.at(-1)!.distance > kth.distance)) return hits;
    if (window === NATIVE_K_LIMIT) return exactFallback();
    window = Math.min(NATIVE_K_LIMIT, window * 2);
  }
}
