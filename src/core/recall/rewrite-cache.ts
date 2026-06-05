/**
 * Bounded in-memory TTL cache for query rewrites.
 *
 * Same raw query within the TTL window reuses the prior LLM rewrite —
 * avoids burning ~hundreds-of-ms per repeated call when an agent hammers
 * `recall_sessions` with slightly different phrasings of the same intent.
 *
 * Bounded by max entries (LRU eviction) AND TTL (lazy expiry on read).
 * No background timer — entries are checked at read time and dropped if
 * expired, which keeps the cache zero-cost when idle.
 */

import type { RewriteResult } from "@ports/llm-client.js";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Entry {
  readonly result: RewriteResult;
  readonly expiresAt: number;
}

export class RewriteCache {
  private readonly store = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(opts: { readonly maxEntries?: number; readonly ttlMs?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  get(rawQuery: string, now: number = Date.now()): RewriteResult | null {
    const key = normalize(rawQuery);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return null;
    }
    // LRU touch: re-insert so this key is now the most recent.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.result;
  }

  set(rawQuery: string, result: RewriteResult, now: number = Date.now()): void {
    const key = normalize(rawQuery);
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { result, expiresAt: now + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

function normalize(s: string): string {
  // Case-insensitive, whitespace-collapsed key — "PGVector  thing" hits the
  // same cache slot as "pgvector thing".
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
