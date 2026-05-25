/**
 * Curated catalog of Ollama-pullable open-source models.
 *
 * This is the source of truth for the in-app Model Marketplace. We
 * deliberately keep it as static frontend data (not a remote fetch)
 * because:
 *
 *   1. The marketplace must work offline — users will read this list
 *      while Ollama is still being installed and the network is the
 *      *thing they're trying to avoid relying on*.
 *   2. We need rich, hand-tuned metadata (license, RAM heuristics, quality
 *      rank, fit hints) that's not available from any single upstream API
 *      — Ollama's registry has tag names, HF has model cards, neither has
 *      both.
 *   3. Curation is part of the product. The marketplace deliberately
 *      surfaces the ~50 models we know are worth a developer's time
 *      rather than the 700,000 random GGUFs on HuggingFace.
 *
 * Numbers come from:
 *   - Disk size: actual Q4_K_M file size when known, else `params * 0.6`
 *     (the empirical mean for Q4_K_M quantization).
 *   - Min RAM: disk * 1.25 (loaded model overhead) + 1.0 GB (context +
 *     framework). Rounded up to the nearest 0.5 GB.
 *   - Recommended RAM: min * 1.6 (rule of thumb: leaves room for the OS
 *     and another running model loaded for FIM).
 *
 * When updating: add new variants at the *bottom* of each family block
 * to keep test snapshots and existing UI orderings stable.
 */

import type { AiFeature } from "@/store/settings";

export type ModelSource = "ollama" | "hf-gguf";

export type CatalogEntry = {
  /** Exact Ollama tag, e.g. "qwen2.5-coder:7b-instruct". Pull via `ollama pull <id>`. */
  id: string;
  /** Family identifier (no tag), e.g. "qwen2.5-coder". Used for grouping in UI. */
  family: string;
  /** Human-friendly heading, e.g. "Qwen 2.5 Coder 7B". */
  displayName: string;
  /** Publisher / lab, e.g. "Qwen", "DeepSeek", "Meta". */
  publisher: string;
  /** Approximate parameter count in *billions*. Used for size hints + search. */
  params: number;
  /** Approx disk footprint in GB (default Q4_K_M unless overridden by tag). */
  diskGb: number;
  /** Lower bound on system RAM (incl. swap) needed to load + serve. */
  minRamGb: number;
  /** Comfortable RAM for the loaded model + the OS + another light app. */
  recommendedRamGb: number;
  /** Context window in tokens. */
  contextTokens: number;
  /** Default quantization Ollama ships for this tag, e.g. "Q4_K_M". */
  quantization: string;
  /** Which Pointer slots this model is meaningfully useful for. */
  categories: AiFeature[];
  /** The slot it's *best* at. The marketplace uses this for default ranking. */
  primaryCategory: AiFeature;
  /** License identifier. We don't gate on this, just surface it. */
  license: string;
  /** One-sentence pitch shown directly on the card. */
  description: string;
  /** Bullets shown in the expanded card. */
  strengths: string[];
  /** Honest trade-offs. */
  weaknesses: string[];
  /** 1 = best in the primary category. Lower is better. */
  qualityRank: number;
  /** 1 = most pulled / talked-about within this category. Lower is better. */
  popularityRank: number;
  /** How the entry installs: Ollama registry pull is the default. */
  source: ModelSource;
  /** Free-text tags used by the search ranker. */
  tags: string[];
};

// ---------------------------------------------------------------------------
// Helpers for catalog authoring. Pure data below — no I/O.
// ---------------------------------------------------------------------------

/**
 * Estimate a model entry's disk + RAM footprint from its parameter count
 * and quantization. The catalog overrides these per-entry, but for the
 * many variants of e.g. Qwen 2.5 the formula is accurate enough to skip
 * hand-coding every row.
 */
export function estimateFootprint(
  paramsB: number,
  quant: string,
): { diskGb: number; minRamGb: number; recommendedRamGb: number } {
  // Bytes-per-parameter table. Q4_K_M = 4.5 bits ~= 0.56 bytes. BF16 = 2.
  const bpp: Record<string, number> = {
    Q2_K: 0.4,
    Q3_K_M: 0.5,
    Q4_0: 0.55,
    Q4_K_M: 0.6,
    Q5_K_M: 0.7,
    Q6_K: 0.82,
    Q8_0: 1.06,
    FP16: 2.0,
    BF16: 2.0,
  };
  const b = bpp[quant.toUpperCase()] ?? 0.6;
  const diskGb = round2(paramsB * b);
  // Loaded weight + KV cache for a typical 8k ctx ≈ disk * 1.25 + 0.8.
  const minRamGb = roundHalfUp(diskGb * 1.25 + 0.8);
  const recommendedRamGb = roundHalfUp(minRamGb * 1.6);
  return { diskGb, minRamGb, recommendedRamGb };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function roundHalfUp(n: number): number {
  return Math.round(n * 2) / 2;
}

// Convenience builder that fills in the footprint heuristically. Use when
// the catalog row's defaults are good enough; pass an override object to
// pin specific values (e.g. a model we actually measured).
function entry(e: {
  id: string;
  family: string;
  displayName: string;
  publisher: string;
  params: number;
  quantization?: string;
  contextTokens?: number;
  categories: AiFeature[];
  primaryCategory: AiFeature;
  license: string;
  description: string;
  strengths: string[];
  weaknesses?: string[];
  qualityRank: number;
  popularityRank: number;
  source?: ModelSource;
  tags?: string[];
  /** Hand-overrides if we have measured numbers. */
  diskGb?: number;
  minRamGb?: number;
  recommendedRamGb?: number;
}): CatalogEntry {
  const quant = e.quantization ?? "Q4_K_M";
  const est = estimateFootprint(e.params, quant);
  return {
    id: e.id,
    family: e.family,
    displayName: e.displayName,
    publisher: e.publisher,
    params: e.params,
    diskGb: e.diskGb ?? est.diskGb,
    minRamGb: e.minRamGb ?? est.minRamGb,
    recommendedRamGb: e.recommendedRamGb ?? est.recommendedRamGb,
    contextTokens: e.contextTokens ?? 32_768,
    quantization: quant,
    categories: e.categories,
    primaryCategory: e.primaryCategory,
    license: e.license,
    description: e.description,
    strengths: e.strengths,
    weaknesses: e.weaknesses ?? [],
    qualityRank: e.qualityRank,
    popularityRank: e.popularityRank,
    source: e.source ?? "ollama",
    tags: e.tags ?? [],
  };
}

// ---------------------------------------------------------------------------
// THE CATALOG. Grouped by family for readability; consumers iterate flat.
// Update protocol: bump `qualityRank` / `popularityRank` carefully — those
// are *relative within category*, so a new entry shouldn't silently
// renumber every existing one.
// ---------------------------------------------------------------------------

/* eslint-disable prettier/prettier */

const QWEN_25_CODER: CatalogEntry[] = [
  entry({
    id: "qwen2.5-coder:1.5b-base", family: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder 1.5B (base)", publisher: "Qwen",
    params: 1.5, contextTokens: 32_768,
    categories: ["fim"], primaryCategory: "fim",
    license: "Apache-2.0",
    description: "Tiny coder base model tuned for fill-in-the-middle completions. Sub-30ms latency on most laptops.",
    strengths: ["Very fast tab completion", "Runs on 8GB MacBooks"],
    weaknesses: ["Misses on complex multi-line completions"],
    qualityRank: 3, popularityRank: 2,
    tags: ["coder", "fim", "base", "fast", "small"],
  }),
  entry({
    id: "qwen2.5-coder:3b-base", family: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder 3B (base)", publisher: "Qwen",
    params: 3, contextTokens: 32_768,
    categories: ["fim"], primaryCategory: "fim",
    license: "Apache-2.0",
    description: "Best balance of quality vs latency for FIM. The default we recommend on 16GB machines.",
    strengths: ["High-quality completions", "Still under 100ms on M-series Macs"],
    qualityRank: 1, popularityRank: 1,
    tags: ["coder", "fim", "base", "recommended"],
  }),
  entry({
    id: "qwen2.5-coder:7b-base", family: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder 7B (base)", publisher: "Qwen",
    params: 7, contextTokens: 32_768,
    categories: ["fim"], primaryCategory: "fim",
    license: "Apache-2.0",
    description: "Highest-quality FIM in this family — pick this only if you can spare the latency.",
    strengths: ["Best completion accuracy"],
    weaknesses: ["Slower than 3B for most editors"],
    qualityRank: 2, popularityRank: 4,
    tags: ["coder", "fim", "base"],
  }),
  entry({
    id: "qwen2.5-coder:7b-instruct", family: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder 7B", publisher: "Qwen",
    params: 7, contextTokens: 32_768,
    categories: ["chat", "agent", "inlineEdit"], primaryCategory: "chat",
    license: "Apache-2.0",
    description: "Strong general coding chat / agent model that fits on 16GB machines. Pointer's default chat pick.",
    strengths: ["Reliable JSON tool calls for the agent harness", "Good refactor suggestions"],
    qualityRank: 2, popularityRank: 1,
    tags: ["coder", "chat", "agent", "instruct", "recommended"],
  }),
  entry({
    id: "qwen2.5-coder:14b-instruct", family: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder 14B", publisher: "Qwen",
    params: 14, contextTokens: 32_768,
    categories: ["chat", "agent", "inlineEdit"], primaryCategory: "agent",
    license: "Apache-2.0",
    description: "Sweet spot for 32GB+ machines. Materially better at multi-step refactors than the 7B.",
    strengths: ["Strong agent reasoning", "Excellent at large diffs"],
    qualityRank: 1, popularityRank: 2,
    tags: ["coder", "chat", "agent", "instruct"],
  }),
  entry({
    id: "qwen2.5-coder:32b-instruct", family: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder 32B", publisher: "Qwen",
    params: 32, contextTokens: 32_768,
    categories: ["chat", "agent", "inlineEdit", "document"], primaryCategory: "agent",
    license: "Apache-2.0",
    description: "Top open-source coder for agentic work. Needs ~24GB of free RAM.",
    strengths: ["Closest open analogue to commercial agents", "Handles 30+ tool calls reliably"],
    weaknesses: ["Slow on CPU-only machines"],
    qualityRank: 1, popularityRank: 3,
    tags: ["coder", "chat", "agent", "instruct", "best"],
  }),
];

const QWEN_25_GENERAL: CatalogEntry[] = [
  entry({
    id: "qwen2.5:7b", family: "qwen2.5",
    displayName: "Qwen 2.5 7B (general)", publisher: "Qwen",
    params: 7, contextTokens: 32_768,
    categories: ["chat", "document"], primaryCategory: "chat",
    license: "Apache-2.0",
    description: "Strong all-rounder when you need non-code chat (research, writing).",
    strengths: ["Good general knowledge", "Tight instruction following"],
    qualityRank: 4, popularityRank: 5,
    tags: ["general", "chat", "instruct"],
  }),
  entry({
    id: "qwen2.5:14b", family: "qwen2.5",
    displayName: "Qwen 2.5 14B (general)", publisher: "Qwen",
    params: 14, contextTokens: 32_768,
    categories: ["chat", "document", "agent"], primaryCategory: "chat",
    license: "Apache-2.0",
    description: "Sharp reasoning for a 14B. Solid pick when you want one model for chat + docs.",
    strengths: ["Beats Llama 3.1 8B on most evals", "Long-context aware"],
    qualityRank: 3, popularityRank: 6,
    tags: ["general", "chat", "instruct"],
  }),
];

const LLAMA_FAMILY: CatalogEntry[] = [
  entry({
    id: "llama3.2:1b", family: "llama3.2",
    displayName: "Llama 3.2 1B", publisher: "Meta",
    params: 1, contextTokens: 131_072,
    categories: ["chat", "document"], primaryCategory: "document",
    license: "Llama 3.2 Community",
    description: "Featherweight model for quick summaries and chat on low-RAM hardware.",
    strengths: ["Runs on a Raspberry Pi", "128k context"],
    weaknesses: ["Hallucinates more than larger siblings"],
    qualityRank: 6, popularityRank: 7,
    tags: ["general", "chat", "small"],
  }),
  entry({
    id: "llama3.2:3b", family: "llama3.2",
    displayName: "Llama 3.2 3B", publisher: "Meta",
    params: 3, contextTokens: 131_072,
    categories: ["chat", "document"], primaryCategory: "chat",
    license: "Llama 3.2 Community",
    description: "Strong tiny chat model with full 128k context — great for document Q&A on 8GB machines.",
    strengths: ["Long-context summarisation", "Surprisingly coherent for 3B"],
    qualityRank: 5, popularityRank: 4,
    tags: ["general", "chat", "small", "document", "long-context"],
  }),
  entry({
    id: "llama3.1:8b", family: "llama3.1",
    displayName: "Llama 3.1 8B", publisher: "Meta",
    params: 8, contextTokens: 131_072,
    categories: ["chat", "document", "agent"], primaryCategory: "chat",
    license: "Llama 3.1 Community",
    description: "The most-pulled local chat model. Solid baseline for everything but heavy code work.",
    strengths: ["Battle-tested", "Tons of community fine-tunes"],
    weaknesses: ["Coder variants below outperform it for refactors"],
    qualityRank: 4, popularityRank: 2,
    tags: ["general", "chat", "instruct", "long-context"],
  }),
  entry({
    id: "llama3.3:70b", family: "llama3.3",
    displayName: "Llama 3.3 70B", publisher: "Meta",
    params: 70, contextTokens: 131_072,
    categories: ["chat", "agent", "document"], primaryCategory: "chat",
    license: "Llama 3.3 Community",
    description: "Closed-frontier-class quality for users with ≥48GB unified memory.",
    strengths: ["Best open general chat", "Strong refusal-handling"],
    weaknesses: ["Slow on consumer GPUs"],
    qualityRank: 1, popularityRank: 5,
    tags: ["general", "chat", "big", "best"],
  }),
];

const DEEPSEEK: CatalogEntry[] = [
  entry({
    id: "deepseek-coder:1.3b-base", family: "deepseek-coder",
    displayName: "DeepSeek Coder 1.3B (base)", publisher: "DeepSeek",
    params: 1.3, contextTokens: 16_384,
    categories: ["fim"], primaryCategory: "fim",
    license: "DeepSeek License (research + non-commercial)",
    description: "Original FIM workhorse. Still competitive on small machines.",
    strengths: ["Very fast"], weaknesses: ["Non-permissive license"],
    qualityRank: 4, popularityRank: 3,
    tags: ["coder", "fim", "base", "small"],
  }),
  entry({
    id: "deepseek-coder:6.7b-base", family: "deepseek-coder",
    displayName: "DeepSeek Coder 6.7B (base)", publisher: "DeepSeek",
    params: 6.7, contextTokens: 16_384,
    categories: ["fim"], primaryCategory: "fim",
    license: "DeepSeek License (research + non-commercial)",
    description: "Higher-quality FIM model from DeepSeek's original release.",
    strengths: ["Strong FIM accuracy"], weaknesses: ["Non-permissive license"],
    qualityRank: 3, popularityRank: 6,
    tags: ["coder", "fim", "base"],
  }),
  entry({
    id: "deepseek-coder-v2:16b", family: "deepseek-coder-v2",
    displayName: "DeepSeek Coder V2 16B (MoE)", publisher: "DeepSeek",
    params: 16, diskGb: 8.9, minRamGb: 12, recommendedRamGb: 20,
    contextTokens: 128_000,
    categories: ["chat", "agent", "inlineEdit"], primaryCategory: "chat",
    license: "DeepSeek License (commercial OK with attribution)",
    description: "Mixture-of-experts; only ~2.4B parameters active per token — fast for its size.",
    strengths: ["Long context", "Strong refactoring", "Faster than dense 16B"],
    qualityRank: 3, popularityRank: 4,
    tags: ["coder", "chat", "agent", "moe", "long-context"],
  }),
  entry({
    id: "deepseek-r1:7b", family: "deepseek-r1",
    displayName: "DeepSeek R1 7B (thinking)", publisher: "DeepSeek",
    params: 7, contextTokens: 32_768,
    categories: ["chat"], primaryCategory: "chat",
    license: "MIT",
    description: "First open thinking model in this size class. Emits `<think>` blocks before answering.",
    strengths: ["Better multi-step reasoning than non-thinking 7B's"],
    weaknesses: ["Bad fit for tab completion", "Latency varies wildly per response"],
    qualityRank: 5, popularityRank: 8,
    tags: ["chat", "thinking", "reasoning"],
  }),
  entry({
    id: "deepseek-r1:32b", family: "deepseek-r1",
    displayName: "DeepSeek R1 32B (thinking)", publisher: "DeepSeek",
    params: 32, contextTokens: 32_768,
    categories: ["chat", "agent"], primaryCategory: "agent",
    license: "MIT",
    description: "Thinking model strong enough for agentic planning on ≥32GB machines.",
    strengths: ["Excellent at planning", "MIT licensed"],
    weaknesses: ["Verbose; not ideal for streaming UIs"],
    qualityRank: 2, popularityRank: 6,
    tags: ["chat", "agent", "thinking", "reasoning", "best"],
  }),
];

const STARCODER_CODESTRAL: CatalogEntry[] = [
  entry({
    id: "starcoder2:3b", family: "starcoder2",
    displayName: "StarCoder 2 3B", publisher: "BigCode",
    params: 3, contextTokens: 16_384,
    categories: ["fim"], primaryCategory: "fim",
    license: "BigCode OpenRAIL-M",
    description: "Multi-language FIM with 600+ programming languages in its training mix.",
    strengths: ["Broad language coverage"],
    qualityRank: 6, popularityRank: 5,
    tags: ["coder", "fim", "base", "multi-language"],
  }),
  entry({
    id: "starcoder2:7b", family: "starcoder2",
    displayName: "StarCoder 2 7B", publisher: "BigCode",
    params: 7, contextTokens: 16_384,
    categories: ["fim"], primaryCategory: "fim",
    license: "BigCode OpenRAIL-M",
    description: "Larger StarCoder for tab completion — pick when Qwen Coder 7B is unavailable.",
    strengths: ["Permissive license"],
    qualityRank: 5, popularityRank: 7,
    tags: ["coder", "fim", "base"],
  }),
  entry({
    id: "codestral:22b", family: "codestral",
    displayName: "Codestral 22B", publisher: "Mistral",
    params: 22, contextTokens: 32_768,
    categories: ["fim", "chat", "agent"], primaryCategory: "fim",
    license: "Mistral Non-Production License (no commercial)",
    description: "Mistral's coder model. Strong but the license blocks production usage.",
    strengths: ["High FIM quality"],
    weaknesses: ["Non-commercial license"],
    qualityRank: 4, popularityRank: 6,
    tags: ["coder", "fim", "chat"],
  }),
];

const MISTRAL_GEMMA_PHI: CatalogEntry[] = [
  entry({
    id: "mistral:7b", family: "mistral",
    displayName: "Mistral 7B (instruct)", publisher: "Mistral",
    params: 7, contextTokens: 32_768,
    categories: ["chat", "document"], primaryCategory: "chat",
    license: "Apache-2.0",
    description: "Original Mistral 7B — still a great general baseline.",
    strengths: ["Permissive license", "Sturdy long-form writing"],
    qualityRank: 6, popularityRank: 6,
    tags: ["general", "chat", "instruct"],
  }),
  entry({
    id: "mistral-nemo:12b", family: "mistral-nemo",
    displayName: "Mistral Nemo 12B", publisher: "Mistral × NVIDIA",
    params: 12, contextTokens: 128_000,
    categories: ["chat", "document", "agent"], primaryCategory: "document",
    license: "Apache-2.0",
    description: "128k-context Mistral — purpose-built for long-document Q&A.",
    strengths: ["Long context", "Permissive license"],
    qualityRank: 3, popularityRank: 5,
    tags: ["general", "chat", "long-context", "document"],
  }),
  entry({
    id: "mistral-small:24b", family: "mistral-small",
    displayName: "Mistral Small 24B", publisher: "Mistral",
    params: 24, contextTokens: 32_768,
    categories: ["chat", "agent", "document"], primaryCategory: "chat",
    license: "Apache-2.0",
    description: "Mistral's newest 24B — beats Llama 3.1 70B on several reasoning evals.",
    strengths: ["Strong reasoning", "Apache 2.0"],
    qualityRank: 2, popularityRank: 6,
    tags: ["general", "chat", "agent", "best"],
  }),
  entry({
    id: "gemma3:4b", family: "gemma3",
    displayName: "Gemma 3 4B", publisher: "Google",
    params: 4, contextTokens: 8_192,
    categories: ["chat", "document"], primaryCategory: "document",
    license: "Gemma Terms of Use",
    description: "Compact Google model with a polished writing voice.",
    strengths: ["Clean prose"], qualityRank: 5, popularityRank: 7,
    tags: ["general", "chat", "small"],
  }),
  entry({
    id: "gemma3:12b", family: "gemma3",
    displayName: "Gemma 3 12B", publisher: "Google",
    params: 12, contextTokens: 8_192,
    categories: ["chat", "document"], primaryCategory: "chat",
    license: "Gemma Terms of Use",
    description: "Stronger Gemma; reliable on writing-heavy work.",
    strengths: ["Good summaries"], qualityRank: 4, popularityRank: 8,
    tags: ["general", "chat"],
  }),
  entry({
    id: "phi-4:14b", family: "phi-4",
    displayName: "Phi-4 14B", publisher: "Microsoft",
    params: 14, contextTokens: 16_384,
    categories: ["chat", "document", "agent"], primaryCategory: "chat",
    license: "MIT",
    description: "Microsoft's lean 14B — punches above its weight on reasoning benchmarks.",
    strengths: ["MIT", "Strong reasoning per byte"],
    qualityRank: 3, popularityRank: 7,
    tags: ["general", "chat", "instruct"],
  }),
];

const EMBEDDING: CatalogEntry[] = [
  entry({
    id: "nomic-embed-text:latest", family: "nomic-embed",
    displayName: "Nomic Embed Text v1.5", publisher: "Nomic",
    params: 0.137, diskGb: 0.27, minRamGb: 1, recommendedRamGb: 1.5,
    contextTokens: 8192,
    categories: ["indexing"], primaryCategory: "indexing",
    license: "Apache-2.0",
    description: "The default embedding model for Pointer's @codebase search. Small, fast, accurate.",
    strengths: ["Apache 2.0", "Matryoshka representation (truncatable)"],
    qualityRank: 1, popularityRank: 1,
    tags: ["embed", "indexing", "small", "recommended"],
  }),
  entry({
    id: "mxbai-embed-large:latest", family: "mxbai-embed",
    displayName: "Mixedbread Embed Large", publisher: "Mixedbread",
    params: 0.335, diskGb: 0.67, minRamGb: 1.5, recommendedRamGb: 2,
    contextTokens: 512,
    categories: ["indexing"], primaryCategory: "indexing",
    license: "Apache-2.0",
    description: "Larger embedder with stronger retrieval on technical content. Trade size for recall.",
    strengths: ["Better recall on code"], weaknesses: ["512-token cap"],
    qualityRank: 2, popularityRank: 2,
    tags: ["embed", "indexing"],
  }),
  entry({
    id: "bge-large:latest", family: "bge",
    displayName: "BGE Large", publisher: "BAAI",
    params: 0.335, diskGb: 0.67, minRamGb: 1.5, recommendedRamGb: 2,
    contextTokens: 512,
    categories: ["indexing"], primaryCategory: "indexing",
    license: "MIT",
    description: "Stalwart BGE encoder — wide community support and well-validated.",
    strengths: ["Permissive license"],
    qualityRank: 3, popularityRank: 3,
    tags: ["embed", "indexing"],
  }),
  entry({
    id: "bge-m3:latest", family: "bge-m3",
    displayName: "BGE-M3 (multilingual)", publisher: "BAAI",
    params: 0.567, diskGb: 1.1, minRamGb: 2, recommendedRamGb: 3,
    contextTokens: 8192,
    categories: ["indexing"], primaryCategory: "indexing",
    license: "MIT",
    description: "Multi-lingual + multi-granularity embedder. Use if your codebase mixes natural languages.",
    strengths: ["100+ languages", "Long context"],
    qualityRank: 2, popularityRank: 4,
    tags: ["embed", "indexing", "multilingual", "long-context"],
  }),
  entry({
    id: "all-minilm:latest", family: "all-minilm",
    displayName: "All-MiniLM-L6-v2", publisher: "Sentence Transformers",
    params: 0.022, diskGb: 0.05, minRamGb: 0.5, recommendedRamGb: 1,
    contextTokens: 256,
    categories: ["indexing"], primaryCategory: "indexing",
    license: "Apache-2.0",
    description: "The smallest practical embedder. For tiny corpora or unit testing the index path.",
    strengths: ["Microscopic footprint"],
    weaknesses: ["Worse retrieval than nomic / bge"],
    qualityRank: 5, popularityRank: 5,
    tags: ["embed", "indexing", "tiny"],
  }),
];

const VISION: CatalogEntry[] = [
  entry({
    id: "moondream:1.8b", family: "moondream",
    displayName: "Moondream 2 (1.8B)", publisher: "Moondream",
    params: 1.8, diskGb: 1.6, minRamGb: 3, recommendedRamGb: 4,
    contextTokens: 2048,
    categories: ["vision"], primaryCategory: "vision",
    license: "Apache-2.0",
    description: "Pocket-sized vision-language model. Surprisingly capable for the footprint.",
    strengths: ["Runs on 8GB Macs", "OCR-capable"],
    qualityRank: 3, popularityRank: 2,
    tags: ["vision", "small", "ocr"],
  }),
  entry({
    id: "llava:7b", family: "llava",
    displayName: "LLaVA 1.6 7B", publisher: "LLaVA",
    params: 7, contextTokens: 4096,
    categories: ["vision"], primaryCategory: "vision",
    license: "Llama 2 Community",
    description: "Most popular vision baseline. Solid for diagrams and screenshots.",
    strengths: ["Wide community fine-tunes"],
    qualityRank: 4, popularityRank: 1,
    tags: ["vision", "instruct"],
  }),
  entry({
    id: "minicpm-v:8b", family: "minicpm-v",
    displayName: "MiniCPM-V 2.6 (8B)", publisher: "OpenBMB",
    params: 8, contextTokens: 32_768,
    categories: ["vision"], primaryCategory: "vision",
    license: "MiniCPM Model License",
    description: "Strong open VLM with high-resolution image support — best for scanned-PDF OCR.",
    strengths: ["High-res inputs", "Reads dense text in images well"],
    qualityRank: 1, popularityRank: 3,
    tags: ["vision", "ocr", "scanned-pdf", "best"],
  }),
  entry({
    id: "llama3.2-vision:11b", family: "llama3.2-vision",
    displayName: "Llama 3.2 Vision 11B", publisher: "Meta",
    params: 11, contextTokens: 131_072,
    categories: ["vision"], primaryCategory: "vision",
    license: "Llama 3.2 Community",
    description: "Meta's flagship small VLM — long context with strong image grounding.",
    strengths: ["128k context", "Solid instruction following"],
    weaknesses: ["Needs ~16GB free RAM"],
    qualityRank: 2, popularityRank: 4,
    tags: ["vision", "long-context"],
  }),
];

const DOCUMENT_ONLY: CatalogEntry[] = [
  // Most "document" calls are served by chat models above. We keep this
  // block for a couple of long-context standouts so the Document tab
  // isn't empty when the user wants to be explicit.
];

const ALL_FAMILIES: CatalogEntry[][] = [
  QWEN_25_CODER,
  QWEN_25_GENERAL,
  LLAMA_FAMILY,
  DEEPSEEK,
  STARCODER_CODESTRAL,
  MISTRAL_GEMMA_PHI,
  EMBEDDING,
  VISION,
  DOCUMENT_ONLY,
];

/** Flattened catalog. Stable iteration order matches family declaration. */
export const CATALOG: CatalogEntry[] = ALL_FAMILIES.flat();

/** Quick lookup by id — falls back to undefined for unknown tags. */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** Convenience: how many entries the marketplace will show by default. */
export const CATEGORY_COUNTS: Record<AiFeature, number> = (() => {
  const counts = {
    chat: 0,
    agent: 0,
    inlineEdit: 0,
    fim: 0,
    indexing: 0,
    vision: 0,
    document: 0,
  };
  for (const e of CATALOG) {
    for (const c of e.categories) counts[c] += 1;
  }
  return counts;
})();

/* eslint-enable prettier/prettier */
