import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";

interface ClassifierInfo {
  provider: string;
  model: string;
  available_providers: string[];
  env_present: Record<string, boolean>;
  default_models: Record<string, string[]>;
  embedder: { provider: string; model: string; dims: number };
}

export function SettingsClassifierPage() {
  const [info, setInfo] = useState<ClassifierInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState<string>("");
  const [draftModel, setDraftModel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/classifier/info");
      const data = (await r.json()) as ClassifierInfo;
      setInfo(data);
      setDraftProvider(data.provider);
      setDraftModel(data.model);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const modelOptions = useMemo(() => {
    if (!info) return [];
    return info.default_models[draftProvider] ?? [];
  }, [info, draftProvider]);

  const dirty = info ? draftProvider !== info.provider || draftModel !== info.model : false;
  const canSave = dirty && draftModel.length > 0 && !busy &&
    (draftProvider !== "deepseek" || (info?.env_present["deepseek"] ?? false));

  const save = async () => {
    setBusy(true);
    setSaveMsg(null);
    try {
      const r = await fetch("/api/classifier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: draftProvider, model: draftModel }),
      });
      const data = (await r.json()) as { provider?: string; model?: string; error?: string };
      if (!r.ok || data.error) {
        setSaveMsg(`Error: ${data.error ?? r.statusText}`);
      } else {
        setSaveMsg(`Active: ${data.provider} · ${data.model}`);
        await load();
      }
    } catch (e) {
      setSaveMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Classifier</h2>
      {!info && !error && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      {info && (
        <>
          <dl className="kv-list">
            <dt className="kv-label">Active provider</dt>
            <dd className="kv-value mono">{info.provider}</dd>
            <dt className="kv-label">Active model</dt>
            <dd className="kv-value mono">{info.model}</dd>
          </dl>

          <h3 className="section-title">Switch model</h3>
          <div className="form-row">
            <label className="form-label">Provider</label>
            <select
              className="form-input form-input-inline"
              value={draftProvider}
              onChange={(e) => {
                const p = e.target.value;
                setDraftProvider(p);
                const opts = info.default_models[p] ?? [];
                if (opts[0]) setDraftModel(opts[0]);
              }}
              disabled={busy}
            >
              {info.available_providers.map((p) => (
                <option key={p} value={p} disabled={!info.env_present[p]}>
                  {p}{info.env_present[p] ? "" : " (no API key)"}
                </option>
              ))}
            </select>
            <label className="form-label">Model</label>
            <select
              className="form-input form-input-inline"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              disabled={busy}
            >
              {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              {!modelOptions.includes(draftModel) && draftModel && (
                <option value={draftModel}>{draftModel}</option>
              )}
            </select>
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => void save()}
              disabled={!canSave}
            >{busy ? "Saving…" : "Save"}</button>
            {saveMsg && <span className="muted small">{saveMsg}</span>}
          </div>
          <p className="muted small">Swap takes effect on the next scheduler tick — no daemon restart needed.</p>

          <h3 className="section-title">Embedder</h3>
          <dl className="kv-list">
            <dt className="kv-label">Provider</dt>
            <dd className="kv-value mono">{info.embedder.provider}</dd>
            <dt className="kv-label">Model</dt>
            <dd className="kv-value mono">{info.embedder.model}</dd>
            <dt className="kv-label">Dimensions</dt>
            <dd className="kv-value mono">{info.embedder.dims}</dd>
          </dl>
          <p className="muted small">Embedder is fixed at build time — recall vectors must match the index dims, so it isn't hot-swappable. DeepSeek has no embeddings endpoint; Ollama serves both classification (optional) and embedding (always).</p>

          <h3 className="section-title">Available providers</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>API key present</th>
                <th>Default models</th>
              </tr>
            </thead>
            <tbody>
              {info.available_providers.map((p) => (
                <tr key={p}>
                  <td className="mono">{p}</td>
                  <td>
                    <span className={`chip-inline ${info.env_present[p] ? "status-active" : "status-stale"}`}>
                      {info.env_present[p] ? "yes" : "no"}
                    </span>
                  </td>
                  <td className="mono small">
                    {(info.default_models[p] ?? []).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
