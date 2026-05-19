import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDataset, relativeAge } from "../lib/dataset.js";
import type { DatasetSession } from "../lib/dataset.js";

interface SessionDetail {
  id: string;
  label: string;
  summary: string;
  body: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  runtime: string;
  entities: string[];
  decisions: string[];
  open: string[];
}

export function ThreadPage() {
  const { data, loading, error } = useDataset();
  const [params, setParams] = useSearchParams();
  const entity = params.get("entity") ?? "";
  const drawerSid = params.get("session");

  const [sort, setSort] = useState<"recent" | "oldest">(() => {
    try {
      const raw = window.localStorage.getItem("nle.settings.views");
      if (raw) return (JSON.parse(raw) as { threadSort?: "recent" | "oldest" }).threadSort ?? "recent";
    } catch { /* ignore */ }
    return "recent";
  });

  const thread = useMemo(() => {
    if (!data || !entity) return [];
    const sessions = data.sessions.filter((s) => s.entities.includes(entity));
    sessions.sort((a, b) => {
      const av = a.started_at ?? "";
      const bv = b.started_at ?? "";
      return sort === "recent" ? bv.localeCompare(av) : av.localeCompare(bv);
    });
    return sessions;
  }, [data, entity, sort]);

  const entityColor = entity && data ? (data.entity_colors[entity] ?? "#666") : "#666";

  useEffect(() => {
    if (entity && data) document.title = `${entity} — Thread`;
  }, [entity, data]);

  const openSession = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("session", id);
    setParams(next);
  };

  const closeSession = () => {
    const next = new URLSearchParams(params);
    next.delete("session");
    setParams(next);
  };

  if (loading && !data) return <div className="page-pad"><div className="muted">Loading dataset…</div></div>;
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data) return null;

  if (!entity) {
    return (
      <div className="page-pad">
        <h2 className="page-title">Thread</h2>
        <p className="muted">Pick an entity to view its reasoning history.</p>
        <ul className="entity-grid">
          {data.entities.slice(0, 48).map((e) => (
            <li key={e.canonical}>
              <Link to={`/thread?entity=${encodeURIComponent(e.canonical)}`} className="card card-lift entity-card">
                <span className="dot" style={{ background: data.entity_colors[e.canonical] ?? "#666" }} />
                <span className="entity-name">{e.canonical}</span>
                <span className="muted small">{e.session_count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const decisions = thread.flatMap((s) => s.decisions.map((d) => ({ d, sid: s.id, when: s.started_at })));
  const open = thread.flatMap((s) => s.open_questions.map((q) => ({ q: q.text, sid: s.id, when: s.started_at })));

  return (
    <div className="page-pad">
      <div className="thread-header">
        <span className="dot lg" style={{ background: entityColor }} />
        <h2 className="page-title">{entity}</h2>
        <span className="muted">{thread.length} session{thread.length === 1 ? "" : "s"}</span>
        <span className="header-spacer" />
        <select className="form-input" value={sort} onChange={(e) => setSort(e.target.value as "recent" | "oldest")}>
          <option value="recent">Most recent first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      <div className="thread-grid">
        <section className="card">
          <header className="card-head"><h3>Decisions</h3><span className="muted small">{decisions.length}</span></header>
          <ul className="marker-list">
            {decisions.slice(0, 30).map((d, i) => (
              <li key={i} className="marker-row">
                <span className="live-tag" data-kind="decision">decision</span>
                <span className="marker-text">{d.d}</span>
                <button type="button" className="link-button" onClick={() => openSession(d.sid)}>{relativeAge(d.when)}</button>
              </li>
            ))}
            {decisions.length === 0 && <li className="muted small">No decisions captured.</li>}
          </ul>
        </section>

        <section className="card">
          <header className="card-head"><h3>Open questions</h3><span className="muted small">{open.length}</span></header>
          <ul className="marker-list">
            {open.slice(0, 30).map((o, i) => (
              <li key={i} className="marker-row">
                <span className="live-tag" data-kind="open">open</span>
                <span className="marker-text">{o.q}</span>
                <button type="button" className="link-button" onClick={() => openSession(o.sid)}>{relativeAge(o.when)}</button>
              </li>
            ))}
            {open.length === 0 && <li className="muted small">No open questions.</li>}
          </ul>
        </section>
      </div>

      <ThreadSessionList thread={thread} onOpenSession={openSession} />

      {drawerSid && (
        <SessionDrawer sessionId={drawerSid} onClose={closeSession} entityColor={entityColor} />
      )}
    </div>
  );
}

type StatusFilter = "all" | "active" | "idle" | "closed" | "superseded";
type MarkerFilter = "all" | "decisions" | "open";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

function ThreadSessionList({
  thread,
  onOpenSession,
}: {
  thread: DatasetSession[];
  onOpenSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [markers, setMarkers] = useState<MarkerFilter>("all");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return thread.filter((s) => {
      if (status !== "all" && s.status !== status) return false;
      if (markers === "decisions" && s.decisions.length === 0) return false;
      if (markers === "open" && s.open_questions.length === 0) return false;
      if (!q) return true;
      return (
        s.label.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.decisions.some((d) => d.toLowerCase().includes(q)) ||
        s.open.some((o) => o.toLowerCase().includes(q))
      );
    });
  }, [thread, query, status, markers]);

  // Reset page when filter inputs change
  useEffect(() => { setPage(0); }, [query, status, markers, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return (
    <>
      <div className="thread-sessions-head">
        <h3 className="section-title thread-sessions-title">Sessions</h3>
        <input
          className="search-input"
          placeholder="search label, summary, decisions, open…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="thread-filters">
        <div className="filter-group" role="group" aria-label="Status filter">
          {(["all", "active", "idle", "closed", "superseded"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`chip${status === s ? " active" : ""}`}
              data-status={s === "all" ? undefined : s}
              onClick={() => setStatus(s)}
            >{s}</button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="Marker filter">
          {(["all", "decisions", "open"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`chip${markers === m ? " active" : ""}`}
              data-marker={m === "all" ? undefined : m}
              onClick={() => setMarkers(m)}
            >{m === "all" ? "all markers" : m}</button>
          ))}
        </div>
        <span className="header-spacer" />
        <span className="muted small">{filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
      </div>

      <ul className="session-list">
        {slice.map((s) => (
          <li key={s.id} className="session-row session-row-detail clickable" onClick={() => onOpenSession(s.id)}>
            <span className={`chip-inline status-${s.status}`}>{s.status}</span>
            <div className="session-row-main">
              <span className="session-label">{s.label}</span>
              <span className="session-meta">{s.summary}</span>
            </div>
            <span className="muted small mono">{relativeAge(s.started_at)}</span>
          </li>
        ))}
        {slice.length === 0 && (
          <li className="muted small empty-row">
            {thread.length === 0 ? "No sessions yet." : "No sessions match the current filters."}
          </li>
        )}
      </ul>

      {filtered.length > 0 && (
        <div className="pagination">
          <div className="page-size">
            <label className="form-label">Per page</label>
            <select
              className="form-input form-input-inline"
              value={pageSize}
              onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <span className="header-spacer" />
          <span className="muted small">
            {start + 1}–{Math.min(start + pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="page-nav">
            <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage(0)}>« first</button>
            <button type="button" className="chip" disabled={currentPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ prev</button>
            <span className="page-indicator mono">{currentPage + 1} / {pageCount}</span>
            <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>next ›</button>
            <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>last »</button>
          </div>
        </div>
      )}
    </>
  );
}

function SessionDrawer({ sessionId, onClose, entityColor }: { sessionId: string; onClose: () => void; entityColor: string }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(null);
    setError(null);
    fetch(`/api/session/${encodeURIComponent(sessionId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = (await r.json()) as Record<string, unknown>;
        const detail: SessionDetail = {
          id: String(raw["id"] ?? sessionId),
          label: String(raw["label"] ?? ""),
          summary: String(raw["summary"] ?? ""),
          body: String(raw["body"] ?? ""),
          status: String(raw["status"] ?? "closed"),
          startedAt: typeof raw["startedAt"] === "string" ? (raw["startedAt"] as string) : null,
          endedAt: typeof raw["endedAt"] === "string" ? (raw["endedAt"] as string) : null,
          durationMin: typeof raw["durationMin"] === "number" ? (raw["durationMin"] as number) : null,
          runtime: String(raw["runtime"] ?? ""),
          entities: Array.isArray(raw["entities"]) ? (raw["entities"] as string[]) : [],
          decisions: Array.isArray(raw["decisions"]) ? (raw["decisions"] as string[]) : [],
          open: Array.isArray(raw["open"]) ? (raw["open"] as string[]) : [],
        };
        setSession(detail);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="session-drawer" role="dialog" aria-modal="true">
        <header className="drawer-head">
          <span className="dot" style={{ background: entityColor }} />
          <h3 className="drawer-title">{session?.label ?? sessionId}</h3>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {error && <div className="muted error drawer-body">{error}</div>}
        {!session && !error && <div className="muted drawer-body">Loading session…</div>}
        {session && (
          <div className="drawer-body">
            <dl className="kv-list">
              <dt className="kv-label">Status</dt>
              <dd className="kv-value"><span className={`chip-inline status-${session.status}`}>{session.status}</span></dd>
              <dt className="kv-label">Started</dt>
              <dd className="kv-value mono small">{session.startedAt ?? "—"}</dd>
              <dt className="kv-label">Duration</dt>
              <dd className="kv-value">{session.durationMin ?? "—"} min</dd>
              <dt className="kv-label">Runtime</dt>
              <dd className="kv-value mono small">{session.runtime}</dd>
              <dt className="kv-label">Session ID</dt>
              <dd className="kv-value mono small">{session.id}</dd>
            </dl>
            {session.entities.length > 0 && (
              <>
                <h4 className="drawer-section">Entities</h4>
                <div className="entity-chips">
                  {session.entities.map((e) => (
                    <Link key={e} to={`/thread?entity=${encodeURIComponent(e)}`} className="chip">{e}</Link>
                  ))}
                </div>
              </>
            )}
            {session.decisions.length > 0 && (
              <>
                <h4 className="drawer-section">Decisions</h4>
                <ul className="drawer-list">
                  {session.decisions.map((d, i) => <li key={i}><span className="live-tag" data-kind="decision">decision</span> {d}</li>)}
                </ul>
              </>
            )}
            {session.open.length > 0 && (
              <>
                <h4 className="drawer-section">Open questions</h4>
                <ul className="drawer-list">
                  {session.open.map((q, i) => <li key={i}><span className="live-tag" data-kind="open">open</span> {q}</li>)}
                </ul>
              </>
            )}
            {session.summary && (
              <>
                <h4 className="drawer-section">Summary</h4>
                <p className="drawer-paragraph">{session.summary}</p>
              </>
            )}
            {session.body && (
              <>
                <h4 className="drawer-section">Transcript excerpt</h4>
                <pre className="drawer-body-text">{session.body.slice(0, 3000)}{session.body.length > 3000 ? "\n\n[…truncated]" : ""}</pre>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
