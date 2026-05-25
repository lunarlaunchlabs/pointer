import { describe, expect, it } from "vitest";
import { CATALOG, getCatalogEntry } from "./modelCatalog";
import {
  classifyRunnability,
  filterAndRank,
  scoreSearch,
  type HardwareLike,
} from "./marketplace";

const GB = 1024 ** 3;

function hw(totalGb: number, availGb?: number, gpu: string | null = null): HardwareLike {
  return {
    total_ram_bytes: totalGb * GB,
    available_ram_bytes: (availGb ?? totalGb * 0.7) * GB,
    gpu_label: gpu,
    os_name: "test",
    arch: "aarch64",
  };
}

const QWEN_7B_CHAT = "qwen2.5-coder:7b-instruct";
const QWEN_32B = "qwen2.5-coder:32b-instruct";
const QWEN_3B_FIM = "qwen2.5-coder:3b-base";
const LLAMA_70B = "llama3.3:70b";
const NOMIC = "nomic-embed-text:latest";
const MINILM = "all-minilm:latest";
const MOONDREAM = "moondream:1.8b";
const MINICPM = "minicpm-v:8b";
const R1_32B = "deepseek-r1:32b";

describe("CATALOG integrity", () => {
  it("has at least one entry per supported AI feature", () => {
    const features = ["chat", "agent", "fim", "indexing", "vision", "document"] as const;
    for (const f of features) {
      const found = CATALOG.filter((e) => e.categories.includes(f));
      expect(found.length, `at least one entry should advertise ${f}`).toBeGreaterThan(0);
    }
  });

  it("never duplicates an Ollama tag", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares every entry's primary category inside its categories list", () => {
    for (const e of CATALOG) {
      expect(e.categories, `${e.id} primary=${e.primaryCategory}`).toContain(
        e.primaryCategory,
      );
    }
  });

  it("populates the required numeric fields with sane values", () => {
    for (const e of CATALOG) {
      expect(e.params, e.id).toBeGreaterThan(0);
      expect(e.diskGb, e.id).toBeGreaterThan(0);
      expect(e.minRamGb, e.id).toBeGreaterThanOrEqual(e.diskGb);
      // recommended >= min so the marketplace banner is non-degenerate.
      expect(e.recommendedRamGb, e.id).toBeGreaterThanOrEqual(e.minRamGb);
      // 256 is the floor we accept for short-context embedders (MiniLM).
      expect(e.contextTokens, e.id).toBeGreaterThanOrEqual(256);
    }
  });

  it("documents a license string for every entry", () => {
    for (const e of CATALOG) {
      expect(e.license.length, e.id).toBeGreaterThan(0);
    }
  });

  it("getCatalogEntry returns the right row by id", () => {
    const e = getCatalogEntry(QWEN_7B_CHAT);
    expect(e?.family).toBe("qwen2.5-coder");
    expect(getCatalogEntry("does-not-exist")).toBeUndefined();
  });
});

describe("classifyRunnability", () => {
  it("returns unknown when no hardware probe is available", () => {
    const e = getCatalogEntry(QWEN_7B_CHAT)!;
    const r = classifyRunnability(e, null);
    expect(r.level).toBe("unknown");
    expect(r.ramAvailableGb).toBeNull();
  });

  it("blocks a 70B model on an 8 GB machine", () => {
    const e = getCatalogEntry(LLAMA_70B)!;
    const r = classifyRunnability(e, hw(8));
    expect(r.level).toBe("blocked");
    expect(r.reason).toMatch(/needs/i);
  });

  it("marks a 7B chat model as good on a 32 GB Apple Silicon machine", () => {
    const e = getCatalogEntry(QWEN_7B_CHAT)!;
    const r = classifyRunnability(e, hw(32, 24, "Apple M2 Pro"));
    expect(r.level).toBe("good");
    expect(r.hasUsefulGpu).toBe(true);
  });

  it("marks a 7B chat model as tight on an 8 GB machine where it just barely fits", () => {
    const e = getCatalogEntry(QWEN_7B_CHAT)!;
    // 7B Q4_K_M is ~5.5 GB needed; 8 GB total with 3 free should be tight.
    const r = classifyRunnability(e, hw(8, 3));
    expect(r.level).toBe("tight");
  });

  it("blocks a 32B model on a 16 GB machine without a GPU", () => {
    const e = getCatalogEntry(QWEN_32B)!;
    const r = classifyRunnability(e, hw(16, 10));
    // 32B Q4_K_M ~20 GB needed; 16 GB total is too small.
    expect(r.level).toBe("blocked");
  });

  it("treats Nomic embed as good even on tiny machines", () => {
    const e = getCatalogEntry(NOMIC)!;
    expect(classifyRunnability(e, hw(8, 6)).level).toBe("good");
    expect(classifyRunnability(e, hw(4, 2)).level).toBe("good");
  });

  it("detects NVIDIA GPUs as useful", () => {
    const e = getCatalogEntry(QWEN_7B_CHAT)!;
    const r = classifyRunnability(e, hw(32, 24, "NVIDIA GeForce RTX 4090"));
    expect(r.hasUsefulGpu).toBe(true);
  });
});

describe("scoreSearch", () => {
  const entry = getCatalogEntry(QWEN_7B_CHAT)!;

  it("returns 0 with no tokens", () => {
    expect(scoreSearch(entry, [])).toBe(0);
  });

  it("scores prefix matches on id higher than substring matches in description", () => {
    const idPrefix = scoreSearch(entry, ["qwen2.5"]);
    const descSub = scoreSearch(entry, ["default"]); // appears in description
    expect(idPrefix).toBeGreaterThan(descSub);
  });

  it("returns -1 when any token misses entirely (AND semantics)", () => {
    expect(scoreSearch(entry, ["qwen", "totally-not-a-thing"])).toBe(-1);
  });

  it("matches by family", () => {
    expect(scoreSearch(entry, ["qwen2.5-coder"])).toBeGreaterThan(0);
  });

  it("matches by tag exactly", () => {
    expect(scoreSearch(entry, ["recommended"])).toBeGreaterThan(0);
  });

  it("respects the 'small' size intent", () => {
    const tiny = getCatalogEntry(QWEN_3B_FIM)!;
    const big = getCatalogEntry(LLAMA_70B)!;
    expect(scoreSearch(tiny, ["small"])).toBeGreaterThan(0);
    expect(scoreSearch(big, ["small"])).toBe(-1);
  });

  it("respects the 'big' size intent", () => {
    const tiny = getCatalogEntry(QWEN_3B_FIM)!;
    const big = getCatalogEntry(LLAMA_70B)!;
    expect(scoreSearch(big, ["big"])).toBeGreaterThan(0);
    expect(scoreSearch(tiny, ["big"])).toBe(-1);
  });

  it("respects 'apache' license intent", () => {
    const apache = getCatalogEntry(QWEN_7B_CHAT)!;
    const restrictive = getCatalogEntry("deepseek-coder:1.3b-base")!;
    expect(scoreSearch(apache, ["apache"])).toBeGreaterThan(0);
    expect(scoreSearch(restrictive, ["apache"])).toBe(-1);
  });

  it("'commercial' rules out non-commercial licenses", () => {
    const apache = getCatalogEntry(QWEN_7B_CHAT)!;
    const noCommercial = getCatalogEntry("deepseek-coder:1.3b-base")!;
    expect(scoreSearch(apache, ["commercial"])).toBeGreaterThan(0);
    expect(scoreSearch(noCommercial, ["commercial"])).toBe(-1);
  });
});

describe("filterAndRank", () => {
  it("returns every entry when no filters and no hardware", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "",
        category: null,
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows.length).toBe(CATALOG.length);
  });

  it("category=fim filter only returns FIM-capable entries", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "",
        category: "fim",
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.entry.categories).toContain("fim");
    }
  });

  it("hideBlocked drops models that won't run on a tiny machine", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: hw(8, 4),
      installedModelIds: [],
      filters: {
        query: "",
        category: null,
        hideBlocked: true,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows.find((r) => r.entry.id === LLAMA_70B)).toBeUndefined();
    expect(rows.find((r) => r.entry.id === NOMIC)).toBeDefined();
  });

  it("hideInstalled drops models the user already has", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [QWEN_7B_CHAT, NOMIC],
      filters: {
        query: "",
        category: null,
        hideBlocked: false,
        hideInstalled: true,
        sort: "best",
      },
    });
    expect(rows.find((r) => r.entry.id === QWEN_7B_CHAT)).toBeUndefined();
    expect(rows.find((r) => r.entry.id === NOMIC)).toBeUndefined();
  });

  it("sort=smallest puts the smallest model first", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "",
        category: "chat",
        hideBlocked: false,
        hideInstalled: false,
        sort: "smallest",
      },
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].entry.params).toBeGreaterThanOrEqual(rows[i - 1].entry.params);
    }
  });

  it("sort=largest puts the largest model first", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "",
        category: "chat",
        hideBlocked: false,
        hideInstalled: false,
        sort: "largest",
      },
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].entry.params).toBeLessThanOrEqual(rows[i - 1].entry.params);
    }
  });

  it("blocked models sink to the bottom when not filtered out", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: hw(8, 4),
      installedModelIds: [],
      filters: {
        query: "",
        category: "chat",
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    const last = rows[rows.length - 1];
    // The bottom row should be a "blocked" one on an 8GB box.
    expect(["blocked", "tight"]).toContain(last.runnability.level);
  });

  it("search 'qwen 7b' finds the Qwen 7B chat row first", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "qwen 7b",
        category: null,
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows[0].entry.id).toMatch(/qwen2\.5-coder:7b/);
  });

  it("search 'vision ocr' surfaces the OCR-strong vision model first", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "vision ocr",
        category: null,
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect([MINICPM, MOONDREAM]).toContain(rows[0].entry.id);
  });

  it("search 'embed small' returns embedding models only", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "embed small",
        category: null,
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.entry.categories).toContain("indexing");
    }
    // MiniLM is the smallest embedder so it should rank first.
    expect(rows[0].entry.id).toBe(MINILM);
  });

  it("search 'thinking' returns reasoning models", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "thinking",
        category: null,
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.entry.id === R1_32B)).toBeDefined();
  });

  it("an unmatched query returns no rows (AND semantics)", () => {
    const rows = filterAndRank({
      catalog: CATALOG,
      hardware: null,
      installedModelIds: [],
      filters: {
        query: "qwen totallyfakeword",
        category: null,
        hideBlocked: false,
        hideInstalled: false,
        sort: "best",
      },
    });
    expect(rows.length).toBe(0);
  });
});
