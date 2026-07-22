// tests/integration/tenant-guard.test.ts
/**
 * The standing store guard (program spec §6 case 11, M2 plan Wave C4): every
 * corpus SQL string in every store/action/dataset/http surface routes
 * through tenantClause/tenantClausePg, asserted by construction rather than
 * by exercising store behavior — so a future read/write path that inlines
 * its own WHERE fragment fails a fast, cheap static check instead of
 * shipping a live cross-tenant leak.
 *
 * Two independent checks, both required:
 *
 * 1. Literal scan — no scanned file may inline a bind-param or string-
 *    literal `tenant_id = ?` / `tenant_id = $n` / `tenant_id = '...'` form.
 *    That literal shape can only come from hand-rolling a WHERE fragment
 *    instead of calling tenantClause/tenantClausePg (spec §4.2: "the literal
 *    text `tenant_id =` appears ONLY in tenant-clause.ts"). Column-to-column
 *    equality (`tenant_id = <alias>.tenant_id` / `<alias>.tenant_id =
 *    <alias2>.tenant_id`) is explicitly PERMITTED — it's a defense-in-depth
 *    join condition on top of an already tenant-filtered outer row, not a
 *    hand-rolled filter (see the two joins Wave C4 restored in
 *    SessionStore.findContinuesPredecessor and .listBackfillCandidates).
 *
 * 2. Import requirement — any scanned file whose SQL touches a STAMP table
 *    (the M1 census: sessions, facts, code_exemplars, signals, workstreams,
 *    sources, providers, entities, entity_variants, session_entities,
 *    workstream_entities) must import tenantClause or tenantClausePg, unless
 *    the file is on the explicit ALLOWLIST below. This catches the more
 *    dangerous omission the literal scan can't see: a STAMP-table query with
 *    NO tenant_id reference of any kind, not even a wrong one.
 *
 * NEUTRAL tables (embedding_config) never trigger check 2 — they're not in
 * the STAMP census, so a file that only ever touches embedding_config has no
 * STAMP-table reference to require an import for. Only the documented
 * whole-DB LOCAL surfaces need an explicit, rationale-carrying allowlist
 * entry (rule c).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** M1 table census (program spec §2): every table stamped with its own tenant_id. */
const STAMP_TABLES = [
  "sessions",
  "facts",
  "code_exemplars",
  "signals",
  "workstreams",
  "sources",
  "providers",
  "entities",
  "entity_variants",
  "session_entities",
  "workstream_entities",
] as const;

/**
 * The full corpus-SQL surface the M2 plan names for Wave C4: the store
 * classes under src/core/storage/, the raw-SQL action log + its overlay
 * reader, the raw-DB dataset projector, and the HTTP layer (which mostly
 * calls already-threaded store/registry methods, but also builds two raw
 * whole-DB queries directly — see the ALLOWLIST).
 */
function scanFiles(): string[] {
  const files: string[] = [];
  for (const f of readdirSync(join(ROOT, "src/core/storage"))) {
    if (f.endsWith(".ts")) files.push(join(ROOT, "src/core/storage", f));
  }
  files.push(join(ROOT, "src/core/actions/actions-log.ts"));
  files.push(join(ROOT, "src/core/actions/overlay.ts"));
  files.push(join(ROOT, "src/core/dataset/build-dataset.ts"));
  files.push(join(ROOT, "src/http/app.ts"));
  return files;
}

/**
 * Rule (c): explicit allowlist for STAMP-table SQL that deliberately does
 * NOT route through tenantClause, each with a one-line rationale. Every
 * entry here must also be a documented whole-DB LOCAL surface (spec §4.6),
 * hard-403'd under NLM_HOSTED=1 by Wave C3's installHostedModeGate.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; rationale: string }> = [
  {
    file: "src/core/storage/db-restore.ts",
    rationale:
      "LOCAL surface (GET/POST /api/data/backup|restore, C3-gated): counts sessions across the whole uploaded/backed-up DB file to validate + report it, not to answer a tenant-scoped query.",
  },
  {
    file: "src/http/app.ts",
    rationale:
      "sqliteDataStats/pgDataStats back the LOCAL GET /api/data/stats route (C3-gated): deliberate whole-DB per-table row counts for the Settings->Data page. No other STAMP-table SQL in this file is raw — every other route calls an already tenant-threaded store/registry method.",
  },
];

function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((a) => file.endsWith(a.file));
}

describe("tenant guard: every corpus SQL string routes through tenantClause (spec §4.2/§6.11)", () => {
  const files = scanFiles();

  it("scans a non-trivial, non-empty file set", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("ALLOWLIST entries carry a real rationale and point at a scanned file", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.rationale.length).toBeGreaterThan(20);
      expect(files.some((f) => f.endsWith(entry.file))).toBe(true);
    }
  });

  it("check 1 (literal scan): no scanned file inlines a bind-param or string-literal tenant_id =; column-to-column equality is permitted", () => {
    const columnEquality = /^\w+\.tenant_id$/;
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/tenant_id\s*=\s*(\S+)/g)) {
          const rhs = (m[1] ?? "").replace(/[,);'"`]+$/, "");
          if (!columnEquality.test(rhs)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("check 2 (import requirement): every file with raw SQL touching a STAMP table imports tenantClause/tenantClausePg, unless allowlisted", () => {
    const tableRef = new RegExp(`\\b(FROM|INTO|UPDATE)\\s+(${STAMP_TABLES.join("|")})\\b`);
    const importsHelper = /from\s+["']@core\/tenancy\/tenant-clause\.js["']/;
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (!tableRef.test(content)) continue; // never touches a STAMP table — nothing to require
      if (isAllowlisted(file)) continue;
      if (!importsHelper.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("STAMP census is exhaustive: every listed table is actually referenced somewhere in the scanned surface", () => {
    const allContent = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const untouched = STAMP_TABLES.filter((t) => !new RegExp(`\\b${t}\\b`).test(allContent));
    expect(untouched).toEqual([]);
  });
});
