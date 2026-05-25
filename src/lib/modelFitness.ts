/**
 * Model fitness scoring.
 *
 * Local model names follow a few stable conventions (Ollama tags, HF
 * naming) that tell us a lot about what a model is *for*: `-base` vs
 * `-instruct`, `embed` in the name, the presence of `coder`, `llava`,
 * etc. The same model can technically be loaded for any purpose, but most
 * mismatches produce wasted requests and surprising output — e.g. a
 * `*-coder-*-base` model assigned to the chat slot streams pure text
 * continuation, never a coherent answer.
 *
 * This module captures those heuristics in one place and grades each
 * (model, purpose) pair as:
 *
 *   "good"  — confident match, no UI prompt
 *   "ok"    — plausible but not ideal (e.g. tiny chat model)
 *   "warn"  — likely the wrong tool for the job
 *
 * Every "warn" carries a human-readable `reason` the UI can surface as a
 * tooltip / chip. We deliberately avoid "blocking" — the user can still
 * assign whatever they want; we just keep them informed.
 *
 * The lists below are curated by hand from the most-pulled families on
 * Ollama / Hugging Face (Q2 2026). They're matched as case-insensitive
 * substrings against the model name so a tag like `qwen2.5-coder:7b` and
 * `qwen2.5-coder:14b-instruct-q4_K_M` both resolve correctly.
 */

import type { AiFeature } from "@/store/settings";

export type Fitness = {
  level: "good" | "ok" | "warn";
  reason: string;
};

/**
 * Substring patterns common to embedding-only models. These don't have a
 * generative head and produce gibberish if used as a chat model.
 */
const EMBEDDING_FAMILIES = [
  "nomic-embed",
  "mxbai-embed",
  "all-minilm",
  "bge-small",
  "bge-base",
  "bge-large",
  "bge-m3",
  "snowflake-arctic-embed",
  "gte-",
  "e5-",
  "embeddinggemma",
  "jina-embeddings",
  "paraphrase-multilingual",
];

/**
 * Patterns indicating a multimodal vision-language model. These understand
 * images alongside text and are the right pick for the Vision slot.
 */
const VISION_FAMILIES = [
  "llava",
  "moondream",
  "qwen2-vl",
  "qwen2.5-vl",
  "pixtral",
  "minicpm-v",
  "bakllava",
  "internvl",
  "molmo",
  "florence-2",
  "phi-3-vision",
  "phi-3.5-vision",
];

/**
 * Patterns we know correspond to FIM-trained base models — i.e. trained
 * with fill-in-the-middle prefix/suffix tokens and *not* an instruction
 * head. These shine for tab completion but produce poor chat output.
 */
const FIM_BASE_FAMILIES = [
  "starcoder",
  "starcoder2",
  "deepseek-coder",
  "codestral",
  "codellama",
  "codegemma",
  "stable-code",
];

/**
 * Patterns we know correspond to "thinking" / chain-of-thought models that
 * generate <think>...</think> blocks before answers. They're slower for
 * tab completion (the thinking burns latency on every keystroke) and
 * generally a poor fit for FIM.
 */
const THINKING_FAMILIES = [
  "deepseek-r1",
  "qwen3", // qwen3 thinking by default
  "openthinker",
  "marco-o1",
  "qwq",
];

/** Coding-specialised instruct models — strong defaults for chat/agent. */
const CODER_INSTRUCT_FAMILIES = [
  "qwen2.5-coder",
  "qwen3-coder",
  "deepseek-coder-v2",
  "codeqwen",
  "codestral",
  "granite-code",
  "codellama-instruct",
];

/** General-purpose instruct families that aren't coder-specialised. */
const GENERAL_INSTRUCT_FAMILIES = [
  "llama3",
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "llama4",
  "mistral",
  "mistral-nemo",
  "mistral-small",
  "mixtral",
  "gemma",
  "gemma2",
  "gemma3",
  "phi3",
  "phi-3",
  "phi4",
  "phi-4",
  "neural-chat",
  "openhermes",
  "vicuna",
];

const lower = (s: string) => s.toLowerCase();
const includesAny = (s: string, list: string[]) =>
  list.some((p) => lower(s).includes(p));

/**
 * Parse the parameter count from an Ollama tag (e.g. "qwen2.5:7b-q4" -> 7).
 * Returns `null` when we can't tell — many tags omit it.
 */
function paramSizeBillion(model: string): number | null {
  const m = lower(model).match(/(?:^|[:_\-/])(\d+(?:\.\d+)?)\s*b\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isBaseTag(model: string): boolean {
  const t = lower(model);
  // Ollama variants: "...:7b-base", "...:1.5b-base-q4_K_M"
  return /\bbase\b/.test(t);
}

function isInstructTag(model: string): boolean {
  const t = lower(model);
  return /\binstruct\b/.test(t) || /\bchat\b/.test(t) || /\bit\b/.test(t);
}

/**
 * Grade one (model, feature) pair. Defaults to "good" when we have no
 * opinion — we'd rather under-warn than nag the user with low-confidence
 * suggestions.
 */
export function modelFitness(model: string, feature: AiFeature): Fitness {
  if (!model) return { level: "warn", reason: "No model selected." };

  const isEmbed = includesAny(model, EMBEDDING_FAMILIES);
  const isVision = includesAny(model, VISION_FAMILIES);
  const isCoderInstruct = includesAny(model, CODER_INSTRUCT_FAMILIES);
  const isGeneralInstruct = includesAny(model, GENERAL_INSTRUCT_FAMILIES);
  const isFimBase = includesAny(model, FIM_BASE_FAMILIES) && isBaseTag(model);
  const isThinking = includesAny(model, THINKING_FAMILIES);
  const params = paramSizeBillion(model);

  switch (feature) {
    case "chat":
    case "agent": {
      if (isEmbed) {
        return {
          level: "warn",
          reason:
            "Embedding model — no generative head, will produce garbage in chat.",
        };
      }
      if (isVision) {
        return {
          level: "ok",
          reason:
            "Vision-language model. Works for text chat, but tends to be slower than a dedicated text model.",
        };
      }
      if (isFimBase) {
        return {
          level: "warn",
          reason:
            "Base / FIM-tuned model — picks up your prompt and continues it instead of answering.",
        };
      }
      if (isBaseTag(model) && !isInstructTag(model) && !isCoderInstruct) {
        return {
          level: "warn",
          reason:
            "Looks like a base (non-instruct) model. Pick an `-instruct` tag for chat.",
        };
      }
      if (params != null && params < 1.5 && feature === "chat") {
        return {
          level: "ok",
          reason: `Small model (${params}B). Useful for low-latency replies, but reasoning may be limited.`,
        };
      }
      if (params != null && params < 3 && feature === "agent") {
        return {
          level: "warn",
          reason: `Agent loops need tool-call reliability; ${params}B models often miss the JSON schema.`,
        };
      }
      if (!isCoderInstruct && !isGeneralInstruct && !isThinking) {
        // Unknown family — don't editorialise.
        return { level: "good", reason: "" };
      }
      return { level: "good", reason: "" };
    }

    case "inlineEdit": {
      // Inline edit shares the chat model and lives or dies by clean
      // single-shot rewrites. Coder-instruct is ideal; thinking models
      // burn time on long preambles.
      if (isEmbed)
        return { level: "warn", reason: "Embedding model — can't generate code." };
      if (isFimBase)
        return {
          level: "warn",
          reason:
            "FIM base model — better at completion than rewriting selections.",
        };
      if (isThinking)
        return {
          level: "ok",
          reason:
            "Thinking model: inline edits will be slower (it 'thinks' before each rewrite).",
        };
      return { level: "good", reason: "" };
    }

    case "fim": {
      if (isEmbed)
        return { level: "warn", reason: "Embedding model — can't do code completion." };
      if (isVision)
        return {
          level: "warn",
          reason: "Vision model — wasted on text-only completions.",
        };
      if (isThinking)
        return {
          level: "warn",
          reason:
            "Thinking model produces <think> blocks mid-completion. Pick a `-base` coder model.",
        };
      // Size dominates FIM quality: even a perfectly-tuned 14B coder-base
      // adds 100s of ms per keystroke. We check size *before* declaring a
      // coder-base "good" so the warning surfaces on big models.
      if (params != null && params > 7) {
        return {
          level: "warn",
          reason: `${params}B is too big for tab completion — latency will be painful. Try a 1–3B coder base model.`,
        };
      }
      // Coder-base models are the gold standard for FIM at the right size.
      if (isCoderInstruct && isBaseTag(model)) {
        return { level: "good", reason: "" };
      }
      if (isCoderInstruct && !isBaseTag(model)) {
        return {
          level: "ok",
          reason:
            "Instruct variant works, but the matching `-base` tag is usually faster and cleaner for FIM.",
        };
      }
      if (!isFimBase && !isCoderInstruct) {
        return {
          level: "warn",
          reason: "Not a known coder-base family. FIM quality will be hit or miss.",
        };
      }
      return { level: "good", reason: "" };
    }

    case "indexing": {
      if (!isEmbed) {
        return {
          level: "warn",
          reason:
            "Not an embedding model. Use `nomic-embed-text`, `mxbai-embed-large`, or `bge-*`.",
        };
      }
      return { level: "good", reason: "" };
    }

    case "vision": {
      if (!isVision) {
        return {
          level: "warn",
          reason:
            "Not a vision-language model. Use llava, moondream, qwen2.5-vl, pixtral, or minicpm-v.",
        };
      }
      return { level: "good", reason: "" };
    }

    case "document": {
      if (isEmbed)
        return { level: "warn", reason: "Embedding model — can't summarise text." };
      if (isFimBase)
        return {
          level: "warn",
          reason: "Base coder model — pick an instruct model for document summaries.",
        };
      if (params != null && params < 1) {
        return {
          level: "ok",
          reason: `Very small (${params}B). Summaries may miss nuance on long documents.`,
        };
      }
      return { level: "good", reason: "" };
    }
  }
}

/**
 * Convenience for UI: return a one-line label suitable for chips ("FIM-ok",
 * "Likely wrong", etc.). Stays in this module so every callsite has the
 * exact same phrasing.
 */
export function fitnessChip(fit: Fitness): { label: string; tone: "warn" | "ok" | "good" } {
  if (fit.level === "warn") return { label: "Mismatch", tone: "warn" };
  if (fit.level === "ok") return { label: "Workable", tone: "ok" };
  return { label: "Good fit", tone: "good" };
}
