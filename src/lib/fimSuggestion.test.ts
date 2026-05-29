import { describe, expect, it } from "vitest";
import { normalizeFimSuggestion } from "./fimSuggestion";

describe("normalizeFimSuggestion", () => {
  it("strips FIM control tokens from model output", () => {
    expect(
      normalizeFimSuggestion({
        raw: "<|fim_middle|>Greeting('Pointer')<|endoftext|>",
        prefix: "return render",
        suffix: "\n}",
      }),
    ).toBe("Greeting('Pointer')");
  });

  it("strips non-Qwen FIM control tokens from model output", () => {
    expect(
      normalizeFimSuggestion({
        raw: "<｜fim▁hole｜>Greeting('Pointer')<｜fim▁end｜>",
        prefix: "return render",
        suffix: "\n}",
      }),
    ).toBe("Greeting('Pointer')");
    expect(
      normalizeFimSuggestion({
        raw: "<fim_middle>Greeting('Pointer')<|endoftext|>",
        prefix: "return render",
        suffix: "\n}",
      }),
    ).toBe("Greeting('Pointer')");
  });

  it("unwraps fenced code completions", () => {
    expect(
      normalizeFimSuggestion({
        raw: "```tsx\nGreeting('Pointer')\n```",
        prefix: "return render",
        suffix: "\n}",
      }),
    ).toBe("Greeting('Pointer')");
  });

  it("removes repeated prefix text from completion models", () => {
    expect(
      normalizeFimSuggestion({
        raw: "renderGreeting('Pointer')",
        prefix: "  return render",
        suffix: "\n}",
      }),
    ).toBe("Greeting('Pointer')");
  });

  it("removes suffix text echoed by FIM models", () => {
    expect(
      normalizeFimSuggestion({
        raw: "Greeting('Pointer')\n}",
        prefix: "  return render",
        suffix: "\n}",
      }),
    ).toBe("Greeting('Pointer')");
  });

  it("preserves meaningful leading newlines", () => {
    expect(
      normalizeFimSuggestion({
        raw: "\n  // completed by FIM",
        prefix: "renderGreeting('Pointer');",
        suffix: "\n}",
      }),
    ).toBe("\n  // completed by FIM");
  });

  it("drops prose that cannot be inserted as code", () => {
    expect(
      normalizeFimSuggestion({
        raw: "Here is the completion: renderGreeting('Pointer')",
        prefix: "return render",
        suffix: "\n}",
      }),
    ).toBe("");
  });
});
