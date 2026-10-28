import { useEffect, useState } from "react";

export interface IngestHealth {
  adapters: Record<string, { pending: number; parked: number; oldest_pending_at: string | null }>;
  last_success_at: string | null;
  last_progress_at: string | null;
  timeouts_1h: number;
  errors_1h: number;
  lagging: boolean;
  summary: string;
}

/** Polls /api/health/ingest every `pollMs` while mounted. Null until the first success; failed polls keep the last value. */
export function useIngestHealth(pollMs: number): IngestHealth | null {
  const [health, setHealth] = useState<IngestHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch("/api/health/ingest");
        if (!r.ok) return;
        const next = (await r.json()) as IngestHealth;
        if (!cancelled) setHealth(next);
      } catch {
        // The daemon may be restarting; the next poll recovers.
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
