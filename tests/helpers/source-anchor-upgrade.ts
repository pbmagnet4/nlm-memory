import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";

export async function verifySourceAnchorUpgrade(
  postgres: boolean,
  migrate: (directory: string) => Promise<readonly { version: number }[]>,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
) {
  const directory = resolve(postgres ? "migrations/pg" : "migrations");
  const version = postgres ? 39 : 43;
  const previous = mkdtempSync(join(tmpdir(), "nlm-anchor-upgrade-"));
  try {
    for (const name of readdirSync(directory)) {
      if (/^\d+_.*\.sql$/.test(name) && Number(name.split("_")[0]) < version) copyFileSync(join(directory, name), join(previous, name));
    }
    await migrate(previous);
    await query(`INSERT INTO sessions(id, runtime, started_at, label, summary, body, status)
      VALUES ('legacy-source', 'test', '2026-01-01', 'legacy', '', 'unique literal', 'closed')`);
    await query(`INSERT INTO facts(id, kind, subject, predicate, value, source_session_id, source_quote, created_at, confidence)
      VALUES ('legacy-fact', 'attribute', 'source', 'value', 'literal', 'legacy-source', 'unique literal', '2026-01-01', 1)`);
    const pending = readdirSync(directory).filter((name) => /^\d+_.*\.sql$/.test(name))
      .map((name) => Number(name.split("_")[0])).filter((v) => v >= version).sort((a, b) => a - b);
    expect((await migrate(directory)).map((m) => m.version)).toEqual(pending);
    expect(await query("SELECT body, body_version FROM sessions WHERE id = 'legacy-source'"))
      .toEqual([{ body: "unique literal", body_version: null }]);
    expect(await query("SELECT source_quote, source_start, source_end, source_body_version, source_quote_status FROM facts WHERE id = 'legacy-fact'"))
      .toEqual([{ source_quote: "unique literal", source_start: null, source_end: null, source_body_version: null, source_quote_status: null }]);
    expect(await migrate(directory)).toEqual([]);
  } finally { rmSync(previous, { recursive: true, force: true }); }
}
