import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDataset } from "../lib/dataset.js";

type Span = "7d" | "30d" | "90d" | "all";
const SPAN_DAYS: Record<Span, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };

interface HoverState {
  entity: string;
  date: string;
  count: number;
  x: number;
  y: number;
}

interface DragState {
  startX: number;
  rect: DOMRect;
}

export function RiverPage() {
  const { data, loading, error } = useDataset();
  const [span, setSpan] = useState<Span>("30d");
  const [hover, setHover] = useState<HoverState | null>(null);
  const navigate = useNavigate();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragRange, setDragRange] = useState<{ from: number; to: number } | null>(null);

  const view = useMemo(() => {
    if (!data) return null;
    const days = SPAN_DAYS[span];
    const sessions = data.sessions.filter((s) => s.started_at !== null);
    const now = Date.now();
    const filtered = days
      ? sessions.filter((s) => (now - Date.parse(s.started_at!)) / 86_400_000 <= days)
      : sessions;
    const lanes = new Map<string, Map<string, number>>();
    const dateSet = new Set<string>();
    for (const s of filtered) {
      const d = (s.started_at ?? "").slice(0, 10);
      if (!d) continue;
      dateSet.add(d);
      for (const e of s.entities) {
        const inner = lanes.get(e) ?? new Map<string, number>();
        inner.set(d, (inner.get(d) ?? 0) + 1);
        lanes.set(e, inner);
      }
    }
    const dates = [...dateSet].sort();
    const laneRows = [...lanes.entries()]
      .map(([entity, perDate]) => ({
        entity,
        total: [...perDate.values()].reduce((a, b) => a + b, 0),
        perDate,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 24);
    return { dates, laneRows, total: filtered.length };
  }, [data, span]);

  const onCellClick = (entity: string, date: string) => {
    // jump to thread filtered by entity; thread page sorts by recency.
    navigate(`/thread?entity=${encodeURIComponent(entity)}&date=${date}`);
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, rect };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const { startX, rect } = dragRef.current;
    const from = Math.min(startX, e.clientX) - rect.left;
    const to = Math.max(startX, e.clientX) - rect.left;
    if (to - from < 6) {
      setDragRange(null);
      return;
    }
    setDragRange({ from, to });
  };

  const onMouseUp = () => {
    if (!dragRef.current || !dragRange || !view) {
      dragRef.current = null;
      setDragRange(null);
      return;
    }
    // Identify which dates fall inside the drag range. Each cell is 14px wide with 2px gap.
    const cellSize = 14; // 12px cell + 2px gap
    const labelOffset = 206; // 200px lane label + 6px gap
    const startIdx = Math.max(0, Math.floor((dragRange.from - labelOffset) / cellSize));
    const endIdx = Math.min(view.dates.length - 1, Math.floor((dragRange.to - labelOffset) / cellSize));
    if (endIdx <= startIdx) {
      dragRef.current = null;
      setDragRange(null);
      return;
    }
    const startDate = view.dates[startIdx];
    const endDate = view.dates[endIdx];
    if (startDate && endDate) {
      // Compute new span as days between the two dates
      const days = Math.max(1, Math.ceil((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000));
      setSpan(days <= 7 ? "7d" : days <= 30 ? "30d" : days <= 90 ? "90d" : "all");
    }
    dragRef.current = null;
    setDragRange(null);
  };

  if (loading && !data) return <div className="page-pad"><div className="muted">Loading dataset…</div></div>;
  if (error && !data) return <div className="page-pad"><div className="muted error">{error}</div></div>;
  if (!data || !view) return null;

  return (
    <div className="page-pad">
      <div className="river-toolbar">
        <span className="page-title">River</span>
        <span className="muted small">{view.total} sessions · {view.laneRows.length} lanes · {view.dates.length} days</span>
        <span className="header-spacer" />
        {(Object.keys(SPAN_DAYS) as Span[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`ctrl-btn${s === span ? " active" : ""}`}
            onClick={() => setSpan(s)}
          >{s}</button>
        ))}
      </div>

      <div
        className="river-grid card"
        ref={gridRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { dragRef.current = null; setDragRange(null); setHover(null); }}
      >
        {dragRange && (
          <div
            className="river-drag-rect"
            style={{ left: `${dragRange.from}px`, width: `${dragRange.to - dragRange.from}px` }}
          />
        )}
        <div className="river-dates">
          {view.dates.map((d) => (
            <div key={d} className="river-date-cell" title={d}>{d.slice(5)}</div>
          ))}
        </div>
        {view.laneRows.map(({ entity, perDate, total }) => (
          <div key={entity} className="river-lane">
            <button
              type="button"
              className="river-lane-label"
              onClick={() => navigate(`/thread?entity=${encodeURIComponent(entity)}`)}
            >
              <span className="dot" style={{ background: data.entity_colors[entity] ?? "#666" }} />
              <span className="river-lane-name">{entity}</span>
              <span className="muted small">{total}</span>
            </button>
            <div className="river-cells">
              {view.dates.map((d) => {
                const v = perDate.get(d) ?? 0;
                return (
                  <div
                    key={d}
                    className={`river-cell tier-${tier(v)}`}
                    onMouseEnter={(e) => setHover({ entity, date: d, count: v, x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => setHover({ entity, date: d, count: v, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => v > 0 && onCellClick(entity, d)}
                    style={v > 0 ? { cursor: "pointer" } : {}}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {view.laneRows.length === 0 && <div className="muted">No entities in this window.</div>}

      {hover && hover.count > 0 && (
        <div className="river-hover" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <span className="dot" style={{ background: data.entity_colors[hover.entity] ?? "#666" }} />
          <span className="river-hover-name">{hover.entity}</span>
          <span className="muted small">{hover.date} · {hover.count} session{hover.count === 1 ? "" : "s"}</span>
        </div>
      )}
    </div>
  );
}

function tier(v: number): 0 | 1 | 2 | 3 | 4 {
  if (v === 0) return 0;
  if (v === 1) return 1;
  if (v <= 3) return 2;
  if (v <= 6) return 3;
  return 4;
}
