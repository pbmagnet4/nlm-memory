import { usePolledEndpoint, relativeTime } from "../lib/api.js";
import type { RecentMarker, RecentRead, RecentWrite } from "../lib/api.js";

const POLL_MS = 3000;

interface ReadsResponse { entries: RecentRead[] }
interface WritesResponse { writes: RecentWrite[] }
interface MarkersResponse { markers: RecentMarker[] }

export function LivePage() {
  const reads = usePolledEndpoint<ReadsResponse>("/api/recall/recent?limit=50", POLL_MS, { entries: [] });
  const writes = usePolledEndpoint<WritesResponse>("/api/live/recent-writes?limit=50", POLL_MS, { writes: [] });
  const markers = usePolledEndpoint<MarkersResponse>("/api/live/recent-markers?limit=50", POLL_MS, { markers: [] });

  return (
    <>
      <div className="live-grid">
        <Column title="Reads" count={reads.entries.length}>
          {reads.entries.map((r, i) => (
            <div className="row" key={`${r.ts}-${i}`}>
              <span className="badge">{r.source}</span>
              <span className="label">{r.query || <em style={{ color: "var(--text-dim)" }}>(empty)</em>}</span>
              <div className="body">
                {r.mode} · {r.nResults} hit{r.nResults === 1 ? "" : "s"}
                <span className="ts" style={{ marginLeft: 8 }}>{relativeTime(r.ts)}</span>
              </div>
            </div>
          ))}
          {reads.entries.length === 0 && <div className="placeholder">no recent recall</div>}
        </Column>

        <Column title="Writes" count={writes.writes.length}>
          {writes.writes.map((w) => (
            <div className="row" key={w.id}>
              <span className="badge">{w.runtime.split("/")[0]}</span>
              <span className="label">{w.label}</span>
              <div className="body">{w.summary}</div>
              <div className="ts">{relativeTime(w.createdAt)} · {w.id}</div>
            </div>
          ))}
          {writes.writes.length === 0 && <div className="placeholder">no recent writes</div>}
        </Column>

        <Column title="Decisions" count={markers.markers.length}>
          {markers.markers.map((m, i) => (
            <div className="row" key={`${m.sessionId}-${i}`}>
              <span className={`badge ${m.kind}`}>{m.kind}</span>
              <span className="label">{m.text}</span>
              <div className="body">{m.label}</div>
              <div className="ts">{relativeTime(m.createdAt)}</div>
            </div>
          ))}
          {markers.markers.length === 0 && <div className="placeholder">no recent decisions</div>}
        </Column>
      </div>
      <StatusBar />
    </>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="column">
      <header className="column-head">
        <h2>{title}</h2>
        <span className="count">{count}</span>
      </header>
      <div className="column-body">{children}</div>
    </section>
  );
}

function StatusBar() {
  return (
    <div className="status-bar">
      <span>polling every {POLL_MS / 1000}s</span>
      <span>nle-memory · phase F live</span>
    </div>
  );
}
