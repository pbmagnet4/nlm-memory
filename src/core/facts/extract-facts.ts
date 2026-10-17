/**
 * extractFacts — pure transform from ClassifyResult to Fact[].
 *
 * Lives in core/, has no framework imports, no clock or randomness coupling
 * (id generator and timestamp are injected so tests are deterministic).
 * Phase B.2 — see docs/plans/factstore-design.md Section 3.
 *
 * Confidence policy (Section 3 of the plan): facts inherit the session-level
 * confidence verbatim. Below 0.4 the function returns an empty array — the
 * session still ingests with markers, but its facts are dropped as
 * extraction-quality noise. Between 0.4 and 0.6 facts are written but will
 * be filtered out of recall by the FactStore default `minConfidence: 0.6`.
 */

import { randomUUID } from "node:crypto";
import type { ClassifyResult } from "@ports/llm-client.js";
import type { Fact } from "@shared/types.js";

import { locateLiteralRange } from "./source-anchor.js";
import { bodyVersion, persistedText } from "@core/context/source-version.js";

const CONFIDENCE_FLOOR = 0.4;

export interface ExtractFactsOptions {
  readonly sourceBody?: string;
  /** Generator for fact ids. Defaults to `fact_<randomUUID()>`. */
  readonly idGenerator?: () => string;
}

export function extractFacts(
  result: ClassifyResult,
  sessionId: string,
  createdAt: string,
  opts: ExtractFactsOptions = {},
): Fact[] {
  if (result.confidence < CONFIDENCE_FLOOR) return [];
  const genId = opts.idGenerator ?? (() => `fact_${randomUUID()}`);
  const out: Fact[] = [];
  const body = opts.sourceBody === undefined ? undefined : persistedText(opts.sourceBody);
  let version: string | undefined;
  for (const raw of result.facts) {
    const quote = raw.sourceQuote === undefined ? undefined : persistedText(raw.sourceQuote);
    const range = body === undefined ? undefined : locateLiteralRange(body, quote);
    const sourceAnchor = range === undefined || range.status === "missing" ? range
      : { ...range, bodyVersion: version ??= bodyVersion(body!) };
    out.push({
      id: genId(),
      kind: raw.kind,
      subject: raw.subject,
      predicate: raw.predicate,
      value: raw.value,
      sourceSessionId: sessionId,
      sourceQuote: quote ?? null,
      ...(sourceAnchor === undefined ? {} : { sourceAnchor }),
      createdAt,
      supersededBy: null,
      confidence: result.confidence,
    });
  }
  return out;
}
