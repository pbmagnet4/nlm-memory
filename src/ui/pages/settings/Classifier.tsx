import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import {
  fetchProviders,
  fetchProviderModels,
  testProvider,
  PROVIDER_KIND_LABEL,
  type ProviderRow,
  type TestResult,
} from "../../lib/registries.js";

interface ClassifierInfo {
  provider: string;
  model: string;
  embedder: { provider: string; model: string; dims: number };
}

export function SettingsClassifierPage() {
  const [info, setInfo] = useState<ClassifierInfo | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [draftProviderId, setDraftProviderId] = useState<number | null>(null);
  const [draftModel, setDraftModel] = useState<string>("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [infoRes, list] = await Promise.all([
        fetch("/api/classifier/info").then((r) => r.json() as Promise<ClassifierInfo>),
        fetchProviders(),
      ]);
      setInfo(infoRes);
      setProviders(list);
      const active = list.find((p) => p.kind === infoRes.provider && p.enabled);
      const fallback = list.find((p) => p.enabled) ?? list[0] ?? null;
      const selected = active ?? fallback;
      setDraftProviderId(selected ? selected.id : null);
      setDraftModel(infoRes.model);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const draftProvider = useMemo(
    () => providers.find((p) => p.id === draftProviderId) ?? null,
    [providers, draftProviderId],
  );

  useEffect(() => {
    if (!draftProvider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelsErr(null);
    setModels([]);
    void fetchProviderModels(draftProvider.id)
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        if (!draftModel || !m.includes(draftModel)) {
          setDraftModel(draftProvider.defaultModel ?? m[0] ?? "");
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setModelsErr(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
    // intentionally not gating on draftModel — we only refetch when provider changes
  }, [draftProvider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectionKey = draftProvider ? `${draftProvider.id}|${draftModel}` : "";
  const testPassed = test?.ok === true && testedKey === selectionKey;

  const dirty = info && draftProvider
    ? draftProvider.kind !== info.provider || draftModel !== info.model
    : false;

  const canSave = dirty && draftModel.length > 0 && !busy && testPassed;

  const runTest = async () => {
    if (!draftProvider) return;
    setBusy(true);
    setTest(null);
    setTestedKey(null);
    try {
      const r = await testProvider(draftProvider.id);
      setTest(r);
      if (r.ok) setTestedKey(selectionKey);
    } catch (e) {
      setTest({ ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draftProvider) return;
    setBusy(true);
    setSaveMsg(null);
    try {
      const r = await fetch("/api/classifier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: draftProvider.kind, model: draftModel }),
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
          {providers.length === 0 ? (
            <p className="muted small">
              No providers configured. Add one on the <a href="/settings/providers">Providers</a> page first.
            </p>
          ) : (
            <>
              <div className="form-row">
                <label className="form-label">Provider</label>
                <select
                  className="form-input form-input-inline"
                  value={draftProviderId ?? ""}
                  onChange={(e) => {
                    setDraftProviderId(Number.parseInt(e.target.value, 10));
                    setTest(null);
                    setTestedKey(null);
                  }}
                  disabled={busy}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.enabled}>
                      {p.name} ({PROVIDER_KIND_LABEL[p.kind]}){p.enabled ? "" : " — disabled"}
                      {p.kind !== "ollama" && !p.hasApiKey ? " — no key" : ""}
                    </option>
                  ))}
                </select>
                <label className="form-label">Model</label>
                <select
                  className="form-input form-input-inline"
                  value={draftModel}
                  onChange={(e) => {
                    setDraftModel(e.target.value);
                    setTestedKey(null);
                  }}
                  disabled={busy || models.length === 0}
                >
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  {!models.includes(draftModel) && draftModel && (
                    <option value={draftModel}>{draftModel}</option>
                  )}
                </select>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runTest()}
                  disabled={busy || !draftProvider}
                >{busy && !test ? "Testing…" : "Test connection"}</button>
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => void save()}
                  disabled={!canSave}
                  title={!testPassed ? "Run a successful test before saving" : undefined}
                >{busy && test?.ok ? "Saving…" : "Save"}</button>
              </div>

              {modelsErr && <p className="muted error small">Model list failed: {modelsErr}</p>}
              {test && (
                <p className={`small ${test.ok ? "muted" : "muted error"}`}>
                  {test.ok
                    ? `Connection OK · ${test.modelCount ?? "?"} models · ${test.latencyMs}ms`
                    : `Connection failed: ${test.error ?? "unknown"} (${test.latencyMs}ms)`}
                </p>
              )}
              {saveMsg && <p className="muted small">{saveMsg}</p>}
              <p className="muted small">Save is gated on a passing connection test for the selected provider + model.</p>
            </>
          )}

          <h3 className="section-title">Embedder</h3>
          <dl className="kv-list">
            <dt className="kv-label">Provider</dt>
            <dd className="kv-value mono">{info.embedder.provider}</dd>
            <dt className="kv-label">Model</dt>
            <dd className="kv-value mono">{info.embedder.model}</dd>
            <dt className="kv-label">Dimensions</dt>
            <dd className="kv-value mono">{info.embedder.dims}</dd>
          </dl>
          <p className="muted small">Embedder is fixed at build time. Recall vectors must match the index dims, so it isn't hot-swappable. DeepSeek has no embeddings endpoint; Ollama serves both classification (optional) and embedding (always).</p>
        </>
      )}
    </div>
  );
}
