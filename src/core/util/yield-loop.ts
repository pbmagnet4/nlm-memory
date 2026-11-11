/**
 * Hand the event loop one turn.
 *
 * better-sqlite3 is synchronous, so any loop over rows is a single synchronous
 * slice as far as the HTTP server is concerned: a chunked scan that never yields
 * stalls a waiting prompt-recall hook exactly as long as an unchunked one. The
 * batched jobs (re-derivation recompute, corpus stats, and everything T679 fixes)
 * interleave `await yieldToEventLoop()` between batches; one `setImmediate` is
 * enough because everything already queued in the poll phase — socket reads,
 * pending responses — runs before the continuation does.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
