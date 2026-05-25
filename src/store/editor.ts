import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { languageFromPath } from "@/lib/lang";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { useRecentEdits } from "@/store/recentEdits";
import { toast } from "@/components/Toast";

export type Tab = {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  language: string;
  /** When the on-disk version of this file changes while we have
   *  unsaved local edits, we capture the disk content here and
   *  surface a banner ("modified on disk") so the user can decide
   *  between reloading and keeping their work. Null when there is
   *  no pending external change. */
  externalContent?: string | null;
  /** When set, this tab opens a custom preview surface instead of
   *  Monaco. `image` surfaces a zoomable image viewer; `binary` is
   *  the catch-all for files we shouldn't try to render as text. */
  preview?: "image" | "binary";
};

type State = {
  tabs: Tab[];
  activePath: string | null;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveActive: () => Promise<void>;
  /** Save the active buffer to disk *without* invoking the
   *  configured formatter. Useful when the auto-formatter would
   *  mangle a checked-in fixture, or when the user wants a
   *  one-off raw save. */
  saveActiveRaw: () => Promise<void>;
  saveAll: () => Promise<void>;
  applyEdit: (path: string, content: string) => void;
  getActive: () => Tab | null;
  selection: { startLine: number; endLine: number; text: string } | null;
  setSelection: (sel: State["selection"]) => void;
  /** Live cursor position for the StatusBar's "Ln 12, Col 4" readout.
   *  Updated on every Monaco cursor move (cheap — just two ints into a
   *  small store). Cleared when the active tab has no editor. */
  cursor: { line: number; column: number } | null;
  setCursor: (c: State["cursor"]) => void;
  /** Drag-to-reorder support for the tab bar. Pinned tabs sort first
   *  and can't be displaced past the pinned/unpinned boundary. */
  reorderTab: (fromPath: string, toPath: string, position?: "before" | "after") => void;
  /** Pinned tabs are sticky at the left and survive "Close Others" /
   *  "Close All". Toggling re-sorts the visible row. */
  pinned: string[];
  togglePinned: (path: string) => void;
  /** Most-recently-closed tab stack — fuel for the "Reopen Closed Tab"
   *  command (Cmd+Shift+T). Capped to a small window since users rarely
   *  want to walk back further than a handful. */
  closedTabs: string[];
  reopenLastClosed: () => Promise<void>;
  /** Set by callers (Problems panel, search panel, future LSP go-to-def)
   *  to ask the active editor to reveal a position. Cleared by the
   *  Editor after applying. Nonce bumps so identical positions re-fire. */
  pendingReveal: { path: string; line: number; column: number; nonce: number } | null;
  revealAt: (path: string, line: number, column: number) => Promise<void>;
  clearPendingReveal: () => void;
  /** Create a new untitled (in-memory) scratch buffer. Returns the
   *  synthetic path used to identify the tab. Untitled buffers are
   *  saved with the OS file dialog on first save. */
  openUntitled: (initial?: string, language?: string) => Promise<string>;
};

/** Coalesces concurrent openFile(path) calls so the file can only land in the
 *  tab list once, even if the boot loop fires twice under React StrictMode. */
const inflightOpens = new Map<string, Promise<void>>();

/** Keep the closed-tab stack bounded. 20 is enough for normal navigation
 *  but small enough that the persisted session payload stays tiny. */
const CLOSED_TAB_LIMIT = 20;

export const useEditorStore = create<State>((set, get) => ({
  tabs: [],
  activePath: null,
  selection: null,
  cursor: null,
  closedTabs: [],
  pinned: [],
  pendingReveal: null,
  setSelection: (sel) => set({ selection: sel }),
  setCursor: (c) => set({ cursor: c }),
  reopenLastClosed: async () => {
    const stack = get().closedTabs;
    if (stack.length === 0) return;
    const last = stack[stack.length - 1];
    set({ closedTabs: stack.slice(0, -1) });
    await get().openFile(last);
  },
  togglePinned: (path) => {
    set((s) => {
      const isPinned = s.pinned.includes(path);
      const pinned = isPinned ? s.pinned.filter((p) => p !== path) : [...s.pinned, path];
      // Pinned tabs anchor to the left edge in the visual sort. We
      // keep the underlying tabs array as-is and let the Tabs
      // component render pinned-first; this preserves drag order
      // inside each group.
      useSession.getState().notePinnedTabs(pinned);
      return { pinned };
    });
    notifySession();
  },
  reorderTab: (fromPath, toPath, position = "before") => {
    if (fromPath === toPath) return;
    set((s) => {
      const tabs = [...s.tabs];
      const fromIdx = tabs.findIndex((t) => t.path === fromPath);
      const toIdx = tabs.findIndex((t) => t.path === toPath);
      if (fromIdx < 0 || toIdx < 0) return s;
      const [moved] = tabs.splice(fromIdx, 1);
      let insertAt = tabs.findIndex((t) => t.path === toPath);
      if (insertAt < 0) insertAt = tabs.length;
      if (position === "after") insertAt += 1;
      tabs.splice(insertAt, 0, moved);
      return { tabs };
    });
    notifySession();
  },
  revealAt: async (path, line, column) => {
    // Open the file (or activate if already open), then push a reveal
    // request the Editor effect picks up. We do this in two steps so the
    // tab list reflects the new active path before the editor mount
    // wires its reveal handler.
    await get().openFile(path);
    set({
      pendingReveal: { path, line, column, nonce: Date.now() },
    });
    // Record this jump in the global nav history. We do this *here*
    // (rather than in Editor.tsx) so non-editor jump sources
    // (Problems panel, search, Outline, breadcrumb symbol jump) all
    // contribute to the same back/forward stack.
    void import("@/store/navHistory").then(({ useNavHistory }) => {
      useNavHistory.getState().push({ path, line, column });
    });
  },
  clearPendingReveal: () => set({ pendingReveal: null }),
  openUntitled: async (initial = "", language = "plaintext") => {
    // Find an unused "Untitled-N" name. We scan existing tabs (not
    // disk) because untitled files don't live on disk yet.
    const existing = new Set(get().tabs.map((t) => t.path));
    let n = 1;
    while (existing.has(`untitled:Untitled-${n}`)) n += 1;
    const path = `untitled:Untitled-${n}`;
    const tab: Tab = {
      path,
      name: `Untitled-${n}`,
      content: initial,
      dirty: !!initial,
      language,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activePath: path }));
    notifySession();
    return path;
  },
  openFile: async (path) => {
    if (!path) return;
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      set({ activePath: path });
      notifySession();
      return;
    }
    const inflight = inflightOpens.get(path);
    if (inflight) {
      // Wait for the in-flight open to finish, but don't blindly
      // activate the path — the original open might have failed
      // (read error / forbidden / file removed), in which case no
      // tab will exist and setting activePath would leave the
      // editor pointing at nothing.
      try {
        await inflight;
      } catch {
        /* originator surfaces the toast — nothing for the
           secondary caller to add here */
      }
      if (get().tabs.some((t) => t.path === path)) {
        set({ activePath: path });
        notifySession();
      }
      return;
    }
    // Register the in-flight promise BEFORE awaiting it, but do the
    // actual work in a named helper rather than an inline IIFE.
    // Reason: when the helper hits the synchronous fast-path for
    // preview files (image / binary — no awaits) the old IIFE
    // pattern ran its `finally { delete }` clean-up BEFORE the
    // `.set(path, p)` line, leaving a resolved-but-undeletable
    // entry in the map. Subsequent opens of the same preview tab
    // would then short-circuit to `activePath = path` without ever
    // re-creating the tab, and the editor would render "No file
    // open". Doing the bookkeeping here, around a helper that
    // owns NONE of it, keeps the two concerns from racing.
    const p = loadAndAddTab(path, set, get);
    inflightOpens.set(path, p);
    try {
      await p;
    } finally {
      inflightOpens.delete(path);
      notifySession();
    }
  },
  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path);
      if (idx === -1) return s;
      const next = s.tabs.filter((t) => t.path !== path);
      const activePath =
        s.activePath === path
          ? next[idx]?.path ?? next[idx - 1]?.path ?? null
          : s.activePath;
      // Stash the closed path for "Reopen Closed Tab" (capped, dedup,
      // most-recent at the END so a simple pop restores it).
      const stack = s.closedTabs.filter((p) => p !== path);
      stack.push(path);
      const trimmed =
        stack.length > CLOSED_TAB_LIMIT
          ? stack.slice(stack.length - CLOSED_TAB_LIMIT)
          : stack;
      return {
        tabs: next,
        activePath,
        closedTabs: trimmed,
        // If we just closed the active tab and nothing replaced it, the
        // cursor readout would otherwise stay frozen on the old file.
        cursor: activePath === s.activePath ? s.cursor : null,
      };
    });
    notifySession();
  },
  setActive: (path) => {
    // Cursor is per-editor; clearing it on activation lets the next
    // mount push a fresh position (otherwise the StatusBar would show
    // the previous tab's last cursor for a frame).
    set({ activePath: path, cursor: null });
    notifySession();
    // Record a tab switch in the nav history at line 1 — the editor
    // will then re-push with the actual cursor on first move.
    void import("@/store/navHistory").then(({ useNavHistory }) => {
      useNavHistory.getState().push({ path, line: 1, column: 1 });
    });
  },
  updateContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, content, dirty: true } : t,
      ),
    }));
    // Refresh the FIM context's recent-edits LRU. We do this on every
    // keystroke (cheap — string slice + a single setState in a small
    // store), so cross-file completions always see the freshest
    // version of every touched file.
    useRecentEdits.getState().note(path, content);
    // Hot exit: persist the unsaved buffer through a tiny debounce
    // so we don't write to disk on every keystroke. The buffer is
    // cleared on save / discard.
    if (useSettings.getState().editorHotExit) {
      scheduleHotExitFlush(path, content);
    }
    // Auto-save: if the user picked "afterDelay" we save the file
    // N seconds after the last keystroke. Cheap setTimeout per
    // path; cancelled on the next keystroke or save.
    scheduleAutoSaveAfterDelay(path);
  },
  applyEdit: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, content, dirty: true } : t,
      ),
    }));
    useRecentEdits.getState().note(path, content);
  },
  saveActive: async () => {
    const tab = get().tabs.find((t) => t.path === get().activePath);
    if (!tab) return;
    if (isUntitled(tab.path)) {
      await saveUntitledViaDialog(tab);
      return;
    }
    const content = await formatBeforeSave(tab.path, tab.content);
    await ipc.writeTextFile(tab.path, content);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === tab.path ? { ...t, content, dirty: false } : t,
      ),
    }));
    // Saved — drop any stashed hot-exit buffer for this path.
    useSession.getState().noteHotExit(tab.path, null);
  },
  saveActiveRaw: async () => {
    const tab = get().tabs.find((t) => t.path === get().activePath);
    if (!tab) return;
    if (isUntitled(tab.path)) {
      await saveUntitledViaDialog(tab);
      return;
    }
    await ipc.writeTextFile(tab.path, tab.content);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === tab.path ? { ...t, dirty: false } : t,
      ),
    }));
    useSession.getState().noteHotExit(tab.path, null);
  },
  saveAll: async () => {
    for (const t of get().tabs) {
      if (!t.dirty) continue;
      if (isUntitled(t.path)) {
        await saveUntitledViaDialog(t);
        continue;
      }
      const content = await formatBeforeSave(t.path, t.content);
      await ipc.writeTextFile(t.path, content);
      set((s) => ({
        tabs: s.tabs.map((tt) =>
          tt.path === t.path ? { ...tt, content, dirty: false } : tt,
        ),
      }));
      useSession.getState().noteHotExit(t.path, null);
    }
  },
  getActive: () => {
    const p = get().activePath;
    return p ? get().tabs.find((t) => t.path === p) ?? null : null;
  },
}));

function notifySession() {
  const s = useEditorStore.getState();
  useSession.getState().noteTabs(
    s.tabs.map((t) => t.path),
    s.activePath,
  );
}

/**
 * Do the actual read + tab-creation for a path. Pure side-effect
 * helper that owns NO concurrency bookkeeping — that's `openFile`'s
 * job. Surfaces read failures as a user-visible toast so a click
 * that hits a permission error / forbidden path / removed file
 * doesn't silently do nothing, and re-throws so the caller's
 * inflight tracker can settle correctly.
 */
async function loadAndAddTab(
  path: string,
  set: (
    partial:
      | Partial<State>
      | ((s: State) => Partial<State>),
  ) => void,
  get: () => State,
): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  const previewKind = detectPreviewKind(path);
  if (previewKind) {
    // Skip the text read entirely — the image/binary preview UIs
    // read the file themselves with the right IPC (binary blob).
    if (get().tabs.some((t) => t.path === path)) {
      set({ activePath: path });
      return;
    }
    const tab: Tab = {
      path,
      name,
      content: "",
      dirty: false,
      language: "plaintext",
      preview: previewKind,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activePath: path }));
    return;
  }
  let fromDisk: string;
  try {
    fromDisk = await ipc.readTextFile(path);
  } catch (e) {
    // Common causes: permission denied, path resolved outside the
    // workspace (Forbidden), file removed between the tree render
    // and the click, IO error. Without this toast the click looks
    // broken — nothing visible happens.
    toast.error("Couldn't open file", {
      body: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  // Re-check after the awaited read so we never push a duplicate
  // if a concurrent caller raced ahead.
  if (get().tabs.some((t) => t.path === path)) {
    set({ activePath: path });
    return;
  }
  // Hot exit: if a persisted unsaved buffer exists *and* hot-exit
  // is enabled, restore it as the working content and mark the tab
  // dirty. If the saved-on-disk version matches the buffer we drop
  // the buffer (clean state).
  const session = useSession.getState();
  const hotExitEnabled = useSettings.getState().editorHotExit;
  const buffered = hotExitEnabled ? session.hotExitBuffers[path] : undefined;
  const dirty = buffered !== undefined && buffered !== fromDisk;
  const content = dirty ? buffered! : fromDisk;
  if (!dirty && buffered !== undefined) {
    session.noteHotExit(path, null);
  }
  const tab: Tab = {
    path,
    name,
    content,
    dirty,
    language: languageFromPath(path),
  };
  set((s) => ({ tabs: [...s.tabs, tab], activePath: path }));
}

/** Untitled tabs have synthetic paths so they never collide with
 *  real disk files. Anything beginning with `untitled:` is an
 *  in-memory scratch buffer that must go through the Save As dialog
 *  to land on disk. */
export function isUntitled(path: string): boolean {
  return path.startsWith("untitled:");
}

/** Decide whether to route `openFile(path)` to a custom preview UI
 *  rather than the text editor. We keep the list narrow because
 *  Monaco can render most extensions just fine (Markdown, JSON,
 *  TOML, …) — only formats that are *not text* go through here. */
export function detectPreviewKind(path: string): "image" | "binary" | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? m[1].toLowerCase() : "";
  const IMAGE_EXTS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "ico",
    "tif",
    "tiff",
    "avif",
  ]);
  if (IMAGE_EXTS.has(ext)) return "image";
  const BINARY_EXTS = new Set([
    "zip",
    "tar",
    "gz",
    "tgz",
    "bz2",
    "xz",
    "7z",
    "rar",
    "exe",
    "dll",
    "so",
    "dylib",
    "class",
    "jar",
    "war",
    "ear",
    "pyc",
    "pyo",
    "wasm",
    "o",
    "a",
    "lib",
    "obj",
    "bin",
    "dat",
    "db",
    "sqlite",
    "sqlite3",
    "mp3",
    "wav",
    "ogg",
    "flac",
    "m4a",
    "mp4",
    "mkv",
    "mov",
    "avi",
    "webm",
    "pdf",
  ]);
  if (BINARY_EXTS.has(ext)) return "binary";
  return null;
}

/** Prompt for a destination, save the untitled buffer's content
 *  there, then swap the tab's synthetic path for the real one so
 *  subsequent saves are silent. */
async function saveUntitledViaDialog(tab: Tab): Promise<void> {
  // We dynamic-import so the editor store doesn't drag the dialog
  // plugin in for non-untitled save paths.
  const { save } = await import("@tauri-apps/plugin-dialog");
  const useWorkspaceMod = await import("@/store/workspace");
  const ws = useWorkspaceMod.useWorkspace.getState();
  const defaultPath = ws.root ? `${ws.root}/${tab.name}` : tab.name;
  const target = await save({
    title: "Save As",
    defaultPath,
  });
  if (!target || typeof target !== "string") return;
  // Format-on-save pipeline still applies — language is derived
  // from the chosen file extension at write time.
  const content = await formatBeforeSave(target, tab.content);
  await ipc.writeTextFile(target, content);
  const newName = target.split(/[\\/]/).pop() ?? tab.name;
  useEditorStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.path === tab.path
        ? {
            ...t,
            path: target,
            name: newName,
            content,
            dirty: false,
            language: languageFromPath(target),
            externalContent: null,
          }
        : t,
    ),
    activePath: s.activePath === tab.path ? target : s.activePath,
    closedTabs: s.closedTabs.map((p) => (p === tab.path ? target : p)),
    pinned: s.pinned.map((p) => (p === tab.path ? target : p)),
  }));
  notifySession();
  useSession.getState().noteHotExit(tab.path, null);
}

/**
 * Format-on-save: when the user has it enabled, try the platform
 * formatter (Prettier / rustfmt / gofmt / black / shfmt / …) via
 * the backend `format_text` IPC. If the formatter isn't on PATH or
 * the language isn't recognized, fall back to the cheap
 * whitespace-trim + trailing-newline pass — same as the legacy
 * behavior.
 *
 * Async because real formatters shell out; called from the save
 * paths above which are already async. We swallow formatter errors
 * (e.g. invalid syntax) and save the un-formatted content rather
 * than blocking save — preserving the user's work always wins.
 */
async function formatBeforeSave(path: string, content: string): Promise<string> {
  const s = useSettings.getState();
  let out = content;
  if (s.editorFormatOnSave) {
    try {
      const r = await ipc.formatText(path, out);
      if (r.formatted && r.content) out = r.content;
    } catch {
      // Backend error — fall through; still apply the cheap pass below.
    }
  }
  return applyWhitespaceRules(out);
}

/** Whitespace policy applied unconditionally before save when the user has
 *  asked for it. Independent of the formatter: even if Prettier ran and
 *  reformatted everything, the user might still want trailing whitespace
 *  trimmed or a single trailing newline guaranteed. */
function applyWhitespaceRules(content: string): string {
  const s = useSettings.getState();
  let out = content;
  if (s.editorTrimTrailingWhitespace) {
    out = out
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n");
  }
  if (s.editorInsertFinalNewline && !out.endsWith("\n")) out += "\n";
  return out;
}

/** Used by auto-save's afterDelay scheduler — fully synchronous so
 *  the per-keystroke debouncer keeps its hot path tight. The real
 *  format pass kicks in on explicit save flows. */
function maybeFormatOnSave(content: string): string {
  return applyWhitespaceRules(content);
}

// ──────────────────────────────────────────────────────────────────
// Hot-exit + auto-save schedulers
// ──────────────────────────────────────────────────────────────────
//
// We persist unsaved buffers asynchronously so the user's typing
// doesn't pay an IPC roundtrip cost. Both schedulers are per-path
// (a Map of timers) so concurrent edits to multiple files don't
// stomp on each other.

const hotExitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Schedule a hot-exit write 400ms after the last keystroke. */
function scheduleHotExitFlush(path: string, content: string): void {
  const existing = hotExitTimers.get(path);
  if (existing) clearTimeout(existing);
  hotExitTimers.set(
    path,
    setTimeout(() => {
      hotExitTimers.delete(path);
      try {
        useSession.getState().noteHotExit(path, content);
      } catch {
        /* persist layer can transiently fail under heavy load; the next
           keystroke will reschedule, so it's safe to swallow. */
      }
    }, 400),
  );
}

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Schedule an auto-save N ms after the last keystroke when the
 *  user picked the "afterDelay" mode. The delay is read from
 *  settings each schedule so changes apply immediately. */
function scheduleAutoSaveAfterDelay(path: string): void {
  const s = useSettings.getState();
  if (s.editorAutoSave !== "afterDelay") return;
  const delay = Math.max(200, s.editorAutoSaveDelayMs ?? 1000);
  const existing = autoSaveTimers.get(path);
  if (existing) clearTimeout(existing);
  autoSaveTimers.set(
    path,
    setTimeout(async () => {
      autoSaveTimers.delete(path);
      const tab = useEditorStore.getState().tabs.find((t) => t.path === path);
      if (!tab || !tab.dirty) return;
      try {
        const content = maybeFormatOnSave(tab.content);
        await ipc.writeTextFile(path, content);
        useEditorStore.setState((state) => ({
          tabs: state.tabs.map((t) =>
            t.path === path ? { ...t, content, dirty: false } : t,
          ),
        }));
        useSession.getState().noteHotExit(path, null);
      } catch {
        // Silent — the explicit Save flow surfaces errors. We
        // don't want a transient FS hiccup to spawn toast spam.
      }
    }, delay),
  );
}

/** Save every dirty tab when the editor loses focus. Wired up
 *  from `App.tsx` via window blur once auto-save mode is "focusLoss". */
export async function autoSaveOnFocusLoss(): Promise<void> {
  if (useSettings.getState().editorAutoSave !== "focusLoss") return;
  await useEditorStore.getState().saveAll();
}
