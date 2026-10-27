import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { locateSourceAnchor } from "../../src/core/facts/source-anchor.js";
import type { Fact } from "../../src/shared/types.js";

const tenant = "team_local";
const directory = mkdtempSync(join(tmpdir(), "nlm-fictional-demo-"));
const storage = SqliteStorage.create({ dbPath: join(directory, "demo.sqlite"), migrationsDir: resolve(import.meta.dirname, "../../migrations") });
const previousFlags = [process.env["NLM_PROPERTY_ASSOCIATIONS"], process.env["NLM_PROPERTY_INFERENCE"]];
process.env["NLM_PROPERTY_ASSOCIATIONS"] = "1";
process.env["NLM_PROPERTY_INFERENCE"] = "0";

function record(id: string, runtime: string, body: string, day: number): IngestRecord {
  return { id, runtime, runtimeSessionId: id, startedAt: `2026-01-0${day}T00:00:00Z`, endedAt: null,
    durationMin: null, label: body, summary: body, body, status: "closed", transcriptKind: "synthetic-demo",
    transcriptPath: null, transcriptOffset: null, transcriptLength: null, entities: [], decisions: [], openQuestions: [], scope: null };
}
function fact(source: IngestRecord, predicate: string, value: string, property?: string): Fact {
  return { id: `${source.id}-${predicate}`, kind: "attribute", subject: "api", predicate, value,
    sourceSessionId: source.id, sourceQuote: source.body!, sourceAnchor: locateSourceAnchor(source.body!, source.body!),
    createdAt: source.startedAt, confidence: 1, supersededBy: null,
    ...(property ? { property: { slug: property, source: "explicit" as const, evidence: "Fictional demo fixture" } } : {}) };
}
try {
  console.log("NLM project-memory demo — fictional data; temporary database; no model calls.\n");
  await storage.properties.import(tenant, [{ slug: "atlas", label: "Atlas" }, { slug: "beacon", label: "Beacon" }]);
  const old = record("atlas-earlier", "claude-code/1.0", "Atlas API uses port 3000.", 1);
  const current = record("atlas-current", "codex/1.0", "Atlas API now uses port 4000.", 2);
  const other = record("beacon-current", "hermes/1.0", "Beacon API uses port 9000.", 2);
  for (const [source, property, port] of [[old, "atlas", "3000"], [current, "atlas", "4000"], [other, "beacon", "9000"]] as const) {
    await storage.sessions.insertSession(tenant, source, null, null, { factStore: storage.facts, facts: [fact(source, "port", port, property)] });
    await storage.properties.associateSession(tenant, source.id, [property]);
  }
  await storage.sessions.markSuperseded(tenant, old.id, current.id);
  const atlas = (await storage.facts.listForRecall(tenant, { property: "atlas" })).filter((f) => f.predicate === "port");
  assert.deepEqual(atlas.map((f) => f.value), ["4000"]);
  const source = await storage.sessions.getById(tenant, atlas[0]!.sourceSessionId);
  const earlier = await storage.sessions.getById(tenant, old.id);
  assert.equal(earlier?.status, "superseded");
  assert.equal(earlier.supersededBy, current.id);
  console.log(`1. Recover: Atlas API port = ${atlas[0]!.value} (${source!.runtime}).`);
  console.log(`   Source: "${atlas[0]!.sourceQuote}"`);
  console.log(`2. Inspect history: ${earlier.id} is ${earlier.status} by ${earlier.supersededBy}.`);
  const beacon = await storage.facts.listForRecall(tenant, { property: "beacon" });
  assert.deepEqual(beacon.map((f) => f.value), ["9000"]);
  console.log(`3. Keep projects separate: Atlas = ${atlas[0]!.value}; Beacon = ${beacon[0]!.value}.`);
  const pending = record("atlas-health", "codex/1.0", "Atlas API health path is /health.", 3);
  const unassigned = fact(pending, "health-path", "/health");
  await storage.sessions.insertSession(tenant, pending, null, null, { factStore: storage.facts, facts: [unassigned] });
  assert.equal((await storage.facts.getById(tenant, unassigned.id))?.property, undefined);
  await storage.properties.correctFact(tenant, unassigned.id, "atlas");
  const corrected = await storage.facts.getById(tenant, unassigned.id);
  assert.equal(corrected?.property?.source, "operator");
  assert.equal(corrected.property.slug, "atlas");
  console.log(`4. Correct ownership: ${corrected.predicate} ${corrected.value} -> ${corrected.property.slug} (${corrected.property.source}).`);
  console.log("\nAll demo assertions passed. Automatic ownership inference stayed disabled.");
} finally {
  await storage.close();
  for (const [i, name] of ["NLM_PROPERTY_ASSOCIATIONS", "NLM_PROPERTY_INFERENCE"].entries()) {
    const value = previousFlags[i];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}
