# Voice memory phase 1: design

Status: design, 2026-11-23. Implements phase 1 of
[the approved scope](2026-11-23-voice-memory-scope.md). Work-Id: T2438.

Phase 1 ships the store, two intake paths, the rules reader and
`recall_voice`, all behind `NLM_VOICE_ENABLED=1` (default off). It mirrors the
code-exemplar lane (`code_exemplars`, `recall_code`) wherever it can, so each
piece has a working precedent in the repository.

## Pieces and owners

Each piece is one task branch with its own test gate. B, C and D depend on A's
port; E depends on nothing in this repository.

| Piece | What | Precedent |
|---|---|---|
| A. Store | Migration, port, SQLite and Postgres stores, vec0 lane, wiring into `Storage` | `migrations/021_code_exemplars.sql`, `src/ports/code-exemplar-store.ts`, `src/core/storage/sqlite-code-exemplar-store.ts`, `src/core/exemplars/embed-backfill.ts` |
| B. Rules reader | Load, validate and resolve rules files; the shipped JSON schema | file config like `src/core/scope/alias-map.ts`; `yaml` and `zod` are already dependencies |
| C. Intake | `POST /api/voice/sample`, `nlm voice-signal`, `nlm voice backfill` | `/api/signal`, `nlm code-signal`, `src/core/exemplars/ingest-exemplar.ts` |
| D. Recall | `recall_voice` MCP tool | `recall_code` (`src/core/exemplars/recall-code.ts`, `src/mcp/server.ts`) |
| E. Consumer side (Whtnxt Agent) | Export of already-published posts to JSONL; Edward's rules file; agents switch to `recall_voice` | `scripts/` exports, `.claude/context/edward-voice-guide.md` |

## A. Store

Migration `051_writing_samples.sql` (SQLite) and `migrations/pg/048_writing_samples.sql`.
Tables are created unconditionally; the flag gates application paths, as with
code exemplars.

```sql
CREATE TABLE IF NOT EXISTS writing_samples (
  id            TEXT PRIMARY KEY,   -- sha256(install_scope|voice|channel|text_hash|source)[:16]
  install_scope TEXT NOT NULL,
  voice         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  audience      TEXT,
  source        TEXT NOT NULL CHECK (source IN ('published','approved','import','onboarding')),
  source_ref    TEXT,               -- URL or upstream record id; provenance only
  text          TEXT NOT NULL,      -- the person's words only
  text_hash     TEXT NOT NULL,      -- sha256 of the normalised text
  context       TEXT,               -- what it replied to; never embedded
  outcome       TEXT NOT NULL CHECK (outcome IN ('published','approved','rejected','pending_review')),
  draft_id      TEXT,
  session_id    TEXT,
  rules_version TEXT,
  ts            TEXT NOT NULL,      -- when it was written or published
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_writing_samples_scope_voice ON writing_samples(install_scope, voice, channel, outcome);
CREATE INDEX IF NOT EXISTS idx_writing_samples_hash ON writing_samples(install_scope, text_hash);
```

`register` and `form` (classifier labels) wait for phase 3, when importers
need them. Columns land when a reader exists.

Port `src/ports/writing-sample-store.ts`:

```ts
export type WritingSampleOutcome = "published" | "approved" | "rejected" | "pending_review";
export type WritingSampleSource = "published" | "approved" | "import" | "onboarding";
export interface WritingSampleInput { voice; channel; audience?; source; sourceRef?; text; context?; outcome; draftId?; sessionId?; rulesVersion?; ts }
export interface WritingSampleStore {
  insert(tenantId, input): Promise<{ id: string; skipped: boolean }>;   // skipped = same id already stored
  upsertEmbedding(tenantId, id, vector: Float32Array): Promise<void>;
  missingEmbeddings(tenantId, limit): Promise<ReadonlyArray<{ id: string; text: string }>>;
  search(tenantId, queryVector, filter: { voice; channel; outcomes: readonly WritingSampleOutcome[]; k }): Promise<ReadonlyArray<WritingSampleHit>>;
}
```

Invariants:

1. Tenancy and scope exactly as code exemplars: every read and write is
   tenant-scoped through `tenantClause`, and `install_scope` is stamped
   server-side, never taken from a caller.
2. `text_hash` normalises by trimming, collapsing whitespace and lowercasing,
   so the same post imported twice dedupes. The id includes `source`, so a
   post first seen as `approved` and later `published` is two rows; recall
   (D) prefers the higher source.
3. vec0 table `writing_samples_vec(sample_id TEXT PRIMARY KEY, embedding float[<dim>])`,
   created at the prose lane's dimension the way `code_exemplars_vec` is
   (`src/core/exemplars/embed-backfill.ts`). Embeddings come from the prose
   embedder, best-effort at ingest; `missingEmbeddings` feeds a retry sweep
   modelled on `chunk-embed-sweep`, every 2 minutes, under the shared
   in-flight cap and the disk guard.
4. Postgres mirrors the table with `pgvector`, like `pg-code-exemplar-store.ts`.
5. `search` runs on the semantic read worker when one exists
   (`SqliteSemanticReader`, T1770); it never scans vectors on the main loop.
6. Samples never reach telemetry, digests or any export, and
   `docs/data-boundary.md` gains a voice section in this piece.

## B. Rules reader

Rules live in `NLM_VOICE_RULES_DIR` (no default; unset means `recall_voice`
returns examples only). One file per voice, `<voice>.yaml`:

```yaml
voice: edward
rules: [ "Plain words; no 'leverage', 'synergy'", "First person, active voice" ]
banned_phrases: [ "leverage", "game-changer" ]
channels:
  linkedin: { rules: [ "One idea per post", "No hashtags in the body" ], max_chars: 1300 }
  email-professional: { rules: [ "Lead with the ask" ] }
audiences:
  client-blog: { rules: [ "Name the client's reader, not Edward's" ] }
```

Invariants:

1. NLM ships the contract: a zod schema in `src/core/voice/rules-schema.ts`
   and the generated `schemas/voice-rules.schema.json` (one generator script,
   committed output, checked by a test that regenerates and compares).
2. `resolveRules(voice, channel, audience?)` merges voice, then channel, then
   audience: `rules` lists concatenate in that order, scalar fields override.
   An unknown channel or audience contributes nothing; it is not an error.
3. `rules_version` is `git -C <dir> rev-parse --short HEAD`, suffixed `-dirty`
   when the tracked files differ, or `unversioned` outside git. It is read
   once per file change (mtime), not per call.
4. An invalid file is skipped with one WARN per file change, and that voice
   resolves to no rules. A bad file never fails recall.

## C. Intake

1. `POST /api/voice/sample`, behind the flag, local-only and tenant-resolved
   like `/api/signal`. Body: `{ voice, channel, audience?, text, outcome,
   source?, source_ref?, context?, draft_id?, session_id?, ts? }`. `source`
   defaults from `outcome`: `published` → `published`, `approved` →
   `approved`, `rejected` → `approved`. Returns `{ id, skipped }`. Text over
   20,000 characters or empty after trimming is a 400.
2. No scrubbing in phase 1: both intake paths carry text the person already
   published or approved. NLM has no secrets scrubber today; phase 3's
   importers (private exports) bring one, and the endpoint will apply it then.
3. `nlm voice-signal --voice --channel (--text-file | --text) [--url]
   [--outcome published] [--draft-id]` mirrors `nlm code-signal`: loopback
   POST, and a down daemon warns on stderr and exits 0.
4. `nlm voice backfill <format> <path> --voice <v> [--channel <c>] [--dry-run]`
   with two readers:
   - `markdown-dir`: every `*.md` under `<path>`; frontmatter `title`, `url`
     or `slug`, and `date`/`published_at`; body without frontmatter is the
     text; channel from `--channel` (required for this format).
   - `jsonl`: one object per line `{ channel, text, url?, ref?, published_at }`,
     as written by the Whtnxt Agent export (E).
   Every row lands as `source = published`, `outcome = published`. The
   command prints counts (read, stored, skipped as duplicates, rejected) and
   nothing of the text. `--dry-run` stores nothing.
5. NLM never calls NocoDB, a CMS or a social API (scope boundary): the
   consumer exports, NLM reads files.

## D. Recall

`recall_voice` is registered only when `NLM_VOICE_ENABLED=1`:

```
input:  { voice, channel, audience?, request, k = 3 (1..10), maxChars = 6000 (2000..20000) }
output: { rules: string[] | null, rules_version: string | null, banned_phrases: string[],
          examples: [{ id, channel, source, outcome, text, source_ref, distance }],
          avoid: [{ id, text, distance }], draft_id, truncated: boolean }
```

Invariants:

1. Examples come from `outcome in (published, approved)`, same voice; the
   requested channel first, then other channels of the same voice only when
   the channel has fewer than k. Ranking is tiered: published before
   approved, then by distance. `pending_review` never surfaces.
2. `avoid` holds up to 2 `rejected` samples within the same distance as the
   k-th example. Phase 1 has no correction pairs (phase 2).
3. `draft_id` is a fresh `crypto.randomUUID()` per call; phase 2 links it.
4. With no embedder, examples fall back to the newest published samples of
   the channel (labelled `distance: null`). With no samples, rules only.
   With neither, an empty result, never an error.
5. The response is trimmed to `maxChars` by dropping the furthest example
   first, then `avoid`, never rules; `truncated` says so.
6. The tool description tells agents to call it before drafting anything
   written as the person, and to pass `draft_id` to the publish producer.

## E. Consumer side (Whtnxt Agent, separate task)

1. `scripts/voice-export-published.py` writes JSONL for (C4) from NocoDB:
   Social Media rows with Status Published (Platform → channel, Body → text)
   and Content rows with Status Published that carry a blog slug (the
   `.md` path goes to the `markdown-dir` reader instead). Filters and limit
   server-side per `.claude/rules/token-efficiency.md`.
2. Edward's rules file: `.claude/context/edward-voice-guide.md` converted to
   `edward.yaml` in the rules repository (open question 1 in the scope:
   which repository).
3. The email-composer and content-director agent definitions call
   `recall_voice` instead of `recall_sessions` for voice examples, once A to D
   are deployed with the flag on.

## Tests (per piece)

- A: a store contract run on SQLite (and Postgres where the pg tests run):
  dedup on id, tenant isolation, scope stamping, search filters and tiering
  inputs, missing-embedding listing; the migration applies on a copy of a
  current database.
- B: merge order, unknown channel, invalid file skipped with WARN,
  `rules_version` in git, dirty and non-git dirs, schema file regenerated
  equals committed.
- C: endpoint flag-off 404, validation 400s, dedup `skipped`,
  local-only; producer exits 0 with the daemon down; both backfill readers
  on fixtures, `--dry-run` stores nothing, counts only in output.
- D: tiering, channel fallback, avoid band, no-embedder fallback, empty
  cases, `maxChars` trimming order, tool absent when the flag is off.

## Design check, 2026-11-23

Checked against main 800741b before dispatch: no shared secrets scrubber and no
UUIDv7 helper exist (so neither is assumed); `yaml` and `zod` are dependencies;
the next migrations are SQLite 051 and Postgres 048; `src/core/scope/alias-map.ts`
is the file-config precedent; the semantic read worker (T1770) is on main.

## Acceptance for phase 1

With the flag on, after Edward's published LinkedIn posts and blog posts are
backfilled, `recall_voice({ voice: "edward", channel: "linkedin", request })`
returns his rules and three of his published posts in under 1 s, on the
worker, and a draft written with them is reviewed against one written from
session recall on five real requests (Edward judges which reads more like
him). Phase 2 starts only if the voice lane wins that comparison.
