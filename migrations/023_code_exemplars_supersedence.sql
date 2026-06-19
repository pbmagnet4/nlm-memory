-- Migration 023: code_exemplars supersedence — operator/LLM verdict on exemplars.
--
-- retired_at: non-null = excluded from recall (the "verdict"), like facts.retired_at.
-- label_source: who last set the verdict/outcome ('llm' at capture; 'human' on
-- operator override). A human verdict is sticky — see CodeExemplarStore.setVerdict.

ALTER TABLE code_exemplars ADD COLUMN retired_at TEXT;
ALTER TABLE code_exemplars ADD COLUMN label_source TEXT NOT NULL DEFAULT 'llm';

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (23, '023_code_exemplars_supersedence');
