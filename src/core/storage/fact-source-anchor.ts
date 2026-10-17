import type { SourceAnchor } from "@shared/types.js";
import { validateSourceAnchor } from "@core/facts/source-anchor.js";

export interface SourceAnchorRow {
  source_start: number | null;
  source_end: number | null;
  source_body_version: string | null;
  source_quote_status: string | null;
  current_source_body_version?: string | null;
}

export const SOURCE_ANCHOR_COLUMNS = "source_start, source_end, source_body_version, source_quote_status, current_source_body_version";

export function anchorColumns(anchor: SourceAnchor | undefined): SourceAnchorRow {
  return {
    source_start: anchor?.status === "verified" ? anchor.start : null,
    source_end: anchor?.status === "verified" ? anchor.end : null,
    source_body_version: anchor && "bodyVersion" in anchor ? anchor.bodyVersion ?? null : null,
    source_quote_status: anchor?.status ?? null,
  };
}

export function anchorValues(anchor: SourceAnchor | undefined): readonly [number | null, number | null, string | null, string | null] {
  const columns = anchorColumns(anchor);
  return [columns.source_start, columns.source_end, columns.source_body_version, columns.source_quote_status];
}

export function anchorFromRow(row: SourceAnchorRow, quote: string | null): SourceAnchor {
  const status = row.source_quote_status;
  if (status === null) return { status: "missing" };
  if (status === "missing" || status === "stale") return { status };
  if (status === "invalid" || status === "ambiguous") return validateSourceAnchor({ status,
    ...(row.source_body_version ? { bodyVersion: row.source_body_version } : {}) }, row.current_source_body_version);
  if (status !== "verified" || row.source_start === null || row.source_end === null || !row.source_body_version || !quote || row.source_end - row.source_start !== quote.length) return { status: "invalid" };
  return validateSourceAnchor({ status, start: row.source_start, end: row.source_end, bodyVersion: row.source_body_version }, row.current_source_body_version);
}
