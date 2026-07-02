# Swapping the Embedding Model

This runbook covers changing the embedding model used by the semantic recall lane.
Keyword recall continues to work throughout the swap; only semantic (vector) recall
is affected while the lane is stale.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `NLM_EMBED_PROVIDER` | `ollama` or `openai` | `ollama` |
| `NLM_EMBED_BASE_URL` | Base URL for the embedding endpoint | `http://localhost:11434` |
| `NLM_EMBED_MODEL` | Model tag or name passed to the provider | `nomic-embed-text` |
| `NLM_EMBED_API_KEY` | API key (required for `openai` provider) | unset |

## Steps

1. Stop the daemon.

2. Update the environment variables above to point at the new model. The new
   provider/model combination does not need to match the dimension of the
   previous one; `embed-backfill` detects a dimension change and rebuilds the
   vector tables automatically.

3. Run the backfill command:

   ```
   nlm embed-backfill
   ```

   This re-embeds every stored session into `session_embedding_chunks` using the
   new model. Progress is checkpointed to a state file so the command can be
   interrupted and resumed. While the backfill runs, keyword recall continues to
   serve results normally.

4. Restart the daemon. On startup it runs a lane reconcile that reads the
   `embedding_config` table, confirms the active embedder matches the stored
   config, and marks the semantic lane healthy. Semantic recall resumes once
   the lane is marked `ok`.

## Checking lane health

The `/api/classifier/info` endpoint (or `nlm health`) reports the current
embedding provider, model, dims, and lane status. A `stale` status means the
stored config does not match the running embedder; keyword recall is still
served but semantic results are suppressed until the backfill completes and
the daemon is restarted.
