import { useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { useDataset } from "../../lib/dataset.js";
import { postAction } from "../../lib/actions.js";

const LABEL_OPTIONS = ["candidate", "project", "tool", "contact", "service", "concept"];

export function SettingsLabelsPage() {
  const { data, loading, error, refetch } = useDataset();
  const [filter, setFilter] = useState("");
  const [busyEntity, setBusyEntity] = useState<string | null>(null);
  const entities = data?.entities ?? [];
  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return entities;
    return entities.filter((e) => e.canonical.toLowerCase().includes(q) || e.type.toLowerCase().includes(q));
  }, [entities, filter]);

  const mutate = async (entity: string, fn: () => Promise<void>) => {
    setBusyEntity(entity);
    try {
      await fn();
      await refetch();
    } finally {
      setBusyEntity(null);
    }
  };

  const relabel = (entity: string, newType: string) =>
    mutate(entity, () =>
      postAction({ kind: "label_entity", subject_type: "entity", subject_id: entity, payload: { new_type: newType } }).then(() => {}),
    );

  const retire = (entity: string) =>
    mutate(entity, () =>
      postAction({ kind: "retire_entity", subject_type: "entity", subject_id: entity }).then(() => {}),
    );

  const snooze = (entity: string) => {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    return mutate(entity, () =>
      postAction({ kind: "snooze", subject_type: "entity", subject_id: entity, payload: { snoozed_until: until } }).then(() => {}),
    );
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="page-header">
        <h2 className="page-title">Labels</h2>
        <input
          className="search-input"
          placeholder="filter entities…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {loading && !data && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Canonical</th>
            <th>Type</th>
            <th>Status</th>
            <th className="right">Sessions</th>
            <th>Last seen</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, 200).map((e) => {
            const busy = busyEntity === e.canonical;
            return (
              <tr key={e.canonical} className={busy ? "row-busy" : ""}>
                <td className="canonical">
                  <span className="dot" style={{ background: data?.entity_colors[e.canonical] ?? "#666" }} />
                  {e.canonical}
                </td>
                <td>
                  <select
                    className="form-input form-input-inline"
                    value={LABEL_OPTIONS.includes(e.type) ? e.type : "candidate"}
                    onChange={(ev) => void relabel(e.canonical, ev.target.value)}
                    disabled={busy}
                  >
                    {LABEL_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </td>
                <td><span className={`chip-inline status-${e.status}`}>{e.status}</span></td>
                <td className="right mono">{e.session_count}</td>
                <td className="mono small">{e.last_seen_session ?? "—"}</td>
                <td className="row-actions">
                  <button type="button" className="chip" disabled={busy} onClick={() => void snooze(e.canonical)}>snooze 30d</button>
                  <button type="button" className="chip" disabled={busy} onClick={() => void retire(e.canonical)}>retire</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length > 200 && <p className="muted small">Showing first 200 of {filtered.length}.</p>}
      <p className="muted small">Changes are append-only actions; refresh re-applies the overlay over the persisted store.</p>
    </div>
  );
}
