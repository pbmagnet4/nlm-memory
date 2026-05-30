/**
 * Append-only JSONL audit log for post-hoc supersedence mutations. One line
 * per `mark_superseded` MCP call (or future UI action). Atomic-on-insert
 * supersedence at ingest time is not logged here — that lineage is already
 * implicit in the session_edges row's predecessor reference.
 *
 * Path defaults to ~/.nlm/supersedence-log.jsonl, overridable via
 * NLM_SUPERSEDENCE_LOG. Telemetry path — never raises, but on failure it
 * emits one warning line to stderr so a silent disk-full or permission
 * issue doesn't leave the operator believing their audit trail is intact.
 */
export interface SupersedenceEntry {
    readonly predecessorId: string;
    readonly successorId: string;
    readonly reason?: string;
    readonly source?: string;
}
export declare function appendSupersedence(entry: SupersedenceEntry, logPath?: string): Promise<void>;
