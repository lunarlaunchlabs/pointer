import { beforeEach, describe, expect, it } from "vitest";
import { normalizeRuntimeLanguage, useLspRuntime } from "./lspRuntime";

describe("lsp runtime lifecycle store", () => {
  beforeEach(() => {
    useLspRuntime.getState().clear();
  });

  it("normalizes common editor language IDs to backend server keys", () => {
    expect(normalizeRuntimeLanguage("typescriptreact")).toBe("typescript");
    expect(normalizeRuntimeLanguage("tsx")).toBe("typescript");
    expect(normalizeRuntimeLanguage("javascriptreact")).toBe("javascript");
    expect(normalizeRuntimeLanguage("scss")).toBe("css");
    expect(normalizeRuntimeLanguage("yml")).toBe("yaml");
    expect(normalizeRuntimeLanguage("rs")).toBe("rust");
  });

  it("announces restart only for servers Pointer paused for idleness", () => {
    useLspRuntime.getState().markIdleStopped([
      { language: "typescript", label: "typescript-language-server" },
    ]);

    const restart = useLspRuntime
      .getState()
      .beginRestartIfIdleStopped("typescriptreact");

    expect(restart).toEqual({
      language: "typescript",
      label: "typescript-language-server",
    });
    expect(
      useLspRuntime.getState().beginRestartIfIdleStopped("typescript"),
    ).toBeNull();

    useLspRuntime.getState().finishRestart("typescript");
    expect(useLspRuntime.getState().starting).toEqual({});
  });
});
