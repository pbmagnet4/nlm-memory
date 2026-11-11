import { useEffect, useState } from "react";

export interface IngestHealth {
  adapters: Record<string, { pending: number; parked: number; unreadable: number; oldest_pending_at: string | null }>;
  last_success_at: string | null;
  last_progress_at: string | null;
  timeouts_1h: number;
  errors_1h: number;
  lagging: boolean;
  summary: string;
}

/** Polls /api/health/ingest every `pollMs` while mounted. Null until the first success and after any failed poll, so stale health is never shown. */
export function useIngestHealth(pollMs: number): IngestHealth | null {
  const [health, setHealth] = useState<IngestHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch("/api/health/ingest");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const next = (await r.json()) as IngestHealth;
        if (!cancelled) setHealth(next);
      } catch {
        // Daemon restarting or health not wired: clear, the next poll recovers.
        if (!cancelled) setHealth(null);
      }
    }
    void check();
    const id = window.setInterval(() => void check(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);
  return health;
}
