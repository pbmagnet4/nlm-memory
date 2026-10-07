# SDD ledger — plan: .superpowers/sdd/team-nlm-m6-plan.md

Working on main by repo precedent (M1-M4 waves all committed to main directly; Edward's "chew through those tasks with SDD" approved the sequence). Single actor: sequential implementers, this session only. BASE at start: 49e12f3.

Design ruling (controller): per-tenant subdirs over DB rows — rationale in plan header. Surface to Edward at close.
Task 1: review — spec ✅ except missing test (c) in hook-recall-log.test.ts (Important, fix round 1 dispatched to original implementer)
Task 1: minor (deferred): 7x duplicated path-selection conditional — optional tenantOrEnvPath helper
Task 1: minor (deferred): tenant-path tests write real dirs under ~/.nlm/tenants/ (leaf-only cleanup, no temp-dir injection)
Task 1: reviewer note adjudicated: hosted commingling on /api/recall, /api/recall/facts, hermes pre-turn logQuery sites is pre-existing and Task 2 scope — Task 2 dispatch MUST thread c.get("tenantId") through ALL http/app.ts telemetry call sites, not only M6-FILTER handlers. NLM_HOSTED not live anywhere today.
Task 1: fix round 1/5 (1 addressed, 0 open — missing test (c) hook-recall-log; commit 702786f)
Task 1: complete (commits 49e12f3..702786f, review clean)
Task 2: complete (commits 702786f..0cb998e, review Approved; scope extension cite-memo/recent-log/cite-stats judged correct)
Task 2: minor (deferred): memo-sweep only sweeps default-team hook-state dir — retention gap for tenant subdirs, not a leak
Task 2: minor (deferred): stale pre-M6 doc comment in mcp/server.ts ~897
PLAN AMENDED (controller): reviewer found supersedence-log.jsonl un-tenanted + hosted-reachable (POST /api/session/:id/supersede, mark_superseded, supersede_fact) — pre-existing, outside all task scopes. Added Task 4 (supersedence-log tenancy), reordered: Task 4 runs BEFORE Task 3 so case 12 asserts supersedence isolation.
Task 4: complete (commits 0cb998e..7cafc72, review clean)
Task 3: complete (commits 7cafc72..b5c8ea7, review clean; minor noted: broad rmSync cleanup on literal team_a/b tenant dirs)
Final review: NOT READY → fix wave 546682a..cb3d467 (6 findings + case-8 homedir leak) → scoped re-review: all ADDRESSED, no new breakage. M6 COMPLETE. Pushed.
~/.nlm/tenants test residue cleanup left to Edward (rm denied by permission layer).
Deferred (final-reviewer triage, tracked): memo-sweep tenant-dir coverage (NocoDB follow-up); path-conditional helper 9x consolidation; hookLogPath dedup; resolve-conversation-by-query host-local scan note; HttpDeps override test-seam comment.
