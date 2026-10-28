/**
 * T1142 L2 labeller: a model labels the blinded cards through the LiteLLM gateway.
 *   NLM_CLASSIFIER_BASE_URL=... NLM_CLASSIFIER_API_KEY=... tsx scripts/eval/property-holdout-l2.ts <run-dir> [--model <alias>]
 * Temperature 0, thinking switched off for these requests only; gateway settings are never touched.
 */
import { Command } from "commander";
import { gatewayComplete, runL2 } from "./lib/property-holdout-l2.js";

const DEFAULT_MODEL = process.env["NLM_CLASSIFIER_MODEL"] ?? "qwen3:4b-instruct-2507-q4_K_M";

new Command().argument("<run-dir>").option("--model <alias>", "gateway model alias", DEFAULT_MODEL)
  .action(async (dir: string, o: { model: string }) => {
    try {
      const baseUrl = process.env["NLM_CLASSIFIER_BASE_URL"];
      if (!baseUrl) throw new Error("NLM_CLASSIFIER_BASE_URL is not set");
      const r = await runL2(dir, o.model, gatewayComplete(baseUrl, process.env["NLM_CLASSIFIER_API_KEY"], o.model));
      console.log(JSON.stringify({ labelled: r.labelled, failures: r.failures.length }));
    } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
  }).parseAsync();
