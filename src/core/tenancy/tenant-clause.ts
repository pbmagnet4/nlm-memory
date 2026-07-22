/**
 * tenantClause / tenantClausePg — the single WHERE-fragment builder every
 * corpus SQL string routes through (program spec §4.2). Wave C's guard test
 * (tests/integration/tenant-guard.test.ts) scans src/core/storage/*.ts,
 * actions-log.ts, build-dataset.ts, and http/app.ts for the literal text
 * `tenant_id =`; the invariant this file exists to hold is that the literal
 * appears ONLY here (migrations excepted).
 *
 * Two entry points because the two backends bind params differently, and
 * both existing store idioms build a WHERE clause the same way — a
 * `where: string[]` of fragments joined with " AND ", pushed alongside a
 * parallel `params: unknown[]` array (see SqliteFactStore.list / .listBySessions,
 * PgFactStore.list) — so a helper that returns one `{sql, param}` pair slots
 * directly into that pattern for both:
 *
 *   sqlite (better-sqlite3, positional `?`):
 *     const c = tenantClause(tenantId);
 *     where.push(c.sql); params.push(c.param);
 *
 *   pg (node-postgres, numbered `$n`, tracked via a running `idx`):
 *     const c = tenantClausePg(tenantId, idx++);
 *     where.push(c.sql); params.push(c.param);
 *
 * For single-fragment templates (SqliteSessionStore.getById et al., built as
 * a fixed template literal rather than a where[]/params[] pair), the fragment
 * still composes: interpolate `c.sql` at the right spot in the template and
 * append `c.param` to the positional argument list in the matching order.
 *
 * `column` defaults to the bare column name but accepts an alias-qualified
 * form (e.g. "s.tenant_id") for joined queries.
 */
export interface TenantClause {
  readonly sql: string;
  readonly param: string;
}

export function tenantClause(tenantId: string, column = "tenant_id"): TenantClause {
  if (!tenantId) throw new Error("tenantClause: tenantId is required");
  return { sql: `${column} = ?`, param: tenantId };
}

export function tenantClausePg(tenantId: string, paramIndex: number, column = "tenant_id"): TenantClause {
  if (!tenantId) throw new Error("tenantClausePg: tenantId is required");
  return { sql: `${column} = $${paramIndex}`, param: tenantId };
}
