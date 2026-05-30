import { create } from "@/lib/signalStore";
import { ipc } from "@/lib/ipc";
import { getItem, persistAsync } from "@/lib/persist";
import {
  DEFAULT_APP_THEME_ID,
  normalizeAppThemeId,
  type AppThemeId,
} from "@/theme/themes";

const SETTINGS_KEY = "settings.v1";
const ONBOARDED_KEY = "onboarded";

/**
 * Persisted slice. Anything stored across launches lives here.
 *
 * Model assignments use the empty string `""` to mean **unset**: the user has
 * not picked (or has just removed) the model that used to fill this slot.
 * We deliberately do NOT auto-heal — silently switching the assignment to a
 * random installed model was making it impossible for users to tell whether
 * their preferences were honored or quietly rewritten.
 */
type PersistedSettings = {
  chatModel?: string;
  fimModel?: string;
  embedModel?: string;
  agentModel?: string;
  /**
   * Multimodal model used to extract structured info from images and
   * (rasterized, eventually) PDFs. Empty string == "not set" — same rule as
   * the other slots, no auto-heal. We don't have a built-in default because
   * vision models are workload-specific.
   */
  visionModel?: string;
  /**
   * Text-only model used to summarise/structure document content already
   * extracted by Pointer (xlsx, csv, text-based PDFs). Separate from the
   * chat model so the user can keep a small, fast model around just for
   * ingestion without touching their main chat pick.
   */
  documentModel?: string;

  // Feature gates. When false the corresponding feature is disabled across
  // the app — IPC calls are skipped, UI affordances grey out, and shortcuts
  // do nothing. This gives the user a single, obvious switch per feature.
  chatEnabled?: boolean;
  agentEnabled?: boolean;
  inlineEditEnabled?: boolean;
  fimEnabled?: boolean;
  indexingEnabled?: boolean;

  // Daemon control.
  ollamaAutostart?: boolean;

  // Inline-completion sensitivity.
  fimDebounceMs?: number;
  fimTriggerMode?: "automatic" | "manual";

  // Editor preferences. Live-applied to the Monaco instance.
  editorFontSize?: number;
  editorTabSize?: number;
  editorInsertSpaces?: boolean;
  editorWordWrap?: boolean;
  editorRenderWhitespace?: boolean;
  editorFormatOnSave?: boolean;
  /** Auto-save behavior. `off` is the historical default. `focusLoss`
   *  saves when the editor loses focus. `afterDelay` saves N seconds
   *  after the last keystroke. */
  editorAutoSave?: "off" | "focusLoss" | "afterDelay";
  /** Delay (ms) used by the `afterDelay` auto-save mode. */
  editorAutoSaveDelayMs?: number;
  /** Sticky-scroll header bar inside Monaco. */
  editorStickyScroll?: boolean;
  /** Show breadcrumbs above the editor. */
  editorBreadcrumbs?: boolean;
  /** Restore unsaved buffers across reloads (hot exit). */
  editorHotExit?: boolean;
  /** Show Monaco minimap. */
  editorMinimap?: boolean;
  /** Trim trailing whitespace on save. */
  editorTrimTrailingWhitespace?: boolean;
  /** Ensure a single trailing newline on save. */
  editorInsertFinalNewline?: boolean;
  /** Respect prefers-reduced-motion for editor + UI animations. */
  reduceMotion?: boolean;
  /** Active app theme. Legacy "noir" / "light" values are migrated at load. */
  appTheme?: AppThemeId | "noir" | "light";
  /** File-tree sort mode. */
  treeSort?: "type" | "name";
  /** Show git blame for the current cursor line inline at the end
   *  of the line (GitLens-style). Defaults to on. */
  gitInlineBlame?: boolean;
  /** Stop unused external language-server processes after an idle window. */
  lspAutoStopEnabled?: boolean;
  /** Idle window in milliseconds before eligible language servers stop. */
  lspAutoStopIdleMs?: number;
};

/**
 * AI features the app knows about. Used by `featureCapability` and friends
 * so every gate (UI, call site, status bar) reads from the same enum.
 */
export type AiFeature =
  | "chat"
  | "agent"
  | "inlineEdit"
  | "fim"
  | "indexing"
  | "vision"
  | "document";

/**
 * Per-feature capability. Together with `isFeatureUsable` this gives every
 * caller — UI affordances, call-site guards, the status bar — a single,
 * consistent answer to "can this feature actually run right now?".
 *
 *  - "on"            : user enabled + model selected + model installed
 *  - "off"           : user explicitly turned the toggle off
 *  - "no_runtime"    : Ollama daemon isn't reachable yet
 *  - "no_models"     : zero models are installed locally
 *  - "needs_model"   : user enabled, but never picked a model for this slot
 *  - "model_missing" : user picked a model that's been uninstalled
 */
export type FeatureCapability =
  | "on"
  | "off"
  | "no_runtime"
  | "no_models"
  | "needs_model"
  | "model_missing";

type Settings = {
  ollamaReady: boolean;
  hydrated: boolean;
  onboarded: boolean;

  chatModel: string;
  fimModel: string;
  embedModel: string;
  agentModel: string;
  visionModel: string;
  documentModel: string;

  /**
   * Live list of model names currently installed in the local Ollama daemon.
   * NOT persisted — it's a polled view of runtime state. Whichever component
   * polls `ipc.ollamaListModels()` writes the result here so every
   * call-site can answer "is this model installed?" without re-polling.
   */
  installedModels: string[];

  chatEnabled: boolean;
  agentEnabled: boolean;
  inlineEditEnabled: boolean;
  fimEnabled: boolean;
  indexingEnabled: boolean;

  ollamaAutostart: boolean;

  fimDebounceMs: number;
  fimTriggerMode: "automatic" | "manual";

  editorFontSize: number;
  editorTabSize: number;
  editorInsertSpaces: boolean;
  editorWordWrap: boolean;
  editorRenderWhitespace: boolean;
  editorFormatOnSave: boolean;
  editorAutoSave: "off" | "focusLoss" | "afterDelay";
  editorAutoSaveDelayMs: number;
  editorStickyScroll: boolean;
  editorBreadcrumbs: boolean;
  editorHotExit: boolean;
  editorMinimap: boolean;
  editorTrimTrailingWhitespace: boolean;
  editorInsertFinalNewline: boolean;
  reduceMotion: boolean;
  appTheme: AppThemeId;
  treeSort: "type" | "name";
  gitInlineBlame: boolean;
  lspAutoStopEnabled: boolean;
  lspAutoStopIdleMs: number;

  init: () => Promise<void>;
  markOnboarded: () => void;
  setInstalledModels: (list: string[]) => void;

  setChatModel: (m: string) => void;
  setFimModel: (m: string) => void;
  setAgentModel: (m: string) => void;
  setEmbedModel: (m: string) => void;
  setVisionModel: (m: string) => void;
  setDocumentModel: (m: string) => void;

  setChatEnabled: (b: boolean) => void;
  setAgentEnabled: (b: boolean) => void;
  setInlineEditEnabled: (b: boolean) => void;
  setFimEnabled: (b: boolean) => void;
  setIndexingEnabled: (b: boolean) => void;

  setOllamaAutostart: (b: boolean) => void;

  setFimDebounceMs: (ms: number) => void;
  setFimTriggerMode: (mode: "automatic" | "manual") => void;
  setEditorFontSize: (n: number) => void;
  setEditorTabSize: (n: number) => void;
  setEditorInsertSpaces: (b: boolean) => void;
  setEditorWordWrap: (b: boolean) => void;
  setEditorRenderWhitespace: (b: boolean) => void;
  setEditorFormatOnSave: (b: boolean) => void;
  setEditorAutoSave: (m: "off" | "focusLoss" | "afterDelay") => void;
  setEditorAutoSaveDelayMs: (ms: number) => void;
  setEditorStickyScroll: (b: boolean) => void;
  setEditorBreadcrumbs: (b: boolean) => void;
  setEditorHotExit: (b: boolean) => void;
  setEditorMinimap: (b: boolean) => void;
  setEditorTrimTrailingWhitespace: (b: boolean) => void;
  setEditorInsertFinalNewline: (b: boolean) => void;
  setReduceMotion: (b: boolean) => void;
  setAppTheme: (t: AppThemeId) => void;
  setTreeSort: (m: "type" | "name") => void;
  setGitInlineBlame: (b: boolean) => void;
  setLspAutoStopEnabled: (b: boolean) => void;
  setLspAutoStopIdleMs: (ms: number) => void;

  setOllamaReady: (b: boolean) => void;

  /**
   * Clear every assignment whose model name is not in `installed`. Called
   * after a model is deleted so the user sees a clearly "unset" slot rather
   * than us silently picking a replacement.
   */
  unsetMissingModels: (installed: string[]) => string[];
};

const DEFAULTS = {
  chatModel: "qwen2.5-coder:7b-instruct",
  fimModel: "qwen2.5-coder:1.5b-base",
  embedModel: "nomic-embed-text",
  agentModel: "qwen2.5-coder:7b-instruct",
  // Vision and document slots start UNSET. Attaching the relevant file type
  // surfaces an explicit "pick a model" prompt, which is the behaviour the
  // user wants — we never silently grab their chat model for vision.
  visionModel: "",
  documentModel: "",

  chatEnabled: true,
  agentEnabled: true,
  inlineEditEnabled: true,
  fimEnabled: true,
  indexingEnabled: true,

  ollamaAutostart: true,

  fimDebounceMs: 120,
  fimTriggerMode: "automatic" as "automatic" | "manual",

  editorFontSize: 14,
  editorTabSize: 2,
  editorInsertSpaces: true,
  editorWordWrap: false,
  editorRenderWhitespace: false,
  editorFormatOnSave: false,
  editorAutoSave: "off" as "off" | "focusLoss" | "afterDelay",
  editorAutoSaveDelayMs: 1000,
  editorStickyScroll: false,
  editorBreadcrumbs: true,
  editorHotExit: true,
  editorMinimap: false,
  editorTrimTrailingWhitespace: false,
  editorInsertFinalNewline: false,
  reduceMotion: false,
  appTheme: DEFAULT_APP_THEME_ID,
  treeSort: "type" as "type" | "name",
  gitInlineBlame: true,
  lspAutoStopEnabled: true,
  lspAutoStopIdleMs: 5 * 60 * 1000,
};

export const LSP_AUTO_STOP_PRESETS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
] as const;

export function clampLspAutoStopIdleMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULTS.lspAutoStopIdleMs;
  return Math.max(30 * 1000, Math.min(2 * 60 * 60 * 1000, Math.round(ms)));
}

export const useSettings = create<Settings>((set, get) => ({
  ollamaReady: false,
  hydrated: false,
  onboarded: false,
  installedModels: [],
  ...DEFAULTS,
  init: async () => {
    const [persisted, onboarded, status] = await Promise.all([
      getItem<PersistedSettings>(SETTINGS_KEY).catch(() => undefined),
      getItem<boolean>(ONBOARDED_KEY).catch(() => false),
      ipc.ollamaStatus().catch(() => null),
    ]);
    // Honour the user's saved assignments verbatim. If the model they chose
    // isn't currently installed, we leave the slot as the persisted name —
    // the AI panel renders that as "Not installed" so the user can see the
    // mismatch and act on it.
    const merged: PersistedSettings = { ...DEFAULTS, ...(persisted ?? {}) };
    set({
      ...DEFAULTS,
      ...merged,
      appTheme: normalizeAppThemeId(merged.appTheme),
      lspAutoStopIdleMs: clampLspAutoStopIdleMs(
        merged.lspAutoStopIdleMs ?? DEFAULTS.lspAutoStopIdleMs,
      ),
      hydrated: true,
      onboarded: !!onboarded,
      ollamaReady: !!status?.running,
    });
  },
  markOnboarded: () => {
    set({ onboarded: true });
    persistAsync(ONBOARDED_KEY, true);
  },

  setInstalledModels: (list) => {
    // Avoid re-renders when the list didn't actually change. Polling fires
    // every few seconds; identical lists are the common case.
    const prev = get().installedModels;
    if (prev.length === list.length && prev.every((n, i) => n === list[i])) {
      return;
    }
    set({ installedModels: list });
  },

  setChatModel: (m) => persist(set, get, { chatModel: m }),
  setFimModel: (m) => persist(set, get, { fimModel: m }),
  setAgentModel: (m) => persist(set, get, { agentModel: m }),
  setEmbedModel: (m) => persist(set, get, { embedModel: m }),
  setVisionModel: (m) => persist(set, get, { visionModel: m }),
  setDocumentModel: (m) => persist(set, get, { documentModel: m }),

  setChatEnabled: (b) => persist(set, get, { chatEnabled: b }),
  setAgentEnabled: (b) => persist(set, get, { agentEnabled: b }),
  setInlineEditEnabled: (b) => persist(set, get, { inlineEditEnabled: b }),
  setFimEnabled: (b) => persist(set, get, { fimEnabled: b }),
  setIndexingEnabled: (b) => persist(set, get, { indexingEnabled: b }),

  setOllamaAutostart: (b) => persist(set, get, { ollamaAutostart: b }),

  setFimDebounceMs: (ms) => persist(set, get, { fimDebounceMs: ms }),
  setFimTriggerMode: (mode) => persist(set, get, { fimTriggerMode: mode }),
  setEditorFontSize: (n) => persist(set, get, { editorFontSize: n }),
  setEditorTabSize: (n) => persist(set, get, { editorTabSize: n }),
  setEditorInsertSpaces: (b) => persist(set, get, { editorInsertSpaces: b }),
  setEditorWordWrap: (b) => persist(set, get, { editorWordWrap: b }),
  setEditorRenderWhitespace: (b) =>
    persist(set, get, { editorRenderWhitespace: b }),
  setEditorFormatOnSave: (b) => persist(set, get, { editorFormatOnSave: b }),
  setEditorAutoSave: (m) => persist(set, get, { editorAutoSave: m }),
  setEditorAutoSaveDelayMs: (ms) =>
    persist(set, get, { editorAutoSaveDelayMs: Math.max(200, Math.min(60000, ms)) }),
  setEditorStickyScroll: (b) => persist(set, get, { editorStickyScroll: b }),
  setEditorBreadcrumbs: (b) => persist(set, get, { editorBreadcrumbs: b }),
  setEditorHotExit: (b) => persist(set, get, { editorHotExit: b }),
  setEditorMinimap: (b) => persist(set, get, { editorMinimap: b }),
  setEditorTrimTrailingWhitespace: (b) =>
    persist(set, get, { editorTrimTrailingWhitespace: b }),
  setEditorInsertFinalNewline: (b) =>
    persist(set, get, { editorInsertFinalNewline: b }),
  setReduceMotion: (b) => persist(set, get, { reduceMotion: b }),
  setAppTheme: (t) => persist(set, get, { appTheme: t }),
  setTreeSort: (m) => persist(set, get, { treeSort: m }),
  setGitInlineBlame: (b) => persist(set, get, { gitInlineBlame: b }),
  setLspAutoStopEnabled: (b) => persist(set, get, { lspAutoStopEnabled: b }),
  setLspAutoStopIdleMs: (ms) =>
    persist(set, get, { lspAutoStopIdleMs: clampLspAutoStopIdleMs(ms) }),

  setOllamaReady: (b) => set({ ollamaReady: b }),

  unsetMissingModels: (installed) => {
    const cleared: string[] = [];
    const s = get();
    const patch: Partial<Settings> = {};
    const check = (label: string, key: keyof Settings, value: string) => {
      if (value && !isModelInInstalledList(value, installed)) {
        cleared.push(`${label} (${value})`);
        (patch as Record<string, unknown>)[key] = "";
      }
    };
    check("Chat", "chatModel", s.chatModel);
    check("Agent", "agentModel", s.agentModel);
    check("Tab", "fimModel", s.fimModel);
    check("Embed", "embedModel", s.embedModel);
    check("Vision", "visionModel", s.visionModel);
    check("Document", "documentModel", s.documentModel);
    if (Object.keys(patch).length > 0) persist(set, get, patch);
    return cleared;
  },
}));

// ──────────────────────────────────────────────────────────────────────────
// Feature capability helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Which persisted model slot a given feature consumes. Centralising this
 * mapping means call-sites and the UI never disagree about which model the
 * Chat / Agent / FIM feature actually uses.
 *
 * Inline edit currently piggy-backs on the chat model — it shares the same
 * conversation prompt builder under the hood, and a user who's wired up
 * chat is already configured for ⌘K. If we ever split them, change here.
 */
export function featureModelKey(
  feature: AiFeature,
): "chatModel" | "agentModel" | "fimModel" | "embedModel" | "visionModel" | "documentModel" {
  switch (feature) {
    case "chat":
      return "chatModel";
    case "agent":
      return "agentModel";
    case "inlineEdit":
      return "chatModel";
    case "fim":
      return "fimModel";
    case "indexing":
      return "embedModel";
    case "vision":
      return "visionModel";
    case "document":
      return "documentModel";
  }
}

/**
 * Which user-facing on/off toggle controls the feature. Vision / document
 * are processing-time concerns rather than always-on background features
 * so they have no toggle — they're enabled implicitly whenever their model
 * slot is configured.
 */
export function featureEnabledKey(
  feature: AiFeature,
):
  | "chatEnabled"
  | "agentEnabled"
  | "inlineEditEnabled"
  | "fimEnabled"
  | "indexingEnabled"
  | null {
  switch (feature) {
    case "chat":
      return "chatEnabled";
    case "agent":
      return "agentEnabled";
    case "inlineEdit":
      return "inlineEditEnabled";
    case "fim":
      return "fimEnabled";
    case "indexing":
      return "indexingEnabled";
    case "vision":
    case "document":
      return null;
  }
}

/**
 * Compute the live capability of a feature. Order matters: we report the
 * most-specific reason first so the UI / toasts can explain exactly why a
 * feature is not running.
 */
export function featureCapability(
  feature: AiFeature,
  s: Settings = useSettings.getState(),
): FeatureCapability {
  const enabledKey = featureEnabledKey(feature);
  if (enabledKey && !s[enabledKey]) return "off";
  if (!s.ollamaReady) return "no_runtime";
  if (s.installedModels.length === 0) return "no_models";
  const model = s[featureModelKey(feature)];
  if (!model) return "needs_model";
  if (!isModelInInstalledList(model, s.installedModels)) return "model_missing";
  return "on";
}

/** Convenience: true iff the feature can actually issue a model call. */
export function isFeatureUsable(
  feature: AiFeature,
  s: Settings = useSettings.getState(),
): boolean {
  return featureCapability(feature, s) === "on";
}

/**
 * True iff `model` is a non-empty name AND known to be installed *right now*.
 *
 * Stale assignments — slots that still point at a model the user has since
 * uninstalled — return false. The convention through the rest of the UI is
 * that those slots read as "unset" rather than us silently showing the old
 * name as if it were active.
 *
 * Special case: when Ollama isn't ready we don't have a definitive install
 * list (the runtime is down, we never polled), so we report `false` rather
 * than trusting the stale slot. Surfaces that summarise current state then
 * say "no models" — which is honest — instead of advertising a model that
 * cannot be reached.
 */
export function isModelInstalled(
  model: string | undefined | null,
  s: Settings = useSettings.getState(),
): boolean {
  if (!model) return false;
  if (!s.ollamaReady) return false;
  return isModelInInstalledList(model, s.installedModels);
}

/**
 * Return the exact installed Ollama model name that satisfies a configured
 * assignment. Ollama accepts bare names such as `nomic-embed-text`, while the
 * runtime list often reports `nomic-embed-text:latest`; treating those as the
 * same model keeps settings resilient when users pull, remove, or retag local
 * models outside Pointer.
 */
export function resolveInstalledModelName(
  model: string | undefined | null,
  installedModels: string[],
): string {
  const configured = (model ?? "").trim();
  if (!configured) return "";
  const exact = installedModels.find((installed) => installed === configured);
  if (exact) return exact;

  const configuredParts = splitOllamaModelName(configured);
  return (
    installedModels.find((installed) => {
      const parts = splitOllamaModelName(installed);
      if (parts.base !== configuredParts.base) return false;
      if (!configuredParts.tag && parts.tag === "latest") return true;
      if (configuredParts.tag === "latest" && !parts.tag) return true;
      return false;
    }) ?? ""
  );
}

export function isModelInInstalledList(
  model: string | undefined | null,
  installedModels: string[],
): boolean {
  return !!resolveInstalledModelName(model, installedModels);
}

/**
 * The model name a runtime call should use right now. This differs from the
 * raw persisted assignment in one important way: when a user configured
 * `foo` and Ollama reports `foo:latest`, the call uses the installed name.
 * Missing/offline/disabled features return an empty string so callers can
 * block cleanly instead of issuing a doomed request.
 */
export function runnableModelForFeature(
  feature: AiFeature,
  s: Settings = useSettings.getState(),
): string {
  if (featureCapability(feature, s) !== "on") return "";
  return resolveInstalledModelName(s[featureModelKey(feature)], s.installedModels);
}

/**
 * The model name a feature is *effectively* using for display purposes —
 * either the configured slot if it's currently installed, or an empty
 * string if the slot is unset, points at a missing model, or the runtime
 * isn't up. UI summaries (titlebar pill, status-bar chip, welcome screen)
 * should route their model labels through this so they never claim a
 * model is active when it isn't.
 *
 * Note: runtime callers that need the exact installed Ollama name should use
 * `runnableModelForFeature`; this helper is the read-only display form and
 * preserves the user's configured label.
 */
export function effectiveAssignedModel(
  feature: AiFeature,
  s: Settings = useSettings.getState(),
): string {
  const m = s[featureModelKey(feature)];
  return isModelInstalled(m, s) ? m : "";
}

function splitOllamaModelName(model: string): { base: string; tag: string } {
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf("/");
  const colon = trimmed.lastIndexOf(":");
  if (colon > slash) {
    return {
      base: trimmed.slice(0, colon),
      tag: trimmed.slice(colon + 1),
    };
  }
  return { base: trimmed, tag: "" };
}

/** Human-readable explanation of *why* a feature is not "on". Empty when the
 *  feature is healthy. Used for tooltip / banner copy throughout the app so
 *  every surface explains the same thing the same way. */
export function featureBlockReason(
  feature: AiFeature,
  s: Settings = useSettings.getState(),
): string {
  const cap = featureCapability(feature, s);
  switch (cap) {
    case "on":
      return "";
    case "off":
      return "Turned off in AI Control Panel.";
    case "no_runtime":
      return "Ollama isn't running yet.";
    case "no_models":
      return "Install a model first — none are available locally.";
    case "needs_model":
      return "No model picked for this feature yet.";
    case "model_missing":
      return `Configured model isn't installed: ${s[featureModelKey(feature)]}`;
  }
}

function persist(
  set: (p: Partial<Settings>) => void,
  get: () => Settings,
  patch: Partial<Settings>,
) {
  set(patch);
  const s = get();
  persistAsync<PersistedSettings>(SETTINGS_KEY, {
    chatModel: s.chatModel,
    fimModel: s.fimModel,
    agentModel: s.agentModel,
    embedModel: s.embedModel,
    visionModel: s.visionModel,
    documentModel: s.documentModel,
    chatEnabled: s.chatEnabled,
    agentEnabled: s.agentEnabled,
    inlineEditEnabled: s.inlineEditEnabled,
    fimEnabled: s.fimEnabled,
    indexingEnabled: s.indexingEnabled,
    ollamaAutostart: s.ollamaAutostart,
    fimDebounceMs: s.fimDebounceMs,
    fimTriggerMode: s.fimTriggerMode,
    editorFontSize: s.editorFontSize,
    editorTabSize: s.editorTabSize,
    editorInsertSpaces: s.editorInsertSpaces,
    editorWordWrap: s.editorWordWrap,
    editorRenderWhitespace: s.editorRenderWhitespace,
    editorFormatOnSave: s.editorFormatOnSave,
    editorAutoSave: s.editorAutoSave,
    editorAutoSaveDelayMs: s.editorAutoSaveDelayMs,
    editorStickyScroll: s.editorStickyScroll,
    editorBreadcrumbs: s.editorBreadcrumbs,
    editorHotExit: s.editorHotExit,
    editorMinimap: s.editorMinimap,
    editorTrimTrailingWhitespace: s.editorTrimTrailingWhitespace,
    editorInsertFinalNewline: s.editorInsertFinalNewline,
    reduceMotion: s.reduceMotion,
    appTheme: s.appTheme,
    treeSort: s.treeSort,
    gitInlineBlame: s.gitInlineBlame,
    lspAutoStopEnabled: s.lspAutoStopEnabled,
    lspAutoStopIdleMs: s.lspAutoStopIdleMs,
  });
}
