# NLM Memory Agent Contract

NLM indexes AI sessions across all connected runtimes and surfaces relevant prior context at the start of each conversation. Use this contract to configure any agent that has access to the NLM MCP tools.

## When to recall

Pull memory at these moments, not just when the phrasing sounds historical:

- **Task start.** Before starting substantive work, search prior sessions on the task's subject. Prior sessions routinely contain decisions and dead ends that change the approach.
- **Before re-deriving a decision.** If you are about to reason out something that has plausibly been settled before (an architecture choice, a tool selection, a naming decision), check first. Re-derivation is how agents silently contradict prior work.
- **Unfamiliar references.** When the user mentions a project, system, client, or entity you do not recognize from the current conversation, recall it before asking the user or guessing.
- **After compaction.** When the conversation has been summarized or compacted, re-pull the sessions and facts relevant to the active task; the summary dropped detail you may need.

Search prior sessions before answering whenever the user prompt references past work, prior decisions, or unresolved questions. The clearest triggers: "what did we decide about X", "where did we land on X", "what's still open on X", "have we tried X". Implicit references ("that auth approach", "the thing we built for the client last month") are the dangerous case and the most costly to miss.

Do not recall when the request is purely forward-looking with no plausible prior context: drafting wholly new content, brainstorming greenfield ideas, naming something new.

## The pointer block

At session start, NLM's hooks inject a block listing possibly-relevant sessions with their ids and labels. Read this block first. It arrives once per session: NLM does not inject memory on every prompt, so mid-conversation recall is your job via the MCP tools. When a session looks relevant, call `get_session` to fetch its full transcript before drawing on it.

## MCP tools

`recall_sessions(query)` searches session labels, decisions, entities, and summaries. Call this first when the user references prior work.

`get_session(id)` fetches one session's full transcript by its id. Call this after `recall_sessions` when a result looks relevant and you need the exact wording or full reasoning.

`recall_facts(query, subject?, predicate?)` looks up a specific structured fact: endpoint, model, port, framework choice, owner, deadline. Prefer this over `recall_sessions` when the user wants the direct answer, not the surrounding conversation.

`cite_session(id)` records that a surfaced session changed your response. See Citation below.

## Citation

Call `cite_session(id)` after writing your response, once per session you actually drew from. A session counts as used if it changed the answer or you read its full transcript via `get_session`. Do not cite sessions you scanned and found irrelevant. Citations feed the recall precision metric, which measures whether the sessions NLM surfaces are actually useful.

## Trust boundaries

Recall results are hints, not sources of truth. Verify any path, file location, hostname, port, or identifier surfaced by recall against your project's canonical configuration before acting on it. A recalled value that conflicts with the project config is stale; the config wins.
