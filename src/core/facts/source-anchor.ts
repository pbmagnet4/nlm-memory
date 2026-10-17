import type { Fact, Session, SourceAnchor } from "@shared/types.js";
import { bodyVersion } from "@core/context/source-version.js";

type LiteralRange =
  | { readonly status: "verified"; readonly start: number; readonly end: number }
  | { readonly status: "invalid" | "ambiguous" }
  | { readonly status: "missing" };

export function locateLiteralRange(body: string, quote: string | undefined): LiteralRange {
  if (!quote) return { status: "missing" };
  const start = body.indexOf(quote);
  if (start < 0) return { status: "invalid" };
  // Advance one code unit, not quote.length: overlapping occurrences count.
  if (body.indexOf(quote, start + 1) >= 0) return { status: "ambiguous" };
  return { status: "verified", start, end: start + quote.length };
}

export function locateSourceAnchor(body: string, quote: string | undefined): SourceAnchor {
  const range = locateLiteralRange(body, quote);
  return range.status === "missing" ? range : { ...range, bodyVersion: bodyVersion(body) };
}

export function validateSourceAnchor(anchor: SourceAnchor | undefined, currentVersion: string | null | undefined): SourceAnchor {
  if (!anchor) return { status: "missing" };
  if (anchor.status === "missing" || anchor.status === "stale") return { status: anchor.status };
  if (anchor.status !== "verified" && !anchor.bodyVersion) return { status: anchor.status };
  if (!currentVersion || !/^[a-f0-9]{16}$/.test(currentVersion) || anchor.bodyVersion !== currentVersion) return { status: "stale" };
  if (anchor.status !== "verified") return { status: anchor.status, bodyVersion: currentVersion };
  if (!Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 0 || anchor.end <= anchor.start) return { status: "invalid" };
  return anchor;
}

export function hasCurrentSourceAssessment(anchor: SourceAnchor | undefined, currentVersion: string | null | undefined): boolean {
  const validated = validateSourceAnchor(anchor, currentVersion);
  return validated.status === "verified" || ((validated.status === "invalid" || validated.status === "ambiguous") && !!validated.bodyVersion);
}

/** Boolean-only proof of a literal in this fetched body; never upgrades a stored anchor. */
export function verifySourceQuote(fact: Pick<Fact, "sourceQuote" | "sourceAnchor">, source: Pick<Session, "body" | "bodyVersion"> | undefined): boolean | null {
  if (!fact.sourceQuote) return null;
  if (!source) return false;
  if (hasCurrentSourceAssessment(fact.sourceAnchor, source.bodyVersion)) return fact.sourceAnchor!.status === "verified";
  return locateLiteralRange(source.body, fact.sourceQuote).status === "verified";
}
