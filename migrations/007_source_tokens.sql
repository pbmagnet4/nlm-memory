-- Migration 007: webhook token on sources.
--
-- Webhook sources need a bearer token so external tools (anything that
-- pushes sessions via POST /api/ingest) can authenticate. The token is
-- stored alongside the source row so one webhook = one token = one
-- provenance label.
--
-- Storage policy mirrors providers.api_key: column in the canonical
-- SQLite for v0 (the DB file already holds the user's transcripts,
-- adding a token doesn't change the threat model). Phase 2 migrates to
-- OS keychain without changing the API shape.
--
-- See docs/plans/desktop-product.md (Phase 0 task 5).

ALTER TABLE sources ADD COLUMN token TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (7, '007_source_tokens');
