import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { fmt } from "../../lib/format.js";
import { useIngestHealth } from "../../lib/ingest-health.js";
import {
  fetchProviders,
  fetchProviderModels,
  testProvider,
  PROVIDER_KIND_LABEL,
  type ProviderRow,
  type TestResult,
} from "../../lib/registries.js";

type TuningSource = "setting" | "env" | "default";

interface Tuned<T> { value: T; source: TuningSource }

interface Tuning {
  thinking: Tuned<"off" | "on">;
  timeout_ms: Tuned<number>;
  max_tokens: Tuned<number>;
}

type TuningField = keyof Tuning;

interface TuningDraft { thinking: string; timeout_s: string; max_tokens: string }

const INGEST_PANEL_POLL_MS = 30_000;

function draftFromTuning(t: Tuning): TuningDraft {
  return {
    thinking: t.thinking.value,
    timeout_s: String(t.timeout_ms.value / 1000),
    max_tokens: String(t.max_tokens.value),
  };
}

/** Only changed controls are sent; a cleared (blank) control sends null, which falls back to env/default. */
function tuningPatch(t: Tuning, d: TuningDraft): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = {};
  const current = draftFromTuning(t);
  if (d.thinking !== current.thinking) patch.thinking = d.thinking;
  if (d.timeout_s !== current.timeout_s) patch.timeout_ms = d.timeout_s.trim() === "" ? null : Math.round(Number(d.timeout_s) * 1000);
  if (d.max_tokens !== current.max_tokens) patch.max_tokens = d.max_tokens.trim() === "" ? null : Number(d.max_tokens);
  return patch;
}

interface ClassifierInfo {
  provider: string;
  model: string;
  tuning: Tuning;
  embedder: { provider: string; model: string; dims: number };
}

/**
 * The daemon's active classifier only ever reports "openai" (ClassifierBox
 * has one generic OpenAI-compatible provider), but a Providers-registry row
 * for the same endpoint may be kind "openai" (real OpenAI) or
 * "openai-compatible" (local/self-hosted, e.g. LM Studio) — both ride the
 * same swap path server-side. Treat both as a match for an active "openai"
 * classifier so the right row pre-selects and the dirty-check doesn't fire
 * on page load for a provider that hasn't actually changed.
 */
function providerKindMatchesClassifier(kind: string, classifierProvider: string): boolean {
  if (kind === classifierProvider) return true;
  if (classifierProvider === "openai") return kind === "openai-compatible";
  return false;
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
  const [tuningDraft, setTuningDraft] = useState<TuningDraft | null>(null);
  const [tuningMsg, setTuningMsg] = useState<string | null>(null);
  const [tuningBusy, setTuningBusy] = useState(false);
  const health = useIngestHealth(INGEST_PANEL_POLL_MS);

  const load = useCallback(async () => {
    try {
      const [infoRes, list] = await Promise.all([
        fetch("/api/classifier/info").then((r) => r.json() as Promise<ClassifierInfo>),
        fetchProviders(),
      ]);
      setInfo(infoRes);
      setTuningDraft(draftFromTuning(infoRes.tuning));
      setProviders(list);
      const active = list.find((p) => providerKindMatchesClassifier(p.kind, infoRes.provider) && p.enabled);
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
    ? !providerKindMatchesClassifier(draftProvider.kind, info.provider) || draftModel !== info.model
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

  const putTuning = async (patch: Record<string, string | number | null>) => {
    setTuningBusy(true);
    setTuningMsg(null);
    try {
      const r = await fetch("/api/classifier/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await r.json()) as { tuning?: Tuning; error?: string };
      if (!r.ok || !data.tuning) {
        setTuningMsg(`Error: ${data.error ?? r.statusText}`);
      } else {
        const tuning = data.tuning;
        setInfo((prev) => (prev ? { ...prev, tuning } : prev));
        setTuningDraft(draftFromTuning(tuning));
        setTuningMsg("Saved");
      }
    } catch (e) {
      setTuningMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTuningBusy(false);
    }
  };

  const tuningPatchNow = info && tuningDraft ? tuningPatch(info.tuning, tuningDraft) : {};
  const tuningDirty = Object.keys(tuningPatchNow).length > 0;
  const maxTokensIgnored = info?.provider === "ollama";

  const sourceBadge = (field: TuningField) => {
    if (!info) return null;
    const source = info.tuning[field].source;
    return (
      <>
        <span className="source-badge" data-source={source}>{source}</span>
        {source === "setting" && (
          <button
            type="button"
            className="btn small"
            onClick={() => void putTuning({ [field]: null })}
            disabled={tuningBusy}
          >Reset</button>
        )}
      </>
    );
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

          <h3 className="section-title">Tuning</h3>
          {tuningDraft && (
            <>
              <div className="form-row">
                <label className="form-label">Thinking</label>
                <select
                  className="form-input form-input-inline"
                  value={tuningDraft.thinking}
                  onChange={(e) => setTuningDraft({ ...tuningDraft, thinking: e.target.value })}
                  disabled={tuningBusy}
                >
                  <option value="off">off</option>
                  <option value="on">on</option>
                </select>
                {sourceBadge("thinking")}
              </div>
              <div className="form-row">
                <label className="form-label">Timeout (s)</label>
                <input
                  className="form-input form-input-inline"
                  type="number"
                  min={10}
                  max={900}
                  step={1}
                  value={tuningDraft.timeout_s}
                  onChange={(e) => setTuningDraft({ ...tuningDraft, timeout_s: e.target.value })}
                  disabled={tuningBusy}
                />
                {sourceBadge("timeout_ms")}
              </div>
              <div className="form-row">
                <label className="form-label">Max tokens</label>
                <input
                  className="form-input form-input-inline"
                  type="number"
                  min={256}
                  max={65536}
                  step={1}
                  value={tuningDraft.max_tokens}
                  onChange={(e) => setTuningDraft({ ...tuningDraft, max_tokens: e.target.value })}
                  disabled={tuningBusy || maxTokensIgnored}
                />
                {sourceBadge("max_tokens")}
              </div>
              {maxTokensIgnored && <p className="muted small">The ollama provider ignores max tokens.</p>}
              <div className="form-row">
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => void putTuning(tuningPatchNow)}
                  disabled={!tuningDirty || tuningBusy}
                >{tuningBusy ? "Saving…" : "Save tuning"}</button>
                {tuningMsg && (
                  <span className={`small ${tuningMsg.startsWith("Error") ? "form-error" : "muted"}`}>{tuningMsg}</span>
                )}
              </div>
              <p className="muted small">Clear a field and save to fall back to the env or default value.</p>
            </>
          )}

          <h3 className="section-title">Ingest health</h3>
          {!health ? (
            <p className="muted small">Ingest health unavailable.</p>
          ) : (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Runtime</th>
                    <th className="right">Pending</th>
                    <th className="right">Parked</th>
                    <th className="right">Oldest pending</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(health.adapters).map(([name, a]) => (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td className="right mono">{fmt.count(a.pending)}</td>
                      <td className="right mono">{fmt.count(a.parked)}</td>
                      <td className="right mono">{fmt.age(a.oldest_pending_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="kv-list">
                <dt className="kv-label">Last successful classify</dt>
                <dd className="kv-value mono">{health.last_success_at ? `${fmt.age(health.last_success_at)} ago` : "—"}</dd>
                <dt className="kv-label">Timeouts (1h)</dt>
                <dd className="kv-value mono">{fmt.count(health.timeouts_1h)}</dd>
                <dt className="kv-label">Errors (1h)</dt>
                <dd className="kv-value mono">{fmt.count(health.errors_1h)}</dd>
              </dl>
              <p className="muted small">{health.summary}</p>
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
