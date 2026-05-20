/**
 * Computes which session fields a keyword query matched, for the `matchedIn`
 * badge on a RecallHit. Pure function — no DB, no I/O. FTS5 BM25 ranks the
 * whole row; this recovers per-field attribution from the resolved Session,
 * including decisions/open which live in the markers table (not in FTS).
 */
import type { MatchField, Session } from "../../shared/types.js";
type SessionFields = Pick<Session, "label" | "summary" | "decisions" | "open">;
export declare function keywordMatchFields(session: SessionFields, queryTokens: ReadonlySet<string>): ReadonlyArray<MatchField>;
export {};
