-- Migration 052: sessions_fts_vocab — term statistics for the keyword lane (T1770k).
--
-- Recall hooks send whole prompts as the keyword query (128-256 words measured
-- on the live corpus, 2026-11-24). OR-ing every token into one FTS5 MATCH cost
-- 0.8-6.6 s on the daemon's event loop; keeping the 24 rarest terms costs
-- 12-45 ms, and rare terms are what BM25 weights anyway. This table is the
-- document-frequency source for that choice.
--
-- fts5vocab is a read-only view over the FTS index itself, not a shadow copy:
-- it needs no backfill and no triggers, so applying it to an already-populated
-- database is instant and it reflects rows inserted before the upgrade.
--
-- SQLite only. The Postgres keyword path (pg-session-store.ts) is untouched.

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts_vocab USING fts5vocab(sessions_fts, 'row');

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (52, '052_sessions_fts_vocab');
