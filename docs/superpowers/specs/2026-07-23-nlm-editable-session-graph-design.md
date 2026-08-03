# Editable session graph (Flowgram supersedence canvas)

> A focused, editable node-graph view where sessions are nodes and supersedence is a directed edge you can draw and remove by direct manipulation. Renders NLM's defining property (the editable timeline) as the one thing the current views cannot show: relationships.

Date: 2026-07-23
Status: Design (pre-plan)
Owner surface: `src/ui/` (new page) + `src/core/actions/` (one new action) + `src/http/` + MCP

## Motivation

NLM's current views encode time and density. River is a timeline grid, Thread is a linear chain, Pulse is a dashboard. None of them show **relationships between sessions**, yet relationships are the whole product thesis: "sessions are clips, sequence is meaning, supersedence is non-destructive."

A node graph is the one view that can foreground the two relationships that matter:

1. **Supersedence lineage** (the core one): session B corrected session A. Rendered as a directed edge, a decision's entire correction chain is visible at a glance ("what we thought, then revised, then revised again"). River buries this in a distinct lane; a graph makes it the primary shape.
2. **Shared-entity neighborhoods**: sessions touching the same entity cluster together, exposing which topics are dense, which decisions are isolated, and where a thread went quiet.

The graph is also **editable**, which is what separates this from a generic relationship viewer and what justifies Flowgram (a workflow *builder*, whose weight is in its edit model) over a lighter view-only lib. Drawing a supersedence edge is direct manipulation over an operation NLM already exposes.

## Non-goals (v1)

- **Not the global corpus graph.** Rendering every session is an unreadable hairball and the most common way these UIs fail. v1 is a focused ego-graph only (see Model).
- **Not a general timeline editor.** The only mutation in v1 is create/remove a `supersedes` edge. Branching, re-ordering, retire/snooze, and entity-overlay edits are explicitly out of scope.
- **Not a replacement for River or Thread.** It is an additional view.
- **No new supersedence semantics.** The graph is a front-end over the existing state machine in `docs/supersedence.md`. It does not change what supersedence means, only how it is discovered and applied.

## Model

### Nodes
Each node is a session. Visual encoding reuses the existing status language:
- `active` / `idle` / `closed` (time-derived from transcript mtime, per `src/core/storage/live-status.ts`)
- `superseded` (persisted, explicit) rendered in the same distinct treatment as River's superseded lane

Node label = session label; hover/selection opens the existing `SessionDrawer` (no new detail surface).

### Edges
- **Supersedence edge** (directed, successor -> predecessor): a row in `session_edges` with `kind='supersedes'`. This is the editable edge.
- **Entity edge** (undirected, non-editable, optional overlay): two sessions share a tagged entity. Rendered thin/muted, toggleable, purely for clustering context. Not persisted by this feature; derived at query time.

### Focus and scope (the make-or-break decision)
The graph is always an **ego-graph rooted at a focus**, never the whole corpus:
- Focus = a selected session, or a selected entity.
- Include: the focus, its supersedence ancestors and descendants (full chain, both directions), and its N-hop entity neighbors (default N=1, capped node count, e.g. 60).
- A node-count cap with a "showing X of Y" affordance prevents hairballs. When the cap is hit, entity neighbors are trimmed first; the supersedence chain is always shown in full.

Entry points: a "View in graph" action from a session in River/Thread/Search/SessionDrawer, and an entity chip -> "graph" affordance.

## Edit operations

### Create a supersedence edge
Drag from the successor node's port to the predecessor node.
- Gesture opens a confirm + reason panel (Flowgram node/edge form material).
- On confirm -> `mark_superseded(predecessor_id, successor_id, reason)`.
- Backend behavior is unchanged and already exists: flips predecessor `sessions.status` to `superseded`, inserts the `session_edges` row, appends the reason to `~/.nlm/supersedence-log.jsonl` for audit provenance. Idempotent.

### Remove a supersedence edge (the one new backend piece)
Select an existing `supersedes` edge -> "remove" -> confirm + reason.
- Needs a new operator action `unmark_superseded(predecessor_id, successor_id, reason?)`.
- The storage primitive already exists: the session store deletes `supersedes` edges today (`sqlite-session-store.ts:974-984`, `pg-session-store.ts:347`). This action wraps it and additionally:
  1. Deletes the `session_edges` row (successor -> predecessor, `kind='supersedes'`).
  2. **Restores the predecessor's status.** Because `superseded` is persisted and overrides the time-derived status, removing the edge must recompute status from `live-status.ts` (mtime -> active/idle/closed) rather than assume `closed`. If other `supersedes` edges still point at the predecessor, it stays `superseded`.
  3. Appends a reversal entry to the supersedence audit log.
- Exposed as: a `core/actions` function, an MCP tool (`unmark_superseded`), and reused by the UI via HTTP. Mirrors the shape of `mark_superseded` for symmetry and testability.

### The deliberateness guardrail (non-negotiable)
Supersedence is NLM's defining property and it is audited on purpose. `docs/supersedence.md` is emphatic that it is deliberate. The graph lowers the **discovery** cost of supersedence, never its **deliberateness**:
- Every edge create/remove requires an explicit confirm and a reason, the same bar as the MCP/CLI paths.
- No batch/multi-edge apply in v1.
- The reason is required on create (matches operator intent capture) and optional on remove, but a reversal is always logged.

## Architecture and integration points

- **UI page:** new `src/ui/pages/Graph.tsx`, registered in the react-router nav alongside River/Thread/Pulse/Search. Follows the canonical design system in `src/ui/components/README.md` (six canonical components, inline-style policy, IBM Plex Mono, dark). Reuses `SessionDrawer` for node detail. No new detail components.
- **Canvas:** Flowgram FreeLayout. NLM's session/edge data is adapted into Flowgram's document model in a thin UI-side adapter (`src/ui/lib/graph-document.ts`): sessions -> nodes, `session_edges` -> edges, entity co-occurrence -> overlay edges. This adapter is the only Flowgram-shaped code; the rest of the app stays framework-agnostic.
- **Read endpoint:** `GET /api/graph?focus=<sessionId|entity>&hops=<n>` in `src/http/` returns the capped ego-graph (nodes + edges + status + entity tags). Server-side capping keeps the payload small.
- **Write path:** existing `mark_superseded` + new `unmark_superseded`, both as `core/actions` functions wired at the composition root (`src/cli/nlm.ts`), exposed over MCP (`src/mcp/server.ts`) and HTTP.
- **No daemon bind change.** Remote access stays via Tailscale Serve. Loopback only.

## Flowgram bundle go/no-go gate (blocking)

Flowgram is a heavy, young dependency, and NLM ships a small UI bundle scp'd to the Pro (`dist/ui/`). Before any feature code:

1. Spike: add Flowgram FreeLayout to a throwaway branch, render ~30 static nodes, measure the **gzipped bundle delta** and cold-render time.
2. **Go criteria (proposed, confirm before spike):** gzipped delta under ~250KB and no regression to first-paint of existing pages (Flowgram lazy-loaded on the Graph route only, never in the main chunk).
3. If it fails the gate: fall back to React Flow for a view-first graph and defer edit-by-drag, or reconsider the whole feature. The gate result is recorded in this doc before the plan is written.

Lazy-loading the Graph route so Flowgram never enters the initial bundle is a hard requirement regardless of the gate outcome.

## Testing

- **Contract:** `unmark_superseded` action (edge removed, status correctly recomputed via live-status, still-superseded-if-other-edges case, audit reversal written, idempotency, unknown-id error) mirroring the existing `mark_superseded` tests.
- **Integration:** `GET /api/graph` capping, focus-by-session vs focus-by-entity, supersedence chain always-included invariant.
- **UI:** graph-document adapter (session/edge -> Flowgram doc), edge-create gesture -> confirm/reason -> action call, edge-remove flow. Follows the repo's Vitest + TDD-leaning convention.

## Open questions

1. **Entity edges in v1 or defer?** They add clustering value but also visual noise and a second query path. Option: ship supersedence-only in v1, add the entity overlay as a toggle in v1.1.
2. **Default hop count and node cap.** N=1 / 60 nodes proposed; needs a check against real corpus density (how wide is a typical entity neighborhood).
3. **Does removing a supersedence edge need its own reason as strongly as creating one?** Proposed: optional reason, always-logged reversal. Confirm this matches the audit intent.
4. **Bundle gate thresholds** (see gate section) need Edward's sign-off before the spike.
5. **CLI parity:** should `unmark_superseded` also get a `nlm` CLI subcommand alongside the existing `supersede` command (`src/cli/supersede.ts`)? Likely yes for symmetry, but out of the UI critical path.

## Rollout

1. Bundle go/no-go spike (blocking gate).
2. `unmark_superseded` action + MCP tool + tests (backend, shippable independently, useful even without the UI).
3. `GET /api/graph` read endpoint + tests.
4. `Graph.tsx` view-only (nodes, supersedence edges, focus, SessionDrawer wiring).
5. Edit gestures (draw edge -> `mark_superseded`, remove edge -> `unmark_superseded`) with confirm/reason.
6. Optional: entity overlay toggle, CLI parity.

Steps 2-3 have standalone value and de-risk the feature before any Flowgram commitment.
