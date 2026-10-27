# Contributing

Start with an existing issue or a small, concrete problem. Keep the source of a memory separate from an inference about it, and preserve tenant boundaries in every storage/recall path.

Use Node.js 22 or newer. From a source checkout:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:codex-release -- --check-packed
```

PostgreSQL checks use the repository's `docker-compose.pg-test.yml` and `NLM_PG_TEST_URL`; inspect that file for the mapped port and test credentials. Run `npm run test:pg` after configuring the URL. Tests must use disposable databases, never an existing memory corpus.

For bugs, include the NLM version, runtime, operating system, expected behavior and a minimal fictional transcript or fixture. Do not attach real databases, transcripts, provider keys, tokens or private endpoint details. Security reports belong in the [private reporting channel](SECURITY.md#reporting-a-vulnerability).

For retrieval changes, record what the evaluation actually measures and which cases it misses. Keep thresholds fixed before held-out scoring. An increase in recall or coverage alone does not prove better answers.

Generated `dist/` files are not tracked. When changing hooks, regenerate their tracked bundles with `npm run build`; edit the TypeScript source rather than the generated JavaScript.
