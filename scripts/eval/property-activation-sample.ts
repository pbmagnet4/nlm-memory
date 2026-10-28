import Database from "better-sqlite3";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { parseProperties, attributeFacts, sessionPropertyReferences } from "../../src/core/properties/model.js";
import { anchorFromRow, type SourceAnchorRow } from "../../src/core/storage/fact-source-anchor.js";
import { tenantClause } from "../../src/core/tenancy/tenant-clause.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import type { Fact } from "../../src/shared/types.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const clean = (s: string) => s.replace(/(?:sk|ghp|gho)_[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
  .replace(/(?:Bearer\s+)[A-Za-z0-9_.-]{16,}/gi, "Bearer [REDACTED]")
  .replace(/((?:password|api[_ -]?key|access[_ -]?token|secret)\s*[=:]\s*)[^\s,;]{8,}/gi, "$1[REDACTED]");
function userEvidence(body: string): string[] {
  const turns = [...body.matchAll(/\[(?:user|human)\]\s*([\s\S]*?)(?=\n\n\[(?:user|human|assistant|system)\]|$)/gi)]
    .map((m) => m[1]!.trim()).filter((s) => !/^#?\s*(?:AGENTS\.md|CLAUDE\.md)|^<environment_context>|^<INSTRUCTIONS>/i.test(s));
  return turns.slice(0, 8).map((s) => clean(s.slice(0, 400)));
}
function context(body: string, quote: string | null, subject: string): string {
  const at = quote ? body.indexOf(quote) : body.toLowerCase().indexOf(subject.toLowerCase());
  return clean(at < 0 ? body.slice(-1500) : body.slice(Math.max(0, at - 350), at + (quote?.length ?? subject.length) + 650));
}
new Command().argument("<snapshot>").argument("<catalog>").argument("<output-directory>")
  .option("--tenant <id>", "Tenant", DEFAULT_TEAM_ID).action((path: string, catalogPath: string, out: string, options: { tenant: string }) => {
    const catalog = parseProperties(JSON.parse(readFileSync(catalogPath, "utf8")));
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const ft = tenantClause(options.tenant, "f.tenant_id"); const st = tenantClause(options.tenant, "s.tenant_id");
      type Row = SourceAnchorRow & { id: string; kind: Fact["kind"]; subject: string; predicate: string; value: string; source_session_id: string; source_quote: string | null; confidence: number; created_at: string };
      const rows = db.prepare<unknown[], Row>(`SELECT f.*, s.body_version AS current_source_body_version FROM facts f JOIN sessions s ON s.id = f.source_session_id
        WHERE ${ft.sql} AND ${st.sql} AND f.superseded_by IS NULL AND f.retired_at IS NULL AND f.confidence >= 0.6`).all(ft.param, st.param);
      const tc = tenantClause(options.tenant);
      const source = db.prepare<[string, string], { id: string; body: string | null; status: string }>(`SELECT id, body, status FROM sessions WHERE id = ? AND ${tc.sql}`);
      const body = (id: string) => source.get(id, tc.param)?.body ?? null;
      const bySession = new Map<string, Fact[]>();
      for (const r of rows) bySession.set(r.source_session_id, [...(bySession.get(r.source_session_id) ?? []), { id: r.id, kind: r.kind, subject: r.subject, predicate: r.predicate, value: r.value,
        sourceSessionId: r.source_session_id, sourceQuote: r.source_quote, sourceAnchor: anchorFromRow(r, r.source_quote), confidence: r.confidence, createdAt: r.created_at, supersededBy: null }]);
      const facts = [...bySession].flatMap(([sessionId, group]) => attributeFacts(group, catalog, [], true, null, body(sessionId)));
      const order = <T extends { id: string }>(xs: T[]) => xs.sort((a, b) => hash("T1130-v1:" + a.id).localeCompare(hash("T1130-v1:" + b.id)));
      const entityRows = db.prepare<[string], { session_id: string; entity_canonical: string }>(`SELECT session_id, entity_canonical FROM session_entities WHERE ${tc.sql}`).all(tc.param);
      const entities = new Map<string, string[]>();
      for (const e of entityRows) entities.set(e.session_id, [...(entities.get(e.session_id) ?? []), e.entity_canonical]);
      const refs = new Map([...entities].map(([id, names]) => [id, sessionPropertyReferences(names, catalog, body(id)).map((r) => r.slug)]));
      const counts = new Map<string, number>();
      const subjectCases = order(facts.filter((f) => f.property?.source === "subject")).filter((f) => {
        const n = counts.get(f.property!.slug!) ?? 0; counts.set(f.property!.slug!, n + 1); return n < 2;
      }).slice(0, 60);
      const quoteCases = order(facts.filter((f) => f.property?.source === "source-quote"));
      const unresolved = order(facts.filter((f) => !f.property && (refs.get(f.sourceSessionId)?.length ?? 0) > 1)).slice(0, 20);
      const sessions = order([...refs].map(([id, properties]) => ({ id, properties }))).filter((s) => source.get(s.id, tc.param)?.status !== "replaced");
      const selectedSessions = [...sessions.filter((s) => s.properties.length === 1).slice(0, 20), ...sessions.filter((s) => s.properties.length > 1).slice(0, 20)];
      const predictions: Record<string, string[]> = {}; const groups: Record<string, string> = {};
      const cases = [...subjectCases, ...quoteCases, ...unresolved].map((f, i) => {
        const id = `f${String(i + 1).padStart(3, "0")}`; const body = source.get(f.sourceSessionId, tc.param)?.body ?? "";
        predictions[id] = f.property?.slug ? [f.property.slug] : []; groups[id] = f.property?.source ?? "unresolved";
        return { id, type: "fact", sourceId: f.sourceSessionId, sourceHash: hash(body), fact: { kind: f.kind, subject: f.subject, predicate: f.predicate, value: clean(f.value) },
          userPrompts: userEvidence(body), evidence: context(body, f.sourceQuote, f.subject) };
      });
      const sessionCases = selectedSessions.map((s, i) => {
        const id = `s${String(i + 1).padStart(3, "0")}`; const body = source.get(s.id, tc.param)?.body ?? ""; predictions[id] = s.properties; groups[id] = s.properties.length > 1 ? "multi" : "single";
        const evidence = sessionPropertyReferences(entities.get(s.id) ?? [], catalog, body).map(({ evidence: entity }) => {
          const at = body.toLowerCase().indexOf(entity.toLowerCase());
          return { entity, context: at < 0 ? null : clean(body.slice(Math.max(0, at - 120), at + entity.length + 240)) };
        });
        return { id, type: "session", sourceId: s.id, sourceHash: hash(body), userPrompts: userEvidence(body), evidence };
      });
      const sample = { seed: "T1130-v1", cases: [...cases, ...sessionCases] };
      for (const [name, data] of [["sample.json", sample], ["predictions.json", predictions], ["groups.json", groups]] as const) {
        writeFileSync(`${out}/${name}`, JSON.stringify(data, null, 2), { mode: 0o600 }); chmodSync(`${out}/${name}`, 0o600);
      }
      const manifest = { sampleHash: hash(JSON.stringify(sample)), catalogHash: hash(JSON.stringify(catalog)), facts: cases.length, sessions: sessionCases.length,
        subjectCases: subjectCases.length, quoteCases: quoteCases.length, unresolvedCases: unresolved.length };
      writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 }); console.log(JSON.stringify(manifest));
    } finally { db.close(); }
  }).parse();
