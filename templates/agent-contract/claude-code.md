## NLM Memory

NLM indexes every AI session across all connected runtimes and surfaces relevant prior context automatically. The rules below govern how to use it.

### When to recall

Call `recall_sessions` before answering whenever the prompt references past work, prior decisions, or unresolved questions. Examples that should trigger recall:

- Decision questions: "what did we decide about X", "where did we land on X", "what was the conclusion"
- Status questions: "what's still open on X", "where did we leave X", "is X done"
- History questions: "have I worked on X", "when did we last do X", "did we already do X"
- Implicit references: "that X thing", "the discussion about X", "our approach to X"

Do not recall when the request is purely forward-looking with no plausible prior context: drafting wholly new content, brainstorming greenfield ideas, naming something new.

### The pointer block

At the start of each conversation, NLM's hooks inject a pointer block listing possibly-relevant sessions with their ids and labels. Read this block first. When a session looks relevant, call `get_session` to fetch its full transcript before drawing on it.

### MCP tools

- **`recall_sessions(query)`** - keyword search over session labels, decisions, entities, and summaries. Call this first when the user references prior work.
- **`get_session(id)`** - fetch one session's full transcript by its id. Call this after `recall_sessions` when a result digest looks relevant and you need the exact wording or full reasoning.
- **`recall_facts(query, subject?, predicate?)`** - look up a specific structured fact by free-text query, optionally narrowed by subject or predicate (endpoint, model, port, framework choice, owner). Prefer this over `recall_sessions` when the user wants the direct answer, not the surrounding conversation.
- **`cite_session(id)`** - record that a surfaced session changed your response. See Citation below.

### Citation

Call `cite_session(id)` after writing your response, once per session you actually drew from. A session counts as used if it changed the answer or you read its full transcript via `get_session`. Do not cite sessions you scanned and found irrelevant. Citations feed the recall precision metric, which measures whether surfaced sessions are actually useful.

### Trust boundaries

Recall results are hints, not sources of truth. Verify any path, file location, hostname, port, or identifier surfaced by recall against your project's canonical configuration before acting on it. A recalled value that conflicts with the project config is stale; the config wins.
