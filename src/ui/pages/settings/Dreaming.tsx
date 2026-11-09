import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { fmt } from "../../lib/format.js";
import {
  fetchProviders,
  fetchProviderModels,
  testProvider,
  PROVIDER_KIND_LABEL,
  type ProviderRow,
  type TestResult,
} from "../../lib/registries.js";

type DreamApplyMode = "dry-run" | "apply";
type DreamPassName = "contradiction" | "dedup";

interface DreamPassSettings {
  enabled: boolean;
  cadenceMs: number;
  sampleSize: number;
  maxInFlight: number;
  applyMode: DreamApplyMode;
}

interface DreamSettings {
  model: string;
  contradiction: DreamPassSettings;
  dedup: DreamPassSettings;
}

interface DreamRunRecord {
  name: DreamPassName;
  ranAt: string;
  summary: Record<string, unknown>;
}

interface DreamLastRuns {
  contradiction: DreamRunRecord | null;
  dedup: DreamRunRecord | null;
}

const MS_PER_MINUTE = 60_000;

const PASS_NAMES: readonly DreamPassName[] = ["contradiction", "dedup"];
const PASS_TITLE: Record<DreamPassName, string> = {
  contradiction: "Contradiction pass",
  dedup: "Dedup pass",
};

/* Pass drafts hold raw control strings; a patch only carries fields the
   user actually changed, and number fields must parse to positive integers
   (the API rejects anything else and changes nothing). */

interface PassDraft { enabled: string; cadence_min: string; sample_size: string; apply_mode: string }

function draftFromPass(p: DreamPassSettings): PassDraft {
  return {
    enabled: p.enabled ? "true" : "false",
    cadence_min: String(Math.round(p.cadenceMs / MS_PER_MINUTE)),
    sample_size: String(p.sampleSize),
    apply_mode: p.applyMode,
  };
}

function positiveInt(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface PassEdit { patch: Record<string, boolean | number | string>; invalid: boolean }

function passEdit(current: DreamPassSettings, d: PassDraft): PassEdit {
  const base = draftFromPass(current);
  const patch: Record<string, boolean | number | string> = {};
  let invalid = false;
  if (d.enabled !== base.enabled) patch.enabled = d.enabled === "true";
  if (d.cadence_min !== base.cadence_min) {
    const n = positiveInt(d.cadence_min);
    if (n === null) invalid = true;
    else patch.cadenceMs = n * MS_PER_MINUTE;
  }
  if (d.sample_size !== base.sample_size) {
    const n = positiveInt(d.sample_size);
    if (n === null) invalid = true;
    else patch.sampleSize = n;
  }
  if (d.apply_mode !== base.apply_mode) patch.applyMode = d.apply_mode;
  return { patch, invalid };
}

function runSummaryText(r: DreamRunRecord): string {
  const s = r.summary["summary"];
  return typeof s === "string" ? s : JSON.stringify(r.summary);
}

export function SettingsDreamingPage() {
  const [settings, setSettings] = useState<DreamSettings | null>(null);
  const [lastRuns, setLastRuns] = useState<DreamLastRuns | null>(null);
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
  const [passDrafts, setPassDrafts] = useState<Record<DreamPassName, PassDraft> | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  const [passMsg, setPassMsg] = useState<Record<DreamPassName, string | null>>({
    contradiction: null,
    dedup: null,
  });

  const applyResult = useCallback((next: DreamSettings, runs: DreamLastRuns) => {
    setSettings(next);
    setLastRuns(runs);
    setPassDrafts({ contradiction: draftFromPass(next.contradiction), dedup: draftFromPass(next.dedup) });
  }, []);

  const load = useCallback(async () => {
    try {
      const [res, list] = await Promise.all([
        fetch("/api/dreaming").then(async (r) => {
          const data = (await r.json()) as { settings?: DreamSettings; lastRuns?: DreamLastRuns; error?: string };
          if (!r.ok || !data.settings || !data.lastRuns) {
            throw new Error(data.error ?? `HTTP ${r.status}`);
          }
          return { settings: data.settings, lastRuns: data.lastRuns };
        }),
        fetchProviders(),
      ]);
      applyResult(res.settings, res.lastRuns);
      setDraftModel(res.settings.model);
      setProviders(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [applyResult]);

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

  const dirty = settings ? draftModel !== settings.model : false;
  const canSave = dirty && draftModel.length > 0 && !busy && testPassed;

  const postDreaming = async (body: Record<string, unknown>): Promise<{ settings: DreamSettings; lastRuns: DreamLastRuns }> => {
    const r = await fetch("/api/dreaming", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as { settings?: DreamSettings; lastRuns?: DreamLastRuns; error?: string };
    if (!r.ok || !data.settings || !data.lastRuns) {
      throw new Error(data.error ?? `HTTP ${r.status}`);
    }
    return { settings: data.settings, lastRuns: data.lastRuns };
  };

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

  const saveModel = async () => {
    setBusy(true);
    setSaveMsg(null);
    try {
      const result = await postDreaming({ model: draftModel });
      applyResult(result.settings, result.lastRuns);
      setSaveMsg(`Active model: ${result.settings.model}`);
    } catch (e) {
      setSaveMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const savePass = async (name: DreamPassName, patch: Record<string, boolean | number | string>) => {
    setPassBusy(true);
    setPassMsg((prev) => ({ ...prev, [name]: null }));
    try {
      const result = await postDreaming({ [name]: patch });
      applyResult(result.settings, result.lastRuns);
      setPassMsg((prev) => ({ ...prev, [name]: "Saved" }));
    } catch (e) {
      setPassMsg((prev) => ({ ...prev, [name]: `Error: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setPassBusy(false);
    }
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Dreaming</h2>
      {!settings && !error && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      {settings && (
        <>
          <dl className="kv-list">
            <dt className="kv-label">Active dream model</dt>
            <dd className="kv-value mono">{settings.model}</dd>
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
                  {draftProviderId === null && <option value="" disabled>Select a provider…</option>}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.enabled}>
                      {p.name} ({PROVIDER_KIND_LABEL[p.kind]}){p.enabled ? "" : " (disabled)"}
                      {p.kind !== "ollama" && !p.hasApiKey ? " (no key)" : ""}
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
                  onClick={() => void saveModel()}
                  disabled={!canSave}
                  title={!testPassed ? "Run a successful test before saving" : undefined}
                >{busy && test?.ok ? "Saving…" : "Save"}</button>
              </div>

              {draftProviderId === null && (
                <p className="muted small">
                  Select a provider to list its models and test the connection. The provider is not stored; only the dream model is saved.
                </p>
              )}
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

          {passDrafts && PASS_NAMES.map((name) => (
            <PassSection
              key={name}
              name={name}
              current={settings[name]}
              draft={passDrafts[name]}
              busy={passBusy}
              msg={passMsg[name]}
              onDraftChange={(d) => setPassDrafts((prev) => (prev ? { ...prev, [name]: d } : prev))}
              onSave={(patch) => void savePass(name, patch)}
            />
          ))}

          <h3 className="section-title">Last runs</h3>
          {!lastRuns ? (
            <p className="muted small">Last-run information unavailable.</p>
          ) : (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Pass</th>
                    <th>Mode</th>
                    <th className="right">Ran</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {PASS_NAMES.map((name) => {
                    const r = lastRuns[name];
                    return (
                      <tr key={name}>
                        <td>{PASS_TITLE[name]}</td>
                        <td className="mono">{r ? String(r.summary["mode"] ?? "—") : "—"}</td>
                        <td className="right mono">{r ? `${fmt.age(r.ranAt)} ago` : "never"}</td>
                        <td className="mono">{r ? runSummaryText(r) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted small">Last runs are tracked in memory since the process started.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PassSection(props: {
  name: DreamPassName;
  current: DreamPassSettings;
  draft: PassDraft;
  busy: boolean;
  msg: string | null;
  onDraftChange: (d: PassDraft) => void;
  onSave: (patch: Record<string, boolean | number | string>) => void;
}) {
  const { name, current, draft, busy, msg, onDraftChange, onSave } = props;
  const edit = passEdit(current, draft);
  const dirty = Object.keys(edit.patch).length > 0;

  return (
    <>
      <h3 className="section-title">{PASS_TITLE[name]}</h3>
      <div className="form-row">
        <label className="form-label">Status</label>
        <select
          className="form-input form-input-inline"
          value={draft.enabled}
          onChange={(e) => onDraftChange({ ...draft, enabled: e.target.value })}
          disabled={busy}
        >
          <option value="true">enabled</option>
          <option value="false">disabled</option>
        </select>
        <label className="form-label">Apply mode</label>
        <select
          className="form-input form-input-inline"
          value={draft.apply_mode}
          onChange={(e) => onDraftChange({ ...draft, apply_mode: e.target.value })}
          disabled={busy}
        >
          <option value="dry-run">dry-run</option>
          <option value="apply">apply</option>
        </select>
      </div>
      <div className="form-row">
        <label className="form-label">Cadence (min)</label>
        <input
          className="form-input form-input-inline"
          type="number"
          min={1}
          step={1}
          value={draft.cadence_min}
          onChange={(e) => onDraftChange({ ...draft, cadence_min: e.target.value })}
          disabled={busy}
        />
        <label className="form-label">Sample size</label>
        <input
          className="form-input form-input-inline"
          type="number"
          min={1}
          step={1}
          value={draft.sample_size}
          onChange={(e) => onDraftChange({ ...draft, sample_size: e.target.value })}
          disabled={busy}
        />
      </div>
      {edit.invalid && <p className="muted error small">Cadence and sample size must be positive whole numbers.</p>}
      <div className="form-row">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => onSave(edit.patch)}
          disabled={!dirty || edit.invalid || busy}
        >{busy ? "Saving…" : `Save ${name} settings`}</button>
        {msg && (
          <span className={`small ${msg.startsWith("Error") ? "form-error" : "muted"}`}>{msg}</span>
        )}
      </div>
      <p className="muted small">
        Cadence and sample size apply on the pass&apos;s next scheduled run. Dry-run reports proposals without changing facts.
      </p>
    </>
  );
}
