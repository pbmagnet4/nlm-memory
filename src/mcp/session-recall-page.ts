import { propertySlug } from "@core/properties/model.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { relevantStrings, transcriptPage } from "@core/context/session-evidence.js";
import type { RecallHit, RecallResult } from "@shared/types.js";

export const sessionRecallInput = z.object({
  property: propertySlug.optional(),
  query: z.string().max(2_000).default(""),
  entity: z.string().min(1).max(500).optional(),
  kind: z.enum(["decision", "open"]).optional(),
  mode: z.enum(["keyword", "semantic", "hybrid"]).default("keyword"),
  limit: z.number().int().min(1).max(100).default(5).describe("Maximum hits per response page."),
  candidateLimit: z.number().int().min(1).max(100).default(10).describe("Candidate window; raising it can change ranking. Keep unchanged while paging."),
  rewrite: z.boolean().optional().describe("Rewrite vague queries before search; defaults to the deployment setting (normally true). Use false for exact tokens."),
  workstream: z.string().min(1).max(500).optional(),
  maxChars: z.number().int().min(2_000).max(20_000).default(8_000).describe("Maximum formatted response characters, not model tokens."),
  cursor: z.string().max(500).optional().describe("nextCursor from the same query, filters, mode, rewrite and candidateLimit."),
});

const cursorSchema = z.object({
  offset: z.number().int().min(1).max(99),
  request: z.string().length(16),
  ranking: z.string().length(16),
});
type Input = z.output<typeof sessionRecallInput>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function readRecallCursor(input: Input, tenantId: string) {
  const request = hash([tenantId, input.query, input.entity, input.kind, input.mode, input.rewrite, input.workstream, input.candidateLimit, input.property]);
  if (!input.cursor) return { offset: 0, request, ranking: null };
  let cursor;
  try {
    cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid recall cursor; restart without cursor.");
  }
  if (cursor.request !== request) throw new Error("Recall cursor does not match this query or scope; restart without cursor.");
  return cursor;
}

function excerpt(text: string, size: number): string {
  return text.length <= size ? text : transcriptPage(text, 0, size).text + "… [shortened]";
}

function compactHit(hit: RecallHit, input: Input, minimal = false) {
  const size = minimal ? 120 : 300;
  const decisions = relevantStrings(hit.decisions, input.query, minimal ? 0 : 2);
  const open = relevantStrings(hit.open, input.query, minimal ? 0 : 1);
  const summary = excerpt(hit.summary, minimal ? 120 : 400);
  return {
    id: hit.id, label: excerpt(hit.label, minimal ? 80 : 180), startedAt: hit.startedAt,
    status: hit.status, supersededBy: hit.supersededBy, summary,
    decisions: decisions.map((s) => excerpt(s, size)), open: open.map((s) => excerpt(s, size)),
    omitted: {
      entities: hit.entities.length,
      decisions: hit.decisions.length - decisions.length, open: hit.open.length - open.length,
      shortenedText: summary !== hit.summary || hit.label.length > (minimal ? 80 : 180)
        || [...decisions, ...open].some((s) => s.length > size),
    },
    expand: { id: hit.id, ...(input.workstream ? { workstream: input.workstream } : {}),
      ...(input.query.length <= 300 && input.query ? { query: input.query } : {}) },
  };
}

export function sessionRecallPage(
  result: RecallResult, input: Input, cursor: ReturnType<typeof readRecallCursor>,
  format: (value: unknown) => string,
) {
  const ranking = hash(result.results.map((hit) => hit.id));
  if (cursor.ranking && cursor.ranking !== ranking) throw new Error("Recall results changed; restart without cursor.");
  if (cursor.offset > 0 && cursor.offset >= result.results.length) throw new Error("Recall cursor is past the result window; restart without cursor.");
  const results: ReturnType<typeof compactHit>[] = [];
  const envelope = () => {
    const end = cursor.offset + results.length;
    const hasMore = end < result.results.length;
    return {
      mode: result.mode, entity: result.entity, kind: result.kind, limit: input.limit,
      candidateLimit: input.candidateLimit, total: result.total, availableResults: result.results.length,
      outsideWindow: Math.max(0, result.total - result.results.length),
      ...(result.modeUnavailable ? { modeUnavailable: result.modeUnavailable } : {}),
      results, omittedResults: result.results.length - end, has_more: hasMore,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ offset: end, request: cursor.request, ranking })).toString("base64url") : null,
    };
  };
  for (const hit of result.results.slice(cursor.offset, cursor.offset + input.limit)) {
    results.push(compactHit(hit, input));
    if (format(envelope()).length <= input.maxChars) continue;
    if (results.length === 1) {
      results[0] = compactHit(hit, input, true);
      if (format(envelope()).length <= input.maxChars) continue;
      throw new Error("Response metadata exceeds maxChars; increase the budget or narrow the query.");
    }
    results.pop();
    break;
  }
  const payload = envelope();
  const text = format(payload);
  if (text.length > input.maxChars) throw new Error("Response metadata exceeds maxChars; increase the budget.");
  return { text, returnedIds: results.map((hit) => hit.id) };
}
