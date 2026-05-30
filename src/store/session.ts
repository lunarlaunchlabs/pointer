import { create } from "@/lib/signalStore";
import { getItem, persistAsync } from "@/lib/persist";

const SESSION_KEY = "session.v1";
const RECENTS_KEY = "recents.v1";
const VIEW_STATE_KEY = "viewState.v1";
const HOT_EXIT_KEY = "hotExit.v1";
const PINNED_TABS_KEY = "pinnedTabs.v1";
const MAX_RECENTS = 8;

/** Which content the right dock shows. `null` = dock collapsed (rail only).
 *
 *  `"assistant"` is the unified Ask/Plan/Agent panel — it replaces the
 *  legacy `"chat"` and `"agent"` views. The `init()` migration below maps
 *  old persisted values to `"assistant"` so an existing user's dock
 *  selection survives the rename. */
export type DockView =
  | "assistant"
  | "history"
  | "ai"
  | "activity"
  | "scm"
  | "debug"
  | null;

/** Per-file editor state we restore across sessions: where the
 *  cursor was, where the viewport was scrolled to, and any
 *  collapsed folding regions. Keyed by absolute path. */
export type EditorViewState = {
  line: number;
  column: number;
  scrollTop?: number;
  scrollLeft?: number;
  /** Opaque Monaco IEditorViewState payload. We store it as JSON
   *  because some Monaco internals (folding/selection arrays) are
   *  cheaper to round-trip via the editor's own helpers than to
   *  reconstruct by hand. Stored as a string so the persist layer
   *  doesn't have to know about Monaco internals. */
  monacoBlob?: string;
};

export type SessionSnapshot = {
  root?: string | null;
  openTabs?: string[];
  activePath?: string | null;
  chatOpen?: boolean;
  fileTreeWidth?: number;
  chatWidth?: number;
  /** Persisted heights / widths for the resizable IDE chrome. Each
   *  is independently adjustable so the user can hand-tune the
   *  layout once and have it stick across launches. */
  terminalHeight?: number;
  rightDockWidth?: number;
  dockView?: DockView;
  treeCollapsed?: boolean;
  /** When true, every chrome panel (tree, right dock, terminal,
   *  status bar, breadcrumbs) collapses so the editor takes the
   *  whole window. Toggled via the View › Zen Mode action. */
  zenMode?: boolean;
};

type SessionState = SessionSnapshot & {
  recents: string[];
  hydrated: boolean;
  /** Per-file cursor + scroll + folding state. */
  viewState: Record<string, EditorViewState>;
  /** Per-file unsaved buffer content (hot exit). Cleared once the
   *  file is saved or the user explicitly discards. */
  hotExitBuffers: Record<string, string>;
  /** Pinned tab paths. Stored at the session level so they survive
   *  reloads alongside the open-tabs list. */
  pinnedTabs: string[];
  init: () => Promise<{
    session: SessionSnapshot;
    recents: string[];
    viewState: Record<string, EditorViewState>;
    hotExitBuffers: Record<string, string>;
    pinnedTabs: string[];
  }>;
  noteRoot: (root: string | null) => void;
  noteTabs: (paths: string[], active: string | null) => void;
  noteChatOpen: (open: boolean) => void;
  noteFileTreeWidth: (w: number) => void;
  noteChatWidth: (w: number) => void;
  noteTerminalHeight: (h: number) => void;
  noteRightDockWidth: (w: number) => void;
  noteDockView: (v: DockView) => void;
  noteTreeCollapsed: (v: boolean) => void;
  noteZenMode: (v: boolean) => void;
  removeRecent: (path: string) => void;
  noteViewState: (path: string, vs: EditorViewState) => void;
  noteHotExit: (path: string, content: string | null) => void;
  notePinnedTabs: (paths: string[]) => void;
  rewritePathPrefix: (oldPath: string, newPath: string) => void;
};

export const useSession = create<SessionState>((set, get) => ({
  root: null,
  openTabs: [],
  activePath: null,
  chatOpen: true,
  fileTreeWidth: 256,
  chatWidth: 420,
  terminalHeight: 280,
  rightDockWidth: 360,
  dockView: "assistant",
  treeCollapsed: false,
  zenMode: false,
  recents: [],
  hydrated: false,
  viewState: {},
  hotExitBuffers: {},
  pinnedTabs: [],
  init: async () => {
    const [session, recents, viewState, hotExitBuffers, pinnedTabs] = await Promise.all([
      getItem<SessionSnapshot>(SESSION_KEY).catch(() => undefined),
      getItem<string[]>(RECENTS_KEY).catch(() => undefined),
      getItem<Record<string, EditorViewState>>(VIEW_STATE_KEY).catch(() => undefined),
      getItem<Record<string, string>>(HOT_EXIT_KEY).catch(() => undefined),
      getItem<string[]>(PINNED_TABS_KEY).catch(() => undefined),
    ]);
    const s: SessionSnapshot = session ?? {};
    set({
      hydrated: true,
      root: s.root ?? null,
      openTabs: s.openTabs ?? [],
      activePath: s.activePath ?? null,
      chatOpen: s.chatOpen ?? true,
      fileTreeWidth: s.fileTreeWidth ?? 256,
      chatWidth: s.chatWidth ?? 420,
      terminalHeight: s.terminalHeight ?? 280,
      rightDockWidth: s.rightDockWidth ?? 360,
      // Default to the unified Assistant view. Legacy persisted values
      // "chat" and "agent" both map to "assistant" so a user whose dock
      // was last open on either of the old surfaces sees the unified
      // panel after upgrade — no broken empty dock, no lost layout.
      // `null` (rail-only / collapsed) is preserved explicitly.
      dockView:
        s.dockView === undefined
          ? "assistant"
          : (s.dockView as unknown) === "chat" || (s.dockView as unknown) === "agent"
            ? "assistant"
            : s.dockView,
      treeCollapsed: s.treeCollapsed ?? false,
      zenMode: s.zenMode ?? false,
      recents: recents ?? [],
      viewState: viewState ?? {},
      hotExitBuffers: hotExitBuffers ?? {},
      pinnedTabs: pinnedTabs ?? [],
    });
    return {
      session: s,
      recents: recents ?? [],
      viewState: viewState ?? {},
      hotExitBuffers: hotExitBuffers ?? {},
      pinnedTabs: pinnedTabs ?? [],
    };
  },
  noteRoot: (root) => {
    set({ root });
    flush(get());
    if (root) {
      const rec = [root, ...get().recents.filter((r) => r !== root)].slice(
        0,
        MAX_RECENTS,
      );
      set({ recents: rec });
      persistAsync(RECENTS_KEY, rec);
    }
  },
  noteTabs: (paths, active) => {
    set({ openTabs: paths, activePath: active });
    flush(get());
  },
  noteChatOpen: (open) => {
    set({ chatOpen: open });
    flush(get());
  },
  noteFileTreeWidth: (w) => {
    set({ fileTreeWidth: w });
    flush(get());
  },
  noteChatWidth: (w) => {
    set({ chatWidth: w });
    flush(get());
  },
  noteTerminalHeight: (h) => {
    set({ terminalHeight: h });
    flush(get());
  },
  noteRightDockWidth: (w) => {
    set({ rightDockWidth: w });
    flush(get());
  },
  noteDockView: (v) => {
    set({ dockView: v });
    flush(get());
  },
  noteZenMode: (v) => {
    set({ zenMode: v });
    flush(get());
  },
  noteTreeCollapsed: (v) => {
    set({ treeCollapsed: v });
    flush(get());
  },
  removeRecent: (path) => {
    const rec = get().recents.filter((r) => r !== path);
    set({ recents: rec });
    persistAsync(RECENTS_KEY, rec);
  },
  noteViewState: (path, vs) => {
    // Keep this map bounded so a busy user doesn't accumulate
    // megabytes of monaco blobs over weeks. 200 files is a sensible
    // working-set ceiling; the oldest entries drop first.
    const next = { ...get().viewState, [path]: vs };
    const MAX = 200;
    const keys = Object.keys(next);
    if (keys.length > MAX) {
      // Drop the keys that came earliest (Object key order is
      // insertion order for string keys in modern JS engines).
      const overflow = keys.slice(0, keys.length - MAX);
      for (const k of overflow) delete next[k];
    }
    set({ viewState: next });
    persistAsync(VIEW_STATE_KEY, next);
  },
  noteHotExit: (path, content) => {
    const next = { ...get().hotExitBuffers };
    if (content === null) delete next[path];
    else next[path] = content;
    set({ hotExitBuffers: next });
    persistAsync(HOT_EXIT_KEY, next);
  },
  notePinnedTabs: (paths) => {
    set({ pinnedTabs: paths });
    persistAsync(PINNED_TABS_KEY, paths);
  },
  rewritePathPrefix: (oldPath, newPath) => {
    const rewrite = (path: string): string => rewritePathPrefix(path, oldPath, newPath);
    const s = get();
    const openTabs = (s.openTabs ?? []).map(rewrite);
    const activePath = s.activePath ? rewrite(s.activePath) : s.activePath;
    const pinnedTabs = s.pinnedTabs.map(rewrite);
    const viewState = rewriteRecordKeys(s.viewState, rewrite);
    const hotExitBuffers = rewriteRecordKeys(s.hotExitBuffers, rewrite);
    set({ openTabs, activePath, pinnedTabs, viewState, hotExitBuffers });
    flush(get());
    persistAsync(PINNED_TABS_KEY, pinnedTabs);
    persistAsync(VIEW_STATE_KEY, viewState);
    persistAsync(HOT_EXIT_KEY, hotExitBuffers);
  },
}));

function rewritePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  return path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
}

function rewriteRecordKeys<T>(
  record: Record<string, T>,
  rewrite: (path: string) => string,
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [path, value] of Object.entries(record)) {
    const rewritten = rewrite(path);
    if (rewritten !== path) changed = true;
    next[rewritten] = value;
  }
  return changed ? next : record;
}

function flush(s: SessionState) {
  persistAsync<SessionSnapshot>(SESSION_KEY, {
    root: s.root,
    openTabs: s.openTabs,
    activePath: s.activePath,
    chatOpen: s.chatOpen,
    fileTreeWidth: s.fileTreeWidth,
    chatWidth: s.chatWidth,
    terminalHeight: s.terminalHeight,
    rightDockWidth: s.rightDockWidth,
    dockView: s.dockView,
    treeCollapsed: s.treeCollapsed,
    zenMode: s.zenMode,
  });
}
