/**
 * Computes which session fields a keyword query matched, for the `matchedIn`
 * badge on a RecallHit. Pure function — no DB, no I/O. FTS5 BM25 ranks the
 * whole row; this recovers per-field attribution from the resolved Session,
 * including decisions/open which live in the markers table (not in FTS).
 */
import { tokenSet } from "./tokenize.js";
export function keywordMatchFields(session, queryTokens) {
    if (queryTokens.size === 0)
        return [];
    const fields = [];
    if (overlaps(queryTokens, tokenSet(session.label)))
        fields.push("label");
    if (overlaps(queryTokens, joinedTokens(session.decisions)))
        fields.push("decisions");
    if (overlaps(queryTokens, joinedTokens(session.open)))
        fields.push("open");
    if (overlaps(queryTokens, tokenSet(session.summary)))
        fields.push("summary");
    return fields;
}
function joinedTokens(values) {
    const out = new Set();
    for (const v of values) {
        for (const t of tokenSet(v))
            out.add(t);
    }
    return out;
}
function overlaps(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const item of small)
        if (large.has(item))
            return true;
    return false;
}
//# sourceMappingURL=match-fields.js.map