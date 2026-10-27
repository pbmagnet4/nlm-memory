# A small, reproducible memory demo

This walkthrough uses fictional Atlas and Beacon projects. It creates its own temporary SQLite database, calls the real storage/correction APIs, asserts the expected results and removes the database when finished. It does not open your NLM corpus, load provider credentials, call a model, start a daemon or install hooks.

From a source checkout with Node.js 22 or newer:

```sh
npm ci
npm run demo:memory
```

Recorded output from the checked fixture:

```text
NLM project-memory demo — fictional data; temporary database; no model calls.

1. Recover: Atlas API port = 4000 (codex/1.0).
   Source: "Atlas API now uses port 4000."
2. Inspect history: atlas-earlier is superseded by atlas-current.
3. Keep projects separate: Atlas = 4000; Beacon = 9000.
4. Correct ownership: health-path /health -> atlas (operator).

All demo assertions passed. Automatic ownership inference stayed disabled.
```

The [script](../scripts/demo/project-memory.ts) seeds explicitly labeled sessions representing different runtimes. It does not invoke those runtimes. The recovered source quote and supersession relationship come from storage reads, and the property filter keeps the fictional Beacon port out of Atlas results. The final assertion begins unassigned and is explicitly corrected while automatic inference remains disabled.

This demonstrates storage semantics. It does not measure capture reliability, classifier accuracy, answer usefulness, response latency or the MCP transport. Those require separate tests/evaluations. The demo itself runs from a source checkout. Property features are available in prerelease 0.21.21-rc.1, and are not present in stable npm 0.21.20; see [release status](release-status.md).
