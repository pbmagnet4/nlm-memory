import { useCallback, useEffect, useState } from "react";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { SourceBadge, type ValueSource } from "../../components/SourceBadge.js";
import { confirmAction } from "../../lib/confirm.js";
import { usePolledEndpoint } from "../../lib/api.js";

type LaneName = "prose" | "code";

interface Tuned<T> { value: T; source: ValueSource }

interface Lane {
  lane: LaneName;
  provider: Tuned<string>;
  base_url: Tuned<string | null>;
  model: Tuned<string>;
  api_key_set: boolean;
  api_key_source: ValueSource;
  providers: string[];
  stored: { provider: string; model: string; dim: number } | null;
  reconcile: "match" | "stale" | "recorded" | "unknown";
}

interface RebuildJob {
  state: string;
  processed: number;
  total: number;
  restarts: number;
}

interface EmbedderSettings {
  lanes: Record<LaneName, Lane>;
  rebuild_job: RebuildJob | null;
}

interface Draft { provider: string; base_url: string; model: string; api_key: string }

type Patch = Record<string, string | null>;

const LANE_LABEL: Record<LaneName, string> = { prose: "Prose (sessions, facts, recall)", code: "Code (exemplars)" };
const JOB_POLL_MS = 3_000;

function draftFromLane(l: Lane): Draft {
  return { provider: l.provider.value, base_url: l.base_url.value ?? "", model: l.model.value, api_key: "" };
}

/** Only changed fields are sent; a blank base URL clears the setting. A typed key replaces the stored one. */
function draftPatch(l: Lane, d: Draft): Patch {
  const current = draftFromLane(l);
  const patch: Patch = {};
  if (d.provider !== current.provider) patch["provider"] = d.provider;
  if (d.model !== current.model) patch["model"] = d.model;
  if (d.base_url !== current.base_url) patch["base_url"] = d.base_url.trim() === "" ? null : d.base_url.trim();
  if (d.api_key !== "") patch["api_key"] = d.api_key;
  return patch;
}

interface PutResponse {
  error?: string;
  requires_reembed?: boolean;
  stored?: { provider: string; model: string; dim: number };
  candidate?: { provider: string; model: string; dim: number };
}

function lanePhrase(c: { provider: string; model: string; dim: number }): string {
  return `${c.provider} / ${c.model} @ ${c.dim}`;
}

export function SettingsEmbedderPage() {
  const [settings, setSettings] = useState<EmbedderSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<LaneName, Draft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<LaneName | null>(null);
  const [msgs, setMsgs] = useState<Partial<Record<LaneName, string>>>({});
  const health = usePolledEndpoint<{ embedJob?: RebuildJob | null }>("/api/health", JOB_POLL_MS, {});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/embedder/settings");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as EmbedderSettings;
      setSettings(data);
      setDrafts({ prose: draftFromLane(data.lanes.prose), code: draftFromLane(data.lanes.code) });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The vectors flip from stale to match when the rebuild finishes, so reload the lanes then.
  const jobState = health.data.embedJob?.state;
  useEffect(() => {
    if (jobState === "completed") void load();
  }, [jobState, load]);

  const say = (lane: LaneName, msg: string) => setMsgs((m) => ({ ...m, [lane]: msg }));

  const put = async (lane: LaneName, patch: Patch) => {
    setBusy(lane);
    say(lane, "");
    try {
      const send = (confirm: boolean) =>
        fetch("/api/embedder/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lane, ...patch, ...(confirm ? { confirm_reembed: true } : {}) }),
        });
      let res = await send(false);
      let data = (await res.json()) as PutResponse;
      if (res.status === 409 && data.requires_reembed && data.stored && data.candidate) {
        const ok = await confirmAction({
          title: lane === "code" ? "Re-embed all code exemplars?" : "Re-embed the whole corpus?",
          message:
            `Stored vectors: ${lanePhrase(data.stored)}. New config: ${lanePhrase(data.candidate)}. ` +
            (lane === "code"
              ? "Every code exemplar is re-embedded; code recall is degraded until the rebuild finishes."
              : "Every session and fact is re-embedded; recall is degraded until the rebuild finishes."),
          confirmLabel: "Save and re-embed",
          kind: "danger",
        });
        if (!ok) return;
        res = await send(true);
        data = (await res.json()) as PutResponse;
      }
      if (!res.ok) {
        say(lane, `Error: ${data.error ?? res.statusText}`);
        return;
      }
      say(lane, res.status === 202 ? "Saved, re-embedding started" : "Saved");
      await load();
    } catch (e) {
      say(lane, `Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (lane: LaneName, patch: Patch) => {
    setBusy(lane);
    say(lane, "");
    try {
      const r = await fetch("/api/embedder/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lane, ...patch }),
      });
      const data = (await r.json()) as { ok?: boolean; dim?: number; model?: string; latency_ms?: number; error?: string };
      say(lane, data.ok
        ? `Test OK: ${data.model}, ${data.dim} dims, ${data.latency_ms}ms`
        : `Test failed: ${data.error ?? r.statusText}`);
    } catch (e) {
      say(lane, `Test failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const job = health.data.embedJob ?? settings?.rebuild_job ?? null;

  const renderLane = (lane: LaneName) => {
    if (!settings || !drafts) return null;
    const l = settings.lanes[lane];
    const d = drafts[lane];
    const setDraft = (next: Draft) => setDrafts({ ...drafts, [lane]: next });
    const patch = draftPatch(l, d);
    const dirty = Object.keys(patch).length > 0;
    const disabled = busy !== null;
    const reset = (field: string) => () => void put(lane, { [field]: null });
    return (
      <section key={lane}>
        <h3 className="section-title">{LANE_LABEL[lane]}</h3>
        <div className="form-row">
          <label className="form-label">Provider</label>
          <select className="form-input form-input-inline" value={d.provider} onChange={(e) => setDraft({ ...d, provider: e.target.value })} disabled={disabled}>
            {l.providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <SourceBadge source={l.provider.source} onReset={reset("provider")} disabled={disabled} />
        </div>
        <div className="form-row">
          <label className="form-label">Base URL</label>
          <input className="form-input form-input-inline form-input-wide" value={d.base_url} onChange={(e) => setDraft({ ...d, base_url: e.target.value })} disabled={disabled} placeholder="http://host:port/v1" />
          <SourceBadge source={l.base_url.source} onReset={reset("base_url")} disabled={disabled} />
        </div>
        <div className="form-row">
          <label className="form-label">Model</label>
          <input className="form-input form-input-inline form-input-wide" value={d.model} onChange={(e) => setDraft({ ...d, model: e.target.value })} disabled={disabled} />
          <SourceBadge source={l.model.source} onReset={reset("model")} disabled={disabled} />
        </div>
        <div className="form-row">
          <label className="form-label">API key</label>
          <span className="kv-value mono">{l.api_key_set ? "set" : "not set"}</span>
          <SourceBadge source={l.api_key_source} onReset={reset("api_key")} disabled={disabled} />
          <input
            className="form-input form-input-inline"
            type="password"
            autoComplete="new-password"
            value={d.api_key}
            onChange={(e) => setDraft({ ...d, api_key: e.target.value })}
            disabled={disabled}
            placeholder={l.api_key_set ? "Replace key" : "Set key"}
          />
        </div>
        <dl className="kv-list">
          <dt className="kv-label">Stored vectors</dt>
          <dd className="kv-value mono">{l.stored ? lanePhrase(l.stored) : "none yet"}</dd>
          <dt className="kv-label">State</dt>
          <dd className="kv-value mono">{l.reconcile}</dd>
        </dl>
        {l.reconcile === "stale" && (
          <p className="form-error small">
            The stored vectors were built with a different provider, model or dimension than the live embedder. Recall quality is degraded until they are re-embedded.
             Saving this lane starts the re-embed.
          </p>
        )}
        <div className="form-row">
          <button type="button" className="btn" onClick={() => void test(lane, patch)} disabled={disabled}>Test</button>
          <button type="button" className="btn btn-accent" onClick={() => void put(lane, patch)} disabled={!dirty || disabled}>
            {busy === lane ? "Working…" : "Save"}
          </button>
          {msgs[lane] && <span className={`small ${/^(Error|Test failed)/.test(msgs[lane]!) ? "form-error" : "muted"}`}>{msgs[lane]}</span>}
        </div>
      </section>
    );
  };

  return (
    <div className="page-pad">
      <SettingsSubnav />
      <h2 className="page-title">Embedder</h2>
      {!settings && !error && <div className="muted">Loading…</div>}
      {error && <div className="muted error">{error}</div>}
      {job && (
        <div className="small">
          <strong>Re-embed</strong> <span className="mono">{job.state}</span>
          {job.total > 0 && (
            <>
              {" "}<progress value={job.processed} max={job.total} /> <span className="mono">{job.processed}/{job.total}</span>
            </>
          )}
        </div>
      )}
      {renderLane("prose")}
      {renderLane("code")}
      <p className="muted small">Changes apply live. Clear a field with Reset to fall back to the env or default value. The API key is write-only and never shown.</p>
    </div>
  );
}
