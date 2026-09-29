/**
 * Reconcile live facts against operator-supplied authorities. Structured
 * sources win: a live fact that contradicts an authority, or that names a
 * deleted file, is retired (never replaced). Deterministic, no LLM calls.
 */

import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { appendFactSupersedence } from "../storage/supersedence-log.js";
import { DEFAULT_TEAM_ID } from "../tenancy/default-team.js";

export interface Authority {
  readonly aliases: readonly string[];
  readonly predicate: string;
  readonly value: string;
  readonly source: string;
}

export interface DeletedFile {
  readonly name: string;
  readonly deleted_at?: string;
  readonly source?: string;
}

export interface AuthoritiesFile {
  readonly authorities: readonly Authority[];
  readonly deleted_files: readonly DeletedFile[];
}

export type FindingType = "value_mismatch" | "dead_reference";

export interface Finding {
  readonly type: FindingType;
  readonly factId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly createdAt: string;
  readonly tenantId: string;
  readonly authorityValue: string | null;
  readonly authoritySource: string;
}

interface FactRow {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  created_at: string;
  tenant_id: string | null;
}

export function loadAuthorities(path: string): AuthoritiesFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthoritiesFile>;
  const authorities = raw.authorities ?? [];
  const deleted = raw.deleted_files ?? [];
  for (const a of authorities) {
    if (!Array.isArray(a.aliases) || a.aliases.length === 0 || !a.predicate || a.value === undefined) {
      throw new Error("each authority needs non-empty aliases, a predicate and a value");
    }
  }
  for (const d of deleted) {
    if (!d.name) throw new Error("each deleted_files entry needs a name");
  }
  return { authorities, deleted_files: deleted };
}

export function normalizeSubject(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

function ports(value: string): number[] {
  return (value.match(/\d+/g) ?? []).map(Number);
}

function hostPort(value: string): string | null {
  try {
    const u = new URL(value.includes("://") ? value : `http://${value}`);
    if (u.hostname && u.port) return `${u.hostname}:${u.port}`.toLowerCase();
  } catch {
    // not URL-shaped; fall through to the regex
  }
  const m = /([a-z0-9.-]+):(\d{1,5})/i.exec(value);
  return m ? `${m[1]}:${m[2]}`.toLowerCase() : null;
}

function contradicts(predicate: string, factValue: string, authorityValue: string): boolean {
  if (predicate === "port") {
    const want = Number.parseInt(authorityValue, 10);
    const have = ports(factValue);
    return have.length > 0 && !have.includes(want);
  }
  if (predicate === "host" || predicate === "url" || predicate === "endpoint") {
    const a = hostPort(authorityValue);
    const f = hostPort(factValue);
    if (a && f) return a !== f;
    return !factValue.toLowerCase().includes(authorityValue.toLowerCase());
  }
  return factValue.trim().toLowerCase() !== authorityValue.trim().toLowerCase();
}

export function findContradictions(db: Database.Database, file: AuthoritiesFile): Finding[] {
  const rows = db
    .prepare<[], FactRow>(
      `SELECT id, subject, predicate, value, created_at, tenant_id FROM facts
       WHERE superseded_by IS NULL AND retired_at IS NULL AND kind != 'decision'
       ORDER BY created_at, id`,
    )
    .all();
  const aliasMap = new Map<string, Authority[]>();
  for (const a of file.authorities) {
    for (const alias of a.aliases) {
      const key = normalizeSubject(alias);
      aliasMap.set(key, [...(aliasMap.get(key) ?? []), a]);
    }
  }
  const dead = file.deleted_files.map((d) => ({ d, key: normalizeSubject(d.name) }));
  const findings: Finding[] = [];
  for (const row of rows) {
    const subject = normalizeSubject(row.subject);
    const base = {
      factId: row.id,
      subject: row.subject,
      predicate: row.predicate,
      value: row.value,
      createdAt: row.created_at,
      tenantId: row.tenant_id ?? DEFAULT_TEAM_ID,
    };
    const predicate = row.predicate.trim().toLowerCase();
    const bad = (aliasMap.get(subject) ?? []).find(
      (a) => a.predicate.trim().toLowerCase() === predicate && contradicts(predicate, row.value, a.value),
    );
    if (bad) {
      findings.push({ ...base, type: "value_mismatch", authorityValue: bad.value, authoritySource: bad.source });
      continue;
    }
    const gone = dead.find(({ key }) => subject === key || subject.startsWith(key));
    if (gone) {
      findings.push({
        ...base,
        type: "dead_reference",
        authorityValue: null,
        authoritySource: gone.d.source ?? `deleted file ${gone.d.name}`,
      });
    }
  }
  return findings;
}

export interface ApplyResult {
  readonly retired: readonly Finding[];
  readonly backupPath: string | null;
}

export async function applyRetirements(
  db: Database.Database,
  dbFilePath: string,
  findings: readonly Finding[],
  limit: number,
  logPath?: string,
): Promise<ApplyResult> {
  const batch = findings.slice(0, limit);
  if (batch.length === 0) return { retired: [], backupPath: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbFilePath}.bak-reconcile-${stamp}`;
  await db.backup(backupPath);
  const retire = db.prepare(
    "UPDATE facts SET retired_at = datetime('now') WHERE id = ? AND retired_at IS NULL AND superseded_by IS NULL",
  );
  db.transaction(() => {
    for (const f of batch) retire.run(f.factId);
  })();
  for (const f of batch) {
    await appendFactSupersedence(
      f.tenantId,
      { factId: f.factId, reason: `${f.type}: contradicted by ${f.authoritySource}`, source: "reconcile" },
      logPath,
    );
  }
  return { retired: batch, backupPath };
}

export function formatReport(findings: readonly Finding[], limit: number): string {
  const lines: string[] = [];
  for (const type of ["value_mismatch", "dead_reference"] as const) {
    const group = findings.filter((f) => f.type === type);
    lines.push(`${type} (${group.length})`);
    for (const f of group) {
      const auth = f.authorityValue === null ? "" : `authority=${f.authorityValue} `;
      lines.push(
        `  ${f.factId}  subject=${f.subject}  predicate=${f.predicate}  value=${f.value}  ` +
          `${auth}source=${f.authoritySource}  created=${f.createdAt}`,
      );
    }
  }
  lines.push(`total: ${findings.length} (--apply would retire ${Math.min(findings.length, limit)})`);
  return lines.join("\n");
}
