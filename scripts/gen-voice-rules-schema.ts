/**
 * Generates schemas/voice-rules.schema.json from the zod schema in
 * src/core/voice/rules-schema.ts. Run with: npm run gen:voice-rules-schema
 * The committed output is checked by tests/unit/core/voice/rules.test.ts,
 * which regenerates in memory and compares (design §B invariant 1).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { voiceRulesFileSchema } from "../src/core/voice/rules-schema.js";

/** Repo-root-relative path of the generated artifact. */
export const SCHEMA_OUT_REL = join("schemas", "voice-rules.schema.json");

/** Deterministic JSON text of the schema (tests compare against this). */
export function renderVoiceRulesSchema(): string {
  const json = z.toJSONSchema(voiceRulesFileSchema, { target: "draft-2020-12" });
  return JSON.stringify(json, null, 2) + "\n";
}

function main(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = join(repoRoot, SCHEMA_OUT_REL);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderVoiceRulesSchema());
  console.log(`wrote ${SCHEMA_OUT_REL}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
