/**
 * Tests for the AI feature capability gates.
 *
 * These helpers decide *whether* a feature can actually fire at any given
 * moment — they're the single source of truth used by the FIM provider,
 * chat composer, agent panel, status bar, and dock rail. If they regress,
 * the UI silently spins on dead requests, so they get heavy test coverage.
 *
 * We construct a partial-settings object per test rather than mutating
 * the live Zustand store. The capability helpers accept any object shape,
 * so passing a typed minimal stub avoids leaking state between tests.
 */

import { describe, expect, it } from "vitest";
import {
  featureCapability,
  featureBlockReason,
  isFeatureUsable,
  isModelInstalled,
  effectiveAssignedModel,
  type AiFeature,
} from "./settings";

type Stub = NonNullable<Parameters<typeof featureCapability>[1]>;

/** Build a settings stub with sane defaults; override per-test. */
function stub(overrides: Partial<Stub> = {}): Stub {
  return {
    ollamaReady: true,
    installedModels: ["qwen2.5-coder:7b-instruct", "nomic-embed-text:latest"],
    chatModel: "qwen2.5-coder:7b-instruct",
    agentModel: "qwen2.5-coder:7b-instruct",
    fimModel: "qwen2.5-coder:3b-base",
    embedModel: "nomic-embed-text:latest",
    visionModel: "",
    documentModel: "",
    chatEnabled: true,
    agentEnabled: true,
    inlineEditEnabled: true,
    fimEnabled: true,
    indexingEnabled: true,
    ...overrides,
  } as Stub;
}

describe("featureCapability", () => {
  it("returns 'on' for fully-configured chat", () => {
    expect(featureCapability("chat", stub())).toBe("on");
    expect(isFeatureUsable("chat", stub())).toBe(true);
  });

  it("reports 'off' when the user disabled the toggle", () => {
    const s = stub({ chatEnabled: false });
    expect(featureCapability("chat", s)).toBe("off");
    expect(isFeatureUsable("chat", s)).toBe(false);
    expect(featureBlockReason("chat", s)).toMatch(/control panel/i);
  });

  it("reports 'no_runtime' when Ollama is offline", () => {
    const s = stub({ ollamaReady: false });
    expect(featureCapability("chat", s)).toBe("no_runtime");
    expect(featureBlockReason("chat", s)).toMatch(/ollama.+running/i);
  });

  it("reports 'no_models' before any model is pulled", () => {
    const s = stub({ installedModels: [] });
    expect(featureCapability("chat", s)).toBe("no_models");
  });

  it("reports 'needs_model' when the slot is empty", () => {
    const s = stub({ chatModel: "" });
    expect(featureCapability("chat", s)).toBe("needs_model");
  });

  it("reports 'model_missing' when the configured model isn't installed", () => {
    const s = stub({ chatModel: "qwen3:30b" });
    expect(featureCapability("chat", s)).toBe("model_missing");
    expect(featureBlockReason("chat", s)).toMatch(/qwen3:30b/);
  });

  // Vision / document have no toggle — they're enabled implicitly when
  // their model slot has a value. That's a different code path from chat
  // and worth a dedicated test.
  it("vision capability ignores the chatEnabled toggle", () => {
    const baseInstalled = stub().installedModels;
    const s = stub({
      visionModel: "llava:7b",
      installedModels: [...baseInstalled, "llava:7b"],
      chatEnabled: false,
    });
    expect(featureCapability("vision", s)).toBe("on");
  });

  it("vision capability still requires the model to be installed", () => {
    const s = stub({ visionModel: "llava:7b" });
    expect(featureCapability("vision", s)).toBe("model_missing");
  });

  // The "inlineEdit" feature shares chatModel with chat — make sure the
  // mapping is wired correctly so toggling inlineEditEnabled doesn't
  // accidentally affect chat or vice versa.
  it("inlineEdit gates on inlineEditEnabled, not chatEnabled", () => {
    const s = stub({ inlineEditEnabled: false });
    expect(featureCapability("inlineEdit", s)).toBe("off");
    expect(featureCapability("chat", s)).toBe("on");
  });
});

describe("featureBlockReason", () => {
  it("returns the empty string when the feature is usable", () => {
    expect(featureBlockReason("chat", stub())).toBe("");
  });

  it("covers every capability state", () => {
    const cases: Record<
      Exclude<
        ReturnType<typeof featureCapability>,
        "on"
      >,
      Partial<Stub>
    > = {
      off: { chatEnabled: false },
      no_runtime: { ollamaReady: false },
      no_models: { installedModels: [] },
      needs_model: { chatModel: "" },
      model_missing: { chatModel: "no-such-model:latest" },
    };
    for (const [_state, overrides] of Object.entries(cases)) {
      const reason = featureBlockReason("chat", stub(overrides));
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Display-side helpers — these decide what the title bar / status bar /
// welcome screen actually paint. Diverging from the truth here is the
// "lying about state" bug the user repeatedly flagged, so the gates are
// covered against every shape of stale data we've actually seen in the
// wild.
// ──────────────────────────────────────────────────────────────────────────

describe("isModelInstalled", () => {
  it("returns false for an empty name", () => {
    expect(isModelInstalled("", stub())).toBe(false);
  });

  it("returns true when the model is in the installed list", () => {
    expect(
      isModelInstalled("qwen2.5-coder:7b-instruct", stub()),
    ).toBe(true);
  });

  it("returns false when Ollama is offline (we can't verify)", () => {
    // Even if the install list happens to still contain the name, we
    // can't know if the daemon would actually serve it — treating this
    // as "unknown" prevents misleading the user about live state.
    const s = stub({ ollamaReady: false });
    expect(isModelInstalled("qwen2.5-coder:7b-instruct", s)).toBe(false);
  });

  it("returns false for a slot that points at a deleted model", () => {
    const s = stub({ installedModels: ["nomic-embed-text:latest"] });
    expect(isModelInstalled("qwen2.5-coder:7b-instruct", s)).toBe(false);
  });
});

describe("effectiveAssignedModel", () => {
  it("returns the configured slot when the model is installed", () => {
    expect(effectiveAssignedModel("chat", stub())).toBe(
      "qwen2.5-coder:7b-instruct",
    );
  });

  it("returns an empty string when the slot is unset", () => {
    const s = stub({ chatModel: "" });
    expect(effectiveAssignedModel("chat", s)).toBe("");
  });

  it("returns an empty string when the slot points at a missing model", () => {
    // This is the canonical "user deleted the model after picking it"
    // case. The summary chips should *not* keep advertising it.
    const s = stub({ chatModel: "deleted-model:1b" });
    expect(effectiveAssignedModel("chat", s)).toBe("");
  });

  it("returns an empty string when Ollama is offline", () => {
    const s = stub({ ollamaReady: false });
    expect(effectiveAssignedModel("chat", s)).toBe("");
  });

  it("maps every feature through to its persisted slot", () => {
    // The mapping itself is centralised but we still want a regression
    // guard so adding a new AiFeature without a slot doesn't silently
    // return the wrong model.
    const base = stub({
      chatModel: "chat:1b",
      agentModel: "agent:1b",
      fimModel: "fim:1b",
      embedModel: "embed:1b",
      visionModel: "vision:1b",
      documentModel: "doc:1b",
      installedModels: [
        "chat:1b",
        "agent:1b",
        "fim:1b",
        "embed:1b",
        "vision:1b",
        "doc:1b",
      ],
    });
    expect(effectiveAssignedModel("chat", base)).toBe("chat:1b");
    expect(effectiveAssignedModel("agent", base)).toBe("agent:1b");
    expect(effectiveAssignedModel("inlineEdit", base)).toBe("chat:1b");
    expect(effectiveAssignedModel("fim", base)).toBe("fim:1b");
    expect(effectiveAssignedModel("indexing", base)).toBe("embed:1b");
    expect(effectiveAssignedModel("vision", base)).toBe("vision:1b");
    expect(effectiveAssignedModel("document", base)).toBe("doc:1b");
  });
});

describe("AiFeature mapping", () => {
  it("every feature evaluates without throwing across all states", () => {
    const features: AiFeature[] = [
      "chat",
      "agent",
      "inlineEdit",
      "fim",
      "indexing",
      "vision",
      "document",
    ];
    const states: Partial<Stub>[] = [
      {},
      { ollamaReady: false },
      { installedModels: [] },
      { chatModel: "", agentModel: "", fimModel: "", embedModel: "" },
    ];
    for (const f of features) {
      for (const s of states) {
        const cap = featureCapability(f, stub(s));
        expect(cap).toMatch(/^(on|off|no_runtime|no_models|needs_model|model_missing)$/);
      }
    }
  });
});
