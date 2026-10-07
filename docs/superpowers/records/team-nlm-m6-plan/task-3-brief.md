## Task 3 — flip leak-contract case 12 + pg twin

In `tests/integration/tenant-leak-contract.test.ts` replace the case-12 `it.todo` with real assertions (keep the exact case text as the test name):

- Memo: `recordSurfaced(A, convId, [sessionA])` then `loadSurfaced(B, convId)` is empty — a conversation-id collision across teams shares no dedup state.
- Query/citation/miss/hook logs: write one entry as A and one as B (distinct ids); each tenant's stats/reader output contains only its own entry; the legacy default-team file receives neither non-default tenant's rows.
- HTTP-level: `/api/recall/stats` as token-A reflects A's write only (reuses the case-8 token fixtures).

Add the pg-twin case in `tenant-leak-contract.pg.test.ts` where the fixture supports it (file-state is backend-independent — if the pg twin adds nothing beyond the sqlite case, say so in the report and add a one-line comment in the pg file instead of a duplicate test).

Update the contract header comment (cases 1-9, 11-12 live; 10 still M7-harness-gated… it already landed — verify and state the true remaining set).

## Acceptance (spec M6 row)

No cross-tenant collision in memo state; recall-precision/miss metrics computable per tenant; no metric aggregates across tenants; case 12 green both lanes; M6-FILTER routes tenant-filtered in hosted mode; local mode byte-identical.
