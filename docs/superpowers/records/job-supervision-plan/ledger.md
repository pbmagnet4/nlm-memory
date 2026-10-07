# SDD ledger — plan: .superpowers/sdd/job-supervision-plan.md

Main-direct per repo precedent, sequential implementers, BASE cb3d467. Alert lane (NLM_ALERT_WEBHOOK → n8n reXjTNKTAWDJucOd → Matrix #ops-alerts) already live as of today — outside this plan's diff.
Task 1: review — Critical (stale-callback identity race on stop+start) + Important (ports inline not src/ports/). Fix round 1 dispatched to original implementer.
Task 1: minor (deferred): exhausted event reports restarts:4 incl. the refused attempt — clarify alert copy in Task 2/3
Task 1: note for Task 2: start() throws synchronously on spawn failure by design — HTTP route must wrap; never-cleared clock.setInterval is deliberate (daemon-lifetime object)
Task 1: fix round 1/5 (2 addressed, 0 open — identity-guard race + ports relocation; commits a53b284..9886d23; re-reviewer empirically verified via revert)
Task 1: complete (commits cb3d467..9886d23, review clean)
Task 2: complete (commits 9886d23..8fd13ba, review Approved)
Task 2: minor (deferred): 409-vs-500 literal string match on start() throw message; restarts count in exhausted alert overstates real respawns by one (counts the refused attempt); shutdown-hook gap for --no-scheduler/zero-adapter daemons is pre-existing
Task 3: complete (commits 8fd13ba..da5d9f8, review Approved, no findings)
Final review: NOT READY → fix wave 46ab291..e0632a2 (spawn-strand Critical, restarts off-by-one, restartsTotal) → re-review: 3/3 ADDRESSED; re-review exposed branch-introduced red CI typecheck gate (AlertEvent union) → closed by 1a18740 (discriminated-union producer returns). Controller verified: npm run typecheck green, jobs/alerts/digest suites green. Pushed. #414 build COMPLETE.
Not deployed: live daemon runs bundled 0.21.0 — feature ships at next NxtOS bundle release (Edward's release step).
Deferred (triaged final review): 409 string-match constant; terminal digest line never ages out; per-child processed/total after restart looks like regression (README sentence exists); stopRequested dead code line; no exit(null) restart-path test beyond stop() case.
