import { describe, expect, it } from "vitest";
import { modelFitness } from "./modelFitness";

describe("modelFitness", () => {
  describe("chat / agent", () => {
    it("flags pure embedding models as mismatches", () => {
      const fit = modelFitness("nomic-embed-text:latest", "chat");
      expect(fit.level).toBe("warn");
      expect(fit.reason).toMatch(/embedding/i);
    });

    it("accepts coder-instruct families as a good fit", () => {
      expect(modelFitness("qwen2.5-coder:14b-instruct", "chat").level).toBe(
        "good",
      );
    });

    it("warns when the user picks a base / FIM model for chat", () => {
      const fit = modelFitness("starcoder2:7b-base", "chat");
      expect(fit.level).toBe("warn");
      expect(fit.reason).toMatch(/base|fim/i);
    });

    it("warns about tiny models in the agent slot (tool-call reliability)", () => {
      const fit = modelFitness("qwen2.5-coder:1b-instruct", "agent");
      expect(fit.level).toBe("warn");
      expect(fit.reason).toMatch(/tool/i);
    });
  });

  describe("fim", () => {
    it("rejects embedding models", () => {
      expect(modelFitness("mxbai-embed-large", "fim").level).toBe("warn");
    });

    it("rejects thinking models for tab completion latency", () => {
      const fit = modelFitness("deepseek-r1:7b", "fim");
      expect(fit.level).toBe("warn");
      expect(fit.reason).toMatch(/think/i);
    });

    it("considers a 14B model too large for keystroke-rate FIM", () => {
      expect(modelFitness("qwen2.5-coder:14b-base", "fim").level).not.toBe(
        "good",
      );
    });

    it("considers a 3B coder-base model a good fit", () => {
      expect(modelFitness("qwen2.5-coder:3b-base", "fim").level).toBe("good");
    });
  });

  describe("indexing", () => {
    it("requires an embedding-family model", () => {
      expect(modelFitness("llama3.1:8b", "indexing").level).toBe("warn");
      expect(modelFitness("nomic-embed-text:latest", "indexing").level).toBe(
        "good",
      );
    });
  });

  describe("vision", () => {
    it("warns when a text-only model is assigned to vision", () => {
      expect(modelFitness("qwen2.5-coder:7b-instruct", "vision").level).toBe(
        "warn",
      );
    });

    it("accepts known vision-language families", () => {
      for (const m of [
        "llava:7b",
        "moondream:1.8b",
        "qwen2.5-vl:7b",
        "minicpm-v:8b",
      ]) {
        expect(modelFitness(m, "vision").level).toBe("good");
      }
    });
  });

  it("returns 'warn' on empty model name regardless of feature", () => {
    expect(modelFitness("", "chat").level).toBe("warn");
    expect(modelFitness("", "fim").level).toBe("warn");
    expect(modelFitness("", "indexing").level).toBe("warn");
  });
});
