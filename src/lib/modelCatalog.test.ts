import { describe, expect, it } from "vitest";
import {
  CATALOG,
  getCatalogEntry,
  mergeWithCuratedCatalog,
  type CatalogEntry,
} from "./modelCatalog";

function upstream(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "nomic-embed-text:latest",
    family: "nomic-embed-text",
    displayName: "Nomic Embed Text",
    publisher: "Ollama",
    params: 7,
    diskGb: 4.2,
    minRamGb: 6,
    recommendedRamGb: 9.5,
    contextTokens: 8192,
    quantization: "Q4_K_M",
    categories: ["chat"],
    primaryCategory: "chat",
    license: "Ollama library",
    description: "Live row",
    strengths: ["Live metadata"],
    weaknesses: [],
    qualityRank: 50,
    popularityRank: 2,
    source: "ollama",
    tags: ["ollama", "upstream"],
    pulls: "71.6M",
    updated: "2 years ago",
    inputTypes: ["Text"],
    upstream: true,
    ...overrides,
  };
}

describe("mergeWithCuratedCatalog", () => {
  it("keeps live freshness while preserving curated runnability metadata", () => {
    const curated = getCatalogEntry("nomic-embed-text:latest")!;
    const merged = mergeWithCuratedCatalog([upstream()]);
    const entry = merged.find((e) => e.id === "nomic-embed-text:latest")!;

    expect(entry.upstream).toBe(true);
    expect(entry.pulls).toBe("71.6M");
    expect(entry.updated).toBe("2 years ago");
    expect(entry.primaryCategory).toBe(curated.primaryCategory);
    expect(entry.license).toBe(curated.license);
    expect(entry.params).toBe(curated.params);
    expect(entry.diskGb).toBe(curated.diskGb);
    expect(entry.minRamGb).toBe(curated.minRamGb);
    expect(entry.recommendedRamGb).toBe(curated.recommendedRamGb);
    expect(entry.categories).toEqual(expect.arrayContaining(["chat", "indexing"]));
    expect(entry.tags).toEqual(expect.arrayContaining(["ollama", "upstream", "embed"]));
  });

  it("adds curated rows that upstream cannot express as exact tags", () => {
    const merged = mergeWithCuratedCatalog([upstream({ id: "qwen2.5-coder:7b" })]);

    expect(merged.some((e) => e.id === "qwen2.5-coder:1.5b-base")).toBe(true);
    expect(merged.length).toBeGreaterThan(CATALOG.length);
  });
});
