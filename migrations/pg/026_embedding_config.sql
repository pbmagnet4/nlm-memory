-- Records which embedder produced the stored vectors, per lane.
-- lane 'prose' covers session chunks and fact embeddings (same embedder);
-- lane 'code' covers code exemplar embeddings.
-- Absence of a row means pre-tracking corpus: reconcile treats the running
-- embedder as canonical and records it.
CREATE TABLE IF NOT EXISTS embedding_config (
  lane       TEXT PRIMARY KEY CHECK (lane IN ('prose', 'code')),
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
