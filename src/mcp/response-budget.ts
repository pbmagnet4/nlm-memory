export function boundedFormat(data: unknown, format: (value: unknown) => string, maxChars = 25_000): string {
  const original = format(data);
  if (original.length <= maxChars) return original;
  // Keep identifiers and the shape of complete records; visibly mark shortened
  // text. This is the last-resort guard, after tool-specific evidence selection.
  for (const limit of [2_000, 1_000, 400, 120]) {
    const reduced = compact(data, limit, Math.max(1, Math.floor(limit / 200)));
    const result = format({ ...(reduced as Record<string, unknown>), truncated: true,
      truncation_message: "Partial result. Expand a source with get_session(id, query) or get_session(id, view='transcript', offset)." });
    if (result.length <= maxChars) return result;
  }
  throw new Error("Response metadata exceeds the response budget; narrow the query.");
}

function compact(value: unknown, textLimit: number, itemLimit: number): unknown {
  if (typeof value === "string") return value.length <= textLimit ? value : value.slice(0, textLimit) + "… [shortened]";
  if (Array.isArray(value)) return value.slice(0, itemLimit).map((v) => compact(v, textLimit, itemLimit));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
      /^(id|.*Id|supersededBy|subject|predicate|workstream)$/.test(key) ? v : compact(v, textLimit, itemLimit)]));
  }
  return value;
}
