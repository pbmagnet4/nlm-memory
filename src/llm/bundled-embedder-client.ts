/**
 * BundledEmbedderClient - an embedder that runs nomic-embed-text-v1.5 ONNX
 * in-process via @huggingface/transformers. No external server required.
 *
 * It mirrors OpenAIEmbedderClient's embedding contract exactly: the same
 * nomic asymmetric-retrieval prefixes, the same MAX_EMBED_CHARS truncation,
 * and the same L2-normalization. classify() and rewriteForRecall() throw so a
 * RecallService holding this as its llm degrades to keyword mode rather than
 * crashing.
 *
 * The transformers pipeline is loaded on first embed() call (dynamic import so
 * module parse cost is zero when the provider is not selected). The result is
 * memoized on the instance; subsequent calls reuse it.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
  RewriteResult,
} from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import { EMBED_PREFIXES, MAX_EMBED_CHARS, l2Normalize } from "./ollama-client.js";

/** HuggingFace Hub repo that hosts the ONNX q8 export of nomic-embed-text-v1.5.
 *  Exported so embedder-info can report provenance-consistent model ids. */
export const DEFAULT_MODEL_REPO = "nomic-ai/nomic-embed-text-v1.5";

const EXPECTED_DIMS = 768;

export interface BundledEmbedderOptions {
  /** HF Hub repo id override. Defaults to the nomic-ai repo's onnx export (q8). */
  readonly model?: string;
  /** Cache directory for downloaded model files. Defaults to ~/.nlm/models. */
  readonly modelDir?: string;
}

// Minimal callable shape returned by the transformers feature-extraction pipeline.
type EmbedPipelineFn = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

export class BundledEmbedderClient implements LLMClient {
  private readonly modelRepo: string;
  private readonly modelDir: string;
  private pipelinePromise: Promise<EmbedPipelineFn> | null = null;

  constructor(opts: BundledEmbedderOptions = {}) {
    this.modelRepo = opts.model ?? DEFAULT_MODEL_REPO;
    this.modelDir = opts.modelDir ?? join(homedir(), ".nlm", "models");
  }

  private initPipeline(): Promise<EmbedPipelineFn> {
    if (this.pipelinePromise !== null) return this.pipelinePromise;
    this.pipelinePromise = (async (): Promise<EmbedPipelineFn> => {
      const { pipeline } = await import("@huggingface/transformers");
      // cast through unknown: the FeatureExtractionPipeline return type from
      // transformers.js is structurally compatible but not trivially assignable
      // to our local EmbedPipelineFn alias.
      const pipe = (await (
        pipeline as unknown as (
          task: string,
          model: string,
          opts: { dtype: string; cache_dir: string },
        ) => Promise<EmbedPipelineFn>
      )("feature-extraction", this.modelRepo, {
        dtype: "q8",
        cache_dir: this.modelDir,
      }));
      return pipe;
    })().catch((e: unknown) => {
      // A memoized rejection would poison every later embed. The dominant
      // failure mode is a transient one (offline during the first-run model
      // download), so clear the memo and let the next call retry.
      this.pipelinePromise = null;
      throw e;
    });
    return this.pipelinePromise;
  }

  async embed(text: string, kind: EmbeddingKind): Promise<EmbedResult> {
    const input = `${EMBED_PREFIXES[kind]}${text.slice(0, MAX_EMBED_CHARS)}`;
    let pipe: EmbedPipelineFn;
    try {
      pipe = await this.initPipeline();
    } catch (e) {
      throw new LLMUnreachableError("bundled-embedder", e);
    }
    let result: { data: Float32Array };
    try {
      result = await pipe(input, { pooling: "mean", normalize: true });
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("bundled-embedder", e);
    }
    const vec = result.data;
    if (vec.length !== EXPECTED_DIMS) {
      throw new LLMUnreachableError(
        "bundled-embedder",
        `expected ${EXPECTED_DIMS} dimensions, got ${vec.length}`,
      );
    }
    // Report the repo actually in use so embedding_config provenance records
    // a custom opts.model override truthfully. The default construction
    // reports "nomic-ai/nomic-embed-text-v1.5".
    return { vector: l2Normalize(vec), model: this.modelRepo };
  }

  async classify(_transcript: string): Promise<ClassifyResult> {
    throw new LLMUnreachableError(
      "bundled-embedder",
      "classify not supported: BundledEmbedderClient is an embedder only",
    );
  }

  async rewriteForRecall(_query: string): Promise<RewriteResult> {
    throw new LLMUnreachableError(
      "bundled-embedder",
      "rewriteForRecall not supported: BundledEmbedderClient is an embedder only",
    );
  }

  nameWorkstream(): Promise<string | null> {
    throw new Error("BundledEmbedderClient does not support nameWorkstream");
  }
}
