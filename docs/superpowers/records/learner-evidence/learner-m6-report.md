# Learner-M6 report: eval + changelog + rollout

Spec: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` §6.
Date: 2026-10-06. M0–M5 complete; this closes the build.

## Eval disposition

- **Precision-gate entry: deliberately declined.** The gate measures scored
  retrieval quality (R@5 floors, LLM relevance judging). The learner path is
  deterministic — exact workstream-binding lookup plus a fixed derivation
  rule, no ranking, no embeddings, no model judgment. There is nothing to
  regress on a precision curve; a gate entry would be theater.
- **What covers it instead (all landed):** summary-rule conformance suite
  (M2, 13 cases incl. demotion + non-retention edges), cross-tenant
  isolation negatives both lanes (M1 contract), and a new real-store
  end-to-end recall test (`tests/integration/learner-recall.test.ts`:
  enroll → record → `pickRelatedConcepts` through real sqlite, plus the
  empty case) closing the M4 fakes-only gap.

## Docs

- CHANGELOG entry appended (`logs/CHANGELOG/CHANGELOG.md`, top). File now
  holds 13 entries against a 10-cap — the breach predates this build;
  archive pass recommended as follow-up, not taken here.

## Rollout

- Default-team single-user first; Team NLM inherits tenancy automatically
  (all three tables STAMP, census + guard green).
- Nothing deployed: daemon restart and UI-bundle `scp` stay manual per
  CLAUDE.md. Release-time note: `plugin/scripts/*.mjs` bundles regenerate
  on `npm run build` — hooks run the deployed bundle, so the Learning
  state section reaches hooks with the next release, not before.
- Pre-existing environment items (not this build's): tree sits on
  `fix/dataset-sqlite-variable-limit` with unrelated dirt; branch creation
  via agent shell is claims-guard-blocked, so the commit needs Edward's
  `!` path onto a new `feat/learner-evidence` branch; `nxtgit session
  register` returned ok:false on a pre-existing `.claude/worktrees` path
  issue (reported 2026-10-06, docs-only writes unaffected).

## Final gates (observed this session)

- `npm run typecheck` clean; learner-affected sweep 151/151 (15 files);
  pg contract 20/20. Full-file audit: every touched path is this build's
  except pre-existing dirt (`plugin/scripts/*.mjs`, classifier-eval, etc.).

## Deferred (from the spec, unchanged)

- Re-derivation-detector integration, `recall_workstream` learner output,
  standalone Learning page, learner chip badge family (needs Edward's call).
