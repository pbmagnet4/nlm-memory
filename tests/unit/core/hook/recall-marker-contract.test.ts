/**
 * Drift guard for NLM #325. The injected recall pointer block is rendered in
 * THREE independent places that must agree on the exact header/footer strings:
 *   1. src/core/hook/pointer-block.ts   (daemon, what gets injected at recall)
 *   2. nlm/index.js                     (the SHIPPED pi recall hook — its own
 *                                        self-contained copy of formatPointerBlock)
 *   3. src/core/hook/strip-injected-context.ts (what removes the block before
 *                                        the classifier sees it)
 *
 * strip-injected-context.ts is the single source of truth for the markers
 * (BLOCK_HEADERS / FOOTER_PREFIX). If the shipped pi hook ever changes a marker
 * string without updating the strip, the strip silently stops matching pi-
 * injected blocks and the extractor feedback loop quietly reopens. This test
 * makes that drift fail loudly in CI instead.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCK_HEADERS,
  FOOTER_PREFIX,
  stripInjectedContext,
} from "../../../../src/core/hook/strip-injected-context.js";

const HOOK_SRC = readFileSync(resolve(__dirname, "../../../../nlm/index.js"), "utf8");

describe("recall-hook ↔ stripInjectedContext marker contract", () => {
  it("the shipped pi recall hook emits every marker the strip targets", () => {
    for (const header of BLOCK_HEADERS) {
      expect(HOOK_SRC, `nlm/index.js must emit header "${header}"`).toContain(header);
    }
    expect(HOOK_SRC, `nlm/index.js must emit footer "${FOOTER_PREFIX}"`).toContain(FOOTER_PREFIX);
  });

  it("strips a block built from the canonical markers, keeping the real prompt", () => {
    const block = [
      BLOCK_HEADERS[0],
      "- cc_1 · Prior session (2026-06-17)",
      "",
      BLOCK_HEADERS[1],
      "- acme-app owner: user [3 sessions]",
      `${FOOTER_PREFIX} recall_sessions, get_session, recall_facts, get_fact_history.`,
    ].join("\n");

    const out = stripInjectedContext(`${block}\n\nreal user prompt`);

    for (const header of BLOCK_HEADERS) expect(out).not.toContain(header);
    expect(out).not.toContain(FOOTER_PREFIX);
    expect(out.trim()).toBe("real user prompt");
  });
});
