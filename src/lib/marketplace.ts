/**
 * Marketplace logic: hardware runnability, intelligent search, and sort.
 *
 * Pure functions only — no React, no IPC, no globals. Everything in this
 * module is unit-testable without a browser environment, which is the
 * point: search ranking and "can I run this?" classification are the two
 * pieces most likely to drift away from the user's expectations, and the
 * only way to keep them honest is exhaustive tests.
 */

import type { AiFeature } from "@/store/settings";
import type { CatalogEntry } from "@/lib/modelCatalog";

// ---------------------------------------------------------------------------
// Runnability
// ---------------------------------------------------------------------------

/**
 * The four buckets the marketplace uses to flag every model against a
 * given hardware profile.
 *
 *  - "good"    : The recommended RAM target is met. Install away.
 *  - "tight"   : Above the hard minimum but below recommended; will load
 *                but other apps may swap.
 *  - "blocked" : Won't fit in physical RAM, even with swap, with any
 *                reasonable safety margin. We refuse to install by
 *                default (user can override).
 *  - "unknown" : We haven't probed the hardware yet (no `hardware`
 *                passed). Treat as "we don't know — show but don't
 *                celebrate".
 */
export type Runnability = "good" | "tight" | "blocked" | "unknown";

export type HardwareLike = {
  /** Total physical RAM in bytes. */
  total_ram_bytes: number;
  /** Available (free + reclaimable) RAM in bytes. */
  available_ram_bytes: number;
  /** Optional GPU label string ("Apple M2 Pro", "NVIDIA RTX 4090", ...). */
  gpu_label?: string | null;
  /** OS name for diagnostics (not part of the math). */
  os_name?: string | null;
  /** "aarch64" | "x86_64" — affects which quantizations are most efficient. */
  arch?: string;
};

/** Result envelope used by the UI. */
export type RunnabilityReport = {
  level: Runnability;
  /** Short human reason, e.g. "Needs ~12.5 GB but you have 8 GB." */
  reason: string;
  /** Approx RAM required to load this model. */
  ramNeededGb: number;
  /** Total physical RAM the user has, or null when unknown. */
  ramAvailableGb: number | null;
  /** Whether the user has a discrete / Apple-Silicon-class GPU we'd benefit from. */
  hasUsefulGpu: boolean;
};

const GB = 1024 ** 3;

/**
 * Decide whether a catalog entry will run on the given hardware.
 *
 * Heuristics:
 *  - If we don't know hardware → "unknown".
 *  - `total < min`  → "blocked" (can't even hold the weights).
 *  - `available < min` AND `total >= min` → "tight" (will swap on load).
 *  - `available < recommended` → "tight" (works but everything else will
 *    be slower).
 *  - Else → "good".
 *
 * GPU acceleration loosens the "tight" threshold slightly when we detect
 * a useful accelerator, because most of the model lives in VRAM and the
 * CPU memory pressure is much lower. We don't try to read VRAM size
 * directly (cross-platform pain), so this is an approximation.
 */
export function classifyRunnability(
  entry: CatalogEntry,
  hardware: HardwareLike | null,
): RunnabilityReport {
  const ramNeededGb = entry.minRamGb;
  if (!hardware) {
    return {
      level: "unknown",
      reason: "Hardware not detected yet.",
      ramNeededGb,
      ramAvailableGb: null,
      hasUsefulGpu: false,
    };
  }

  const totalGb = hardware.total_ram_bytes / GB;
  const availableGb = hardware.available_ram_bytes / GB;
  const hasUsefulGpu = detectUsefulGpu(hardware.gpu_label);

  // Hard floor: we won't promise something that can't even be loaded.
  // We give a 0.9× discount on the requirement if a useful GPU is
  // present — that's roughly the savings from keeping the KV cache on
  // device. This is intentionally conservative; we'd rather warn than
  // crash someone's machine.
  const effectiveMin = hasUsefulGpu ? ramNeededGb * 0.9 : ramNeededGb;
  const effectiveRec = hasUsefulGpu
    ? entry.recommendedRamGb * 0.9
    : entry.recommendedRamGb;

  if (totalGb + 0.01 < effectiveMin) {
    return {
      level: "blocked",
      reason: `Needs ~${round1(ramNeededGb)} GB RAM but you have ${round1(totalGb)} GB.`,
      ramNeededGb,
      ramAvailableGb: totalGb,
      hasUsefulGpu,
    };
  }
  if (availableGb < effectiveMin) {
    return {
      level: "tight",
      reason: `Will swap on load — only ${round1(availableGb)} GB free of ${round1(totalGb)} GB.`,
      ramNeededGb,
      ramAvailableGb: totalGb,
      hasUsefulGpu,
    };
  }
  if (availableGb < effectiveRec) {
    return {
      level: "tight",
      reason: `Fits, but other apps may slow down (recommended ${round1(entry.recommendedRamGb)} GB free).`,
      ramNeededGb,
      ramAvailableGb: totalGb,
      hasUsefulGpu,
    };
  }
  return {
    level: "good",
    reason: `Comfortable — ${round1(availableGb)} GB free, needs ~${round1(ramNeededGb)} GB.`,
    ramNeededGb,
    ramAvailableGb: totalGb,
    hasUsefulGpu,
  };
}

function detectUsefulGpu(label: string | null | undefined): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  // Apple Silicon: unified memory makes anything M-series "useful"
  // because the GPU can access the same RAM the model lives in.
  if (l.includes("apple") || /m\d/.test(l)) return true;
  // NVIDIA: anything dedicated counts. We can't tell VRAM size from the
  // label string alone, so we'll trust the user not to install a 70B on
  // a GTX 1050.
  if (l.includes("nvidia") || l.includes("geforce") || l.includes("rtx") || l.includes("gtx")) {
    return true;
  }
  // AMD discrete: also useful via ROCm on Linux.
  if (l.includes("radeon") || l.includes("amd")) return true;
  // Intel iGPU / Arc — too uneven to count on.
  return false;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Search & ranking
// ---------------------------------------------------------------------------

export type MarketplaceFilters = {
  /** Free-text query. Empty string = no filter. */
  query: string;
  /** Restrict to entries usable for this AiFeature. `null` = no restriction. */
  category: AiFeature | null;
  /** Restrict to one Ollama model family. `null` / omitted = no restriction. */
  family?: string | null;
  /** Hide entries that wouldn't run on the user's hardware. */
  hideBlocked: boolean;
  /** Hide entries already in `installedModelIds`. */
  hideInstalled: boolean;
  /**
   * Ranking. Default ("best") sorts by quality (lower number = better)
   * within whatever the user's category filter is, with runnability as a
   * tiebreaker; "smallest"/"largest" sort by params; "popular" by
   * popularity rank.
   */
  sort: "best" | "smallest" | "largest" | "popular";
};

export type MarketplaceRow = {
  entry: CatalogEntry;
  /** Hardware runnability for this row (precomputed so the UI can reuse). */
  runnability: RunnabilityReport;
  /** Is this id already installed (matches `installedModels`)? */
  installed: boolean;
  /** Internal score used for sorting — exposed for tests. */
  score: number;
};

/**
 * Apply the user's filter/sort to the catalog and return the rows the
 * marketplace UI should render, in order.
 *
 * The intent is for the UI to call this once per filter/hardware change
 * (it's O(n)). All side effects (installed-set membership, hardware
 * classification) are deterministic given the inputs.
 */
export function filterAndRank(args: {
  catalog: CatalogEntry[];
  filters: MarketplaceFilters;
  hardware: HardwareLike | null;
  installedModelIds: ReadonlyArray<string>;
}): MarketplaceRow[] {
  const { catalog, filters, hardware, installedModelIds } = args;
  const installedSet = new Set(installedModelIds);

  // Quick category match: if a category is selected, the entry must
  // *support* it; we don't require it to be the primary.
  const inCategory = (e: CatalogEntry) =>
    filters.category == null || e.categories.includes(filters.category);
  const inFamily = (e: CatalogEntry) =>
    filters.family == null || filters.family === "" || e.family === filters.family;

  // Tokenize the search query. Empty = always match. We split on
  // whitespace + punctuation that's not part of a model id (":", "."
  // and "-" stay attached so "qwen2.5-coder:7b" works as one token).
  const tokens = filters.query
    .trim()
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean);

  const rows: MarketplaceRow[] = [];
  for (const e of catalog) {
    if (!inCategory(e)) continue;
    if (!inFamily(e)) continue;

    const runnability = classifyRunnability(e, hardware);
    const installed = installedSet.has(e.id);

    if (filters.hideBlocked && runnability.level === "blocked") continue;
    if (filters.hideInstalled && installed) continue;

    const searchScore = tokens.length === 0 ? 0 : scoreSearch(e, tokens);
    if (tokens.length > 0 && searchScore < 0) continue;

    const baseScore = sortKey(e, filters, runnability, installed);
    // Combine: search relevance dominates when the user typed a query,
    // otherwise we fall back purely to the sort axis.
    const score = tokens.length > 0 ? -searchScore * 1000 + baseScore : baseScore;

    rows.push({ entry: e, runnability, installed, score });
  }

  rows.sort((a, b) => a.score - b.score);
  return rows;
}

/**
 * Return a non-negative match score for the entry against the tokens, or
 * `-1` when at least one token didn't match anywhere (AND semantics).
 *
 * Scoring: each token's best individual hit contributes points based on
 * *where* it hit. Prefix match on `id` / `family` is worth most because
 * that's the field a user is most likely typing toward.
 */
export function scoreSearch(entry: CatalogEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  // Pre-compute haystacks once per entry.
  const idLc = entry.id.toLowerCase();
  const familyLc = entry.family.toLowerCase();
  const displayLc = entry.displayName.toLowerCase();
  const publisherLc = entry.publisher.toLowerCase();
  const descLc = entry.description.toLowerCase();
  const licenseLc = entry.license.toLowerCase();
  const tagsLc = entry.tags.map((t) => t.toLowerCase());
  const categoriesLc = entry.categories.map((c) => c.toLowerCase());

  let total = 0;
  for (const raw of tokens) {
    const t = raw.toLowerCase();

    // Synthetic intents — useful for marketplace-style search.
    if (isSizeIntent(t)) {
      total += sizeIntentScore(entry, t);
      continue;
    }
    if (isQualityIntent(t)) {
      // "best", "top" → boost good quality rank.
      total += Math.max(0, 50 - entry.qualityRank * 5);
      continue;
    }
    if (isLicenseIntent(t)) {
      total += licenseIntentScore(entry, t);
      continue;
    }

    let best = 0;
    // Prefix matches are the strongest signal.
    if (idLc.startsWith(t)) best = Math.max(best, 100);
    if (familyLc.startsWith(t)) best = Math.max(best, 80);
    if (displayLc.startsWith(t)) best = Math.max(best, 60);

    // Substring within name fields.
    if (idLc.includes(t)) best = Math.max(best, 50);
    if (familyLc.includes(t)) best = Math.max(best, 45);
    if (displayLc.includes(t)) best = Math.max(best, 35);
    if (publisherLc.includes(t)) best = Math.max(best, 25);

    // Tag exact match.
    if (tagsLc.includes(t)) best = Math.max(best, 40);
    // Category direct match (e.g. "vision", "embed").
    if (categoriesLc.includes(t)) best = Math.max(best, 40);

    // Tag substring (handles "embed" → "indexing", which is a tag too).
    for (const tag of tagsLc) {
      if (tag.includes(t)) {
        best = Math.max(best, 20);
        break;
      }
    }

    // Description / license — last-resort match. Cheap signal.
    if (descLc.includes(t)) best = Math.max(best, 10);
    if (licenseLc.includes(t)) best = Math.max(best, 5);

    if (best === 0) return -1; // AND semantics: this token missed entirely.
    total += best;
  }
  return total;
}

function isSizeIntent(t: string): boolean {
  return ["small", "tiny", "fast", "light", "big", "huge", "large", "biggest"].includes(t);
}
function sizeIntentScore(entry: CatalogEntry, t: string): number {
  // "small" / "tiny" → prefer < 4B params. Score scales inversely so the
  // truly tiny models (embedders, 1B chat) outrank merely-small ones.
  if (["small", "tiny", "fast", "light"].includes(t)) {
    if (entry.params <= 0.1) return 90;
    if (entry.params <= 1) return 75;
    if (entry.params <= 2) return 60;
    if (entry.params <= 4) return 40;
    if (entry.params <= 8) return 10;
    return -1; // 8B+ is not "small".
  }
  // "big" / "huge" / "large" / "biggest" → prefer ≥ 30B.
  if (entry.params >= 30) return 60;
  if (entry.params >= 14) return 30;
  if (entry.params >= 7) return 5;
  return -1;
}
function isQualityIntent(t: string): boolean {
  return ["best", "top", "flagship"].includes(t);
}
function isLicenseIntent(t: string): boolean {
  return ["mit", "apache", "permissive", "free", "open", "commercial"].includes(t);
}
function licenseIntentScore(entry: CatalogEntry, t: string): number {
  const license = entry.license.toLowerCase();
  if (t === "mit") return license.includes("mit") ? 60 : -1;
  if (t === "apache") return license.includes("apache") ? 60 : -1;
  if (t === "permissive" || t === "free" || t === "open") {
    return /apache|mit|bsd|openrail/.test(license) ? 50 : -1;
  }
  if (t === "commercial") {
    // Anything *not* labelled "non-commercial" or "research" is fair game.
    return /non.?commercial|research/.test(license) ? -1 : 30;
  }
  return 0;
}

function sortKey(
  e: CatalogEntry,
  filters: MarketplaceFilters,
  run: RunnabilityReport,
  installed: boolean,
): number {
  // Installed entries float to the bottom for "best" sort so users see
  // new candidates first, but we still keep them visible unless the
  // hideInstalled filter is on.
  const installedBias = installed ? 10_000 : 0;

  // "blocked" entries sink to the bottom (when not filtered out).
  const runnabilityBias =
    run.level === "blocked" ? 50_000 : run.level === "tight" ? 100 : 0;

  switch (filters.sort) {
    case "smallest":
      return e.params * 100 + runnabilityBias + installedBias;
    case "largest":
      return -e.params * 100 + runnabilityBias + installedBias;
    case "popular":
      return e.popularityRank * 100 + runnabilityBias + installedBias;
    case "best":
    default: {
      // Quality rank only makes sense within the user's chosen category.
      // If they're browsing All Categories we fall back to "best in
      // primary category" which is the same number stored on the entry.
      const isPrimary =
        filters.category != null && e.primaryCategory === filters.category;
      const qualityScore = e.qualityRank * 100 + (isPrimary ? 0 : 25);
      return qualityScore + runnabilityBias + installedBias;
    }
  }
}

// ---------------------------------------------------------------------------
// Category label helpers (small enough to live here, used by the UI).
// ---------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<AiFeature, string> = {
  chat: "Chat",
  agent: "Agent",
  inlineEdit: "Inline edit",
  fim: "Tab complete",
  indexing: "Embeddings",
  vision: "Vision",
  document: "Documents",
};

export const CATEGORY_DESCRIPTIONS: Record<AiFeature, string> = {
  chat: "Models for the side chat panel — conversational reasoning, follow-ups.",
  agent: "Models that drive multi-step tool use. Need strong JSON / planning skills.",
  inlineEdit: "Models for Cmd+K inline edits in the editor buffer.",
  fim: "Tab-completion specialists. Base (non-instruct) models tuned for FIM.",
  indexing: "Embedding models for the @codebase semantic index.",
  vision: "Vision-language models that read screenshots / diagrams / PDFs with images.",
  document: "Long-context models for summarising PDFs, spreadsheets, and other docs.",
};
