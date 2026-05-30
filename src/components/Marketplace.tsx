import { useMemo, useState } from "@/lib/preactSignalCompat";
import {
  AlertTriangle,
  Check,
  Cpu,
  Download,
  Filter as FilterIcon,
  Loader2,
  RefreshCw,
  Search as SearchIcon,
  ShieldAlert,
  X,
} from "@/lib/lucide";
import type { HardwareProfile } from "@/lib/ipc";
import type { AiFeature } from "@/store/settings";
import { CATALOG, type CatalogEntry } from "@/lib/modelCatalog";
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  filterAndRank,
  type HardwareLike,
  type MarketplaceFilters,
  type MarketplaceRow,
} from "@/lib/marketplace";

const INITIAL_VISIBLE_ROWS = 80;
const VISIBLE_ROWS_STEP = 80;

/**
 * Inline model marketplace.
 *
 * Lives inside the AI control panel. The contract:
 *  - Pure UI for browsing & installing. All hardware probing and install
 *    pipelines are passed in by the host (so the same component can be
 *    re-used inside the onboarding wizard later without dragging the
 *    whole AIPanel along).
 *  - All ranking lives in `lib/marketplace.ts` — this file is just glue
 *    between filters, the catalog, and the UI.
 */
export function Marketplace({
  hardware,
  installedModelIds,
  ollamaRunning,
  activePulls,
  onPull,
  catalog = CATALOG,
  loading = false,
  error = null,
  onRefresh,
}: {
  hardware: HardwareProfile | null;
  installedModelIds: ReadonlyArray<string>;
  ollamaRunning: boolean;
  /** Map of in-flight pull state by model id. Used to render progress. */
  activePulls: Record<string, { pct: number; status: string; error: string | null }>;
  /** Kick off a pull. The host owns retry/cancel; we just call this. */
  onPull: (id: string) => void;
  catalog?: CatalogEntry[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  const [filters, setFilters] = useState<MarketplaceFilters>({
    query: "",
    category: null,
    family: null,
    // Default ON: hide blocked rows so users don't try to install models
    // that will OOM their machine. They can flip the filter to see them.
    hideBlocked: true,
    hideInstalled: false,
    sort: "best",
  });
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_ROWS);

  const hardwareLike: HardwareLike | null = useMemo(() => {
    if (!hardware) return null;
    return {
      total_ram_bytes: hardware.total_ram_bytes,
      available_ram_bytes: hardware.available_ram_bytes,
      gpu_label: hardware.gpu_label,
      os_name: hardware.os_name,
      arch: hardware.arch,
    };
  }, [hardware]);

  const rows: MarketplaceRow[] = useMemo(
    () =>
      filterAndRank({
        catalog,
        filters,
        hardware: hardwareLike,
        installedModelIds,
      }),
    [catalog, filters, hardwareLike, installedModelIds],
  );
  const visibleRows = useMemo(
    () => rows.slice(0, visibleLimit),
    [rows, visibleLimit],
  );
  const hiddenRowCount = Math.max(0, rows.length - visibleRows.length);

  // Live tally for the "X of Y" subtitle in the header.
  const total = useMemo(
    () =>
      catalog.filter((e) => {
        const categoryOk =
          filters.category == null || e.categories.includes(filters.category);
        const familyOk =
          filters.family == null || filters.family === "" || e.family === filters.family;
        return categoryOk && familyOk;
      }).length,
    [catalog, filters.category, filters.family],
  );

  const families = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of catalog) {
      counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

  // The hardware ceiling shown in the budget banner. We keep this as a
  // user-visible "this is what we're flagging against" so the colour codes
  // never feel arbitrary.
  const ramTotalGb = hardware ? hardware.total_ram_bytes / 1024 ** 3 : null;
  const ramFreeGb = hardware ? hardware.available_ram_bytes / 1024 ** 3 : null;

  return (
    <div className="space-y-2 font-sans">
      <HardwareBudget
        ramTotalGb={ramTotalGb}
        ramFreeGb={ramFreeGb}
        gpu={hardware?.gpu_label ?? null}
      />

      <CategoryPills
        active={filters.category}
        onChange={(c) => setFilters((f) => ({ ...f, category: c }))}
      />

      <div className="flex items-center gap-2 flex-wrap" role="search">
        <div className="relative flex-1 min-w-[180px]">
          <SearchIcon
            size={11}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-noir-mute pointer-events-none"
            aria-hidden="true"
          />
          <input
            value={filters.query}
            onChange={(e) =>
              setFilters((f) => ({ ...f, query: e.target.value }))
            }
            placeholder='Search: "qwen 7b apache", "vision ocr", "small embed"…'
            className="pn-input w-full pl-7 pr-7 font-mono text-[11.5px]"
            aria-label="Search models"
            type="search"
          />
          {filters.query && (
            <button
              onClick={() => setFilters((f) => ({ ...f, query: "" }))}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-noir-mute hover:text-noir-text"
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>

        <select
          value={filters.family ?? ""}
          onChange={(e) =>
            setFilters((f) => ({ ...f, family: e.target.value || null }))
          }
          className="pn-input text-[11.5px] max-w-[180px]"
          aria-label="Family"
        >
          <option value="">Family: all</option>
          {families.map(([family, count]) => (
            <option key={family} value={family}>
              {family} ({count})
            </option>
          ))}
        </select>

        <select
          value={filters.sort}
          onChange={(e) =>
            setFilters((f) => ({ ...f, sort: e.target.value as MarketplaceFilters["sort"] }))
          }
          className="pn-input text-[11.5px]"
          aria-label="Sort"
        >
          <option value="best">Sort: best for category</option>
          <option value="popular">Sort: most popular</option>
          <option value="smallest">Sort: smallest first</option>
          <option value="largest">Sort: largest first</option>
        </select>
      </div>

      {(loading || error || onRefresh) && (
        <div className="flex items-center gap-2 text-[10.5px] text-noir-mute">
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              className="pn-button font-sans inline-flex items-center gap-1 py-0.5 px-1.5"
              title="Refresh Ollama library"
            >
              <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          )}
          {loading && <span>Fetching Ollama library…</span>}
          {error && <span className="text-noir-warn">{error}</span>}
        </div>
      )}

      <div className="flex items-center gap-3 text-[10.5px] text-noir-mute" role="group" aria-label="Marketplace filters">
        <FilterIcon size={10} aria-hidden="true" />
        <Checkbox
          checked={filters.hideBlocked}
          onChange={(v) => setFilters((f) => ({ ...f, hideBlocked: v }))}
          label="Hide models I can't run"
        />
        <Checkbox
          checked={filters.hideInstalled}
          onChange={(v) => setFilters((f) => ({ ...f, hideInstalled: v }))}
          label="Hide installed"
        />
        <div
          className="ml-auto"
          role="status"
          aria-live="polite"
          aria-label={`${rows.length} matching models, ${visibleRows.length} rendered, ${total} in scope`}
        >
          <span className="text-noir-subtext">{rows.length}</span> of {total}
        </div>
      </div>

      {filters.category && (
        <div className="text-[10.5px] text-noir-mute italic px-1">
          {CATEGORY_DESCRIPTIONS[filters.category]}
        </div>
      )}

      <div
        className="rounded-lg border border-noir-line divide-y divide-noir-line/60 max-h-[420px] overflow-y-auto"
        data-testid="marketplace-list"
      >
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-noir-mute text-center">
            {filters.query
              ? "No models match. Try a broader search, another family, or turn off 'Hide models I can't run'."
              : "No models match the current filters."}
          </div>
        ) : (
          <>
            {visibleRows.map((row) => (
              <ModelCard
                key={row.entry.id}
                row={row}
                ollamaRunning={ollamaRunning}
                pulling={!!activePulls[row.entry.id]}
                pullProgress={activePulls[row.entry.id]?.pct}
                pullError={activePulls[row.entry.id]?.error ?? null}
                onPull={onPull}
              />
            ))}
            {hiddenRowCount > 0 && (
              <div className="px-3 py-2 bg-noir-canvas/35">
                <button
                  type="button"
                  onClick={() =>
                    setVisibleLimit((n) => Math.min(rows.length, n + VISIBLE_ROWS_STEP))
                  }
                  className="pn-button w-full justify-center font-sans text-[11px]"
                  aria-label={`Show ${Math.min(VISIBLE_ROWS_STEP, hiddenRowCount)} more models`}
                >
                  Show {Math.min(VISIBLE_ROWS_STEP, hiddenRowCount)} more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function HardwareBudget({
  ramTotalGb,
  ramFreeGb,
  gpu,
}: {
  ramTotalGb: number | null;
  ramFreeGb: number | null;
  gpu: string | null;
}) {
  if (ramTotalGb == null || ramFreeGb == null) {
    return (
      <div className="rounded-md border border-noir-line bg-noir-canvas/40 px-2.5 py-1.5 text-[10.5px] text-noir-mute">
        Detecting hardware…
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-noir-line bg-noir-canvas/40 px-2.5 py-1.5 text-[10.5px] text-noir-subtext flex items-center gap-2 flex-wrap"
      title="Marketplace badges are coloured against these numbers."
      role="status"
      aria-label={`Hardware budget: ${ramTotalGb.toFixed(0)} GB total RAM, ${ramFreeGb.toFixed(1)} GB free, ${gpu ? gpu : "CPU only"}`}
    >
      <Cpu size={11} className="text-noir-accent shrink-0" aria-hidden="true" />
      <span>
        Flagging against{" "}
        <strong className="text-noir-text">{ramTotalGb.toFixed(0)} GB</strong> RAM
        {" · "}
        <strong className="text-noir-text">{ramFreeGb.toFixed(1)} GB</strong> free
      </span>
      <span className="text-noir-mute" aria-hidden="true">·</span>
      <span className="truncate">{gpu ? gpu : "CPU only"}</span>
    </div>
  );
}

function CategoryPills({
  active,
  onChange,
}: {
  active: AiFeature | null;
  onChange: (v: AiFeature | null) => void;
}) {
  const order: (AiFeature | null)[] = [
    null,
    "chat",
    "agent",
    "fim",
    "indexing",
    "vision",
    "document",
    "inlineEdit",
  ];
  return (
    <div className="flex items-center gap-1 flex-wrap" role="tablist" aria-label="Filter by model category">
      {order.map((c) => {
        const label = c == null ? "All" : CATEGORY_LABELS[c];
        const isActive = active === c;
        return (
          <button
            key={String(c)}
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            onClick={() => onChange(c)}
            className={`text-[10.5px] px-2 py-0.5 rounded-md border transition ${
              isActive
                ? "border-noir-accent/70 bg-noir-accent/10 text-noir-text"
                : "border-noir-line text-noir-mute hover:text-noir-text hover:border-noir-line/80"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex items-center gap-1 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-noir-accent"
      />
      <span>{label}</span>
    </label>
  );
}

function RunnabilityBadge({ row }: { row: MarketplaceRow }) {
  const { level, reason } = row.runnability;
  if (level === "unknown") {
    return (
      <span
        className="text-[9.5px] font-sans px-1 py-[1px] rounded border border-noir-line/60 text-noir-mute"
        title={reason}
      >
        unknown fit
      </span>
    );
  }
  const map: Record<Exclude<typeof level, "unknown">, { label: string; cls: string; icon: React.ReactNode }> = {
    good: {
      label: "runs",
      cls: "border-noir-ok/40 text-noir-ok bg-noir-ok/5",
      icon: <Check size={9} />,
    },
    tight: {
      label: "tight fit",
      cls: "border-noir-warn/40 text-noir-warn bg-noir-warn/5",
      icon: <AlertTriangle size={9} />,
    },
    blocked: {
      label: "won't fit",
      cls: "border-noir-err/40 text-noir-err bg-noir-err/5",
      icon: <ShieldAlert size={9} />,
    },
  };
  const m = map[level as Exclude<typeof level, "unknown">];
  return (
    <span
      className={`text-[9.5px] font-sans px-1 py-[1px] rounded border inline-flex items-center gap-0.5 ${m.cls}`}
      title={reason}
    >
      {m.icon} {m.label}
    </span>
  );
}

function CategoryChip({ feature }: { feature: AiFeature }) {
  return (
    <span className="text-[9.5px] uppercase tracking-wider text-noir-mute font-sans px-1 py-[1px] rounded border border-noir-line/60">
      {CATEGORY_LABELS[feature]}
    </span>
  );
}

function ModelCard({
  row,
  ollamaRunning,
  pulling,
  pullProgress,
  pullError,
  onPull,
}: {
  row: MarketplaceRow;
  ollamaRunning: boolean;
  pulling: boolean;
  pullProgress?: number;
  pullError: string | null;
  onPull: (id: string) => void;
}) {
  const { entry, runnability, installed } = row;
  const blocked = runnability.level === "blocked";
  const installDisabled = pulling || !ollamaRunning || installed;
  const reasonForDisabled = installed
    ? "Already installed"
    : !ollamaRunning
    ? "Start Ollama first"
    : blocked
    ? `${runnability.reason} (install anyway from here is intentional — flag is advisory)`
    : `Pull ${entry.id}`;

  return (
    <div
      className={`px-3 py-2 flex items-start gap-3 ${
        blocked ? "bg-noir-err/[0.025]" : ""
      } ${runnability.level === "tight" ? "bg-noir-warn/[0.02]" : ""}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[11.5px] text-noir-text truncate">
            {entry.id}
          </span>
          <RunnabilityBadge row={row} />
          {entry.categories.slice(0, 3).map((c) => (
            <CategoryChip key={c} feature={c} />
          ))}
          {installed && (
            <span className="text-[9.5px] text-noir-ok font-sans inline-flex items-center gap-0.5">
              <Check size={9} /> installed
            </span>
          )}
        </div>
        <div className="text-[10.5px] text-noir-subtext font-sans line-clamp-2">
          {entry.description}
        </div>
        <div className="text-[10px] text-noir-mute font-sans mt-0.5 flex gap-2 flex-wrap">
          <span>{entry.family}</span>
          <span>·</span>
          <span>{entry.publisher}</span>
          <span>·</span>
          <span>{entry.params}B params</span>
          <span>·</span>
          <span>~{entry.diskGb.toFixed(1)} GB</span>
          <span>·</span>
          <span>≥{entry.minRamGb.toFixed(0)} GB RAM</span>
          <span>·</span>
          <span>{formatCtx(entry.contextTokens)} ctx</span>
          <span>·</span>
          <span className="truncate" title={entry.license}>
            {entry.license}
          </span>
          {entry.pulls && (
            <>
              <span>·</span>
              <span>{entry.pulls} pulls</span>
            </>
          )}
          {entry.updated && (
            <>
              <span>·</span>
              <span>updated {entry.updated}</span>
            </>
          )}
        </div>
        {pullError && (
          <div className="text-[10px] text-noir-err font-sans mt-1">
            Pull failed: {pullError}
          </div>
        )}
        {pulling && (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 bg-noir-ridge rounded-full overflow-hidden">
              <div
                className="h-full bg-noir-accent transition-[width]"
                style={{ width: `${pullProgress ?? 0}%` }}
              />
            </div>
            <span className="text-[10px] text-noir-mute">{pullProgress ?? 0}%</span>
          </div>
        )}
      </div>
      <button
        onClick={() => onPull(entry.id)}
        disabled={installDisabled}
        className={`pn-button font-sans inline-flex items-center gap-1 text-[10.5px] shrink-0 ${
          blocked && !installed ? "border-noir-err/40 text-noir-err hover:bg-noir-err/10" : ""
        }`}
        title={reasonForDisabled}
        aria-label={installed ? "Installed" : `Install ${entry.id}`}
        data-testid={`pull-${entry.id}`}
      >
        {installed ? (
          <>
            <Check size={10} /> Installed
          </>
        ) : pulling ? (
          <>
            <Loader2 size={10} className="animate-spin" /> Pulling
          </>
        ) : (
          <>
            <Download size={10} />
            {blocked ? "Install (risky)" : "Install"}
          </>
        )}
      </button>
    </div>
  );
}

function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

// Re-export for test imports.
export { CATALOG };
export type { CatalogEntry, MarketplaceRow };
