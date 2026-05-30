import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "@/lib/preactSignalCompat";

/** Run `fn` exactly once for the lifetime of this module. We can't use a
 *  React ref because StrictMode unmounts/remounts; we need a process-wide
 *  guard so the second mount becomes a no-op. */
let _bootStarted: Promise<void> | null = null;
function bootOnce(fn: () => Promise<void>): Promise<void> {
  if (!_bootStarted) _bootStarted = fn();
  return _bootStarted;
}

/**
 * Walk all known diagnostics in a deterministic order (uri then position),
 * pick the next/previous one relative to the current editor cursor, and
 * jump to it. Used by F8 / Shift+F8 so the user can sweep through problems
 * with keyboard only — the same gesture VS Code's Problem nav uses.
 */
/** Polyfill for crypto.randomUUID when running in older webviews
 *  that don't expose it (rare on modern Tauri, but cheap to keep). */
function fallbackUuid(): string {
  const rnd = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${rnd()}${rnd()}-${rnd()}-${rnd()}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

function navigateProblem(direction: "next" | "prev") {
  const byUri = useDiagnostics.getState().byUri;
  const flat: Diagnostic[] = [];
  for (const list of Object.values(byUri)) flat.push(...list);
  if (flat.length === 0) {
    void import("@/components/Toast").then(({ toast }) =>
      toast.info("No problems to navigate"),
    );
    return;
  }
  flat.sort((a, b) => {
    if (a.uri !== b.uri) return a.uri.localeCompare(b.uri);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.startCol - b.startCol;
  });
  const ed = useEditorStore.getState();
  const current = ed.cursor;
  const activeUri = ed.activePath ? `file://${ed.activePath}` : null;
  // Find the diagnostic strictly after / before the current cursor;
  // when none qualify, wrap around to the first / last so the
  // shortcut always lands somewhere useful.
  let target: Diagnostic | null = null;
  if (direction === "next") {
    target =
      flat.find((d) =>
        activeUri && current
          ? d.uri === activeUri
            ? d.startLine > current.line ||
              (d.startLine === current.line && d.startCol > current.column)
            : d.uri > activeUri
          : true,
      ) ?? flat[0]!;
  } else {
    const reversed = [...flat].reverse();
    target =
      reversed.find((d) =>
        activeUri && current
          ? d.uri === activeUri
            ? d.startLine < current.line ||
              (d.startLine === current.line && d.startCol < current.column)
            : d.uri < activeUri
          : true,
      ) ?? reversed[0]!;
  }
  if (!target) return;
  const path = target.uri
    .replace(/^file:\/\//, "")
    .replace(/^\/([A-Za-z]):/, "$1:");
  useEditorStore
    .getState()
    .revealAt(path, target.startLine, target.startCol)
    .catch(() => {});
}
import { Clock, Folder, Sparkles, X } from "@/lib/lucide";
import { Titlebar } from "@/components/Titlebar";
import { FileTree } from "@/components/FileTree";
import { Outline } from "@/components/Outline";
import { Tabs } from "@/components/Tabs";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { useTerminals, nextTerminalTitle } from "@/store/terminal";
import { StatusBar } from "@/components/StatusBar";
import { RightDock } from "@/components/RightDock";
import { ToastHost, toast } from "@/components/Toast";
import { LspIdleManager } from "@/components/LspIdleManager";
import { RefactorSuggestion } from "@/components/RefactorSuggestion";
import { PointerMarkSvg, PointerWordmarkSvg } from "@/components/BrandLogo";
import { createRefactorWatcher } from "@/lib/refactorWatcher";
import { useWorkspace } from "@/store/workspace";
import { useGit } from "@/store/git";
import {
  useSettings,
  isFeatureUsable,
  featureBlockReason,
  effectiveAssignedModel,
} from "@/store/settings";
import { useEditorStore, autoSaveOnFocusLoss, type Tab } from "@/store/editor";
import { useDiffViewer } from "@/store/diffViewer";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import { useSession } from "@/store/session";
import { useAssistant } from "@/store/assistant";
import { dispatchAction, onAction, type ActionId } from "@/lib/actions";
import { ipc, listenEvent, type GitCredentialPrompt } from "@/lib/ipc";
import { markE2EAppReady } from "@/lib/e2eHooks";
import { choose, useConfirm, ConfirmModalHost } from "@/components/Confirm";
import { secretPrompt, SecretPromptHost } from "@/components/SecretPrompt";
import {
  POINTER_THEMES,
  applyPointerThemeToDocument,
  themeActionId,
} from "@/theme/themes";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

const MarkdownView = lazy(() =>
  import("@/components/MarkdownView").then((m) => ({ default: m.MarkdownView })),
);
const Editor = lazy(() =>
  import("@/components/Editor").then((m) => ({ default: m.Editor })),
);
const DiffView = lazy(() =>
  import("@/components/DiffView").then((m) => ({ default: m.DiffView })),
);
const CommandPalette = lazy(() =>
  import("@/components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const FileFinder = lazy(() =>
  import("@/components/FileFinder").then((m) => ({ default: m.FileFinder })),
);
const FindInFiles = lazy(() =>
  import("@/components/FindInFiles").then((m) => ({ default: m.FindInFiles })),
);
const OpenRecentPicker = lazy(() =>
  import("@/components/OpenRecentPicker").then((m) => ({
    default: m.OpenRecentPicker,
  })),
);
const WorkspaceSymbols = lazy(() =>
  import("@/components/WorkspaceSymbols").then((m) => ({
    default: m.WorkspaceSymbols,
  })),
);
const NotificationCenter = lazy(() =>
  import("@/components/NotificationCenter").then((m) => ({
    default: m.NotificationCenter,
  })),
);
const TasksPicker = lazy(() =>
  import("@/components/TasksPicker").then((m) => ({ default: m.TasksPicker })),
);
const BookmarksPicker = lazy(() =>
  import("@/components/BookmarksPicker").then((m) => ({
    default: m.BookmarksPicker,
  })),
);
const LanguagePicker = lazy(() =>
  import("@/components/LanguagePicker").then((m) => ({
    default: m.LanguagePicker,
  })),
);
const ProblemsPanel = lazy(() =>
  import("@/components/Problems/ProblemsPanel").then((m) => ({
    default: m.ProblemsPanel,
  })),
);
const ShortcutsHelp = lazy(() =>
  import("@/components/ShortcutsHelp").then((m) => ({
    default: m.ShortcutsHelp,
  })),
);
const Onboarding = lazy(() =>
  import("@/components/Onboarding/Wizard").then((m) => ({
    default: m.Onboarding,
  })),
);
const ImagePreview = lazy(() =>
  import("@/components/Preview").then((m) => ({ default: m.ImagePreview })),
);
const BinaryPreview = lazy(() =>
  import("@/components/Preview").then((m) => ({ default: m.BinaryPreview })),
);
const TerminalPanel = lazy(() =>
  import("@/components/Terminal/TerminalPanel").then((m) => ({
    default: m.TerminalPanel,
  })),
);
const SystemMonitor = lazy(() =>
  import("@/components/SystemMonitor").then((m) => ({ default: m.SystemMonitor })),
);
const SettingsPage = lazy(() =>
  import("@/components/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

const activeGitCredentialPrompts = new Set<string>();

export default function App() {
  const [showPalette, setShowPalette] = useState(false);
  const [showFinder, setShowFinder] = useState(false);
  const [showFindInFiles, setShowFindInFiles] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showOpenRecent, setShowOpenRecent] = useState(false);
  const [showWorkspaceSymbols, setShowWorkspaceSymbols] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);
  const [sidebarView, setSidebarView] = useState<"files" | "outline">("files");
  // Markdown preview state keyed by tab path. Each file picks its own
  // mode independently: "preview" = full pane, "split" = source +
  // preview side by side. `null` (or absent) means "show source only".
  const [mdPreview, setMdPreview] = useState<Record<string, "preview" | "split" | null>>({});

  const initSettings = useSettings((s) => s.init);
  const markOnboarded = useSettings((s) => s.markOnboarded);
  const settingsHydrated = useSettings((s) => s.hydrated);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const appTheme = useSettings((s) => s.appTheme);

  // Apply body-level flags so global CSS can react. The theme registry owns
  // every app + editor palette; this effect only publishes it to CSS vars.
  useEffect(() => {
    const cls = document.body.classList;
    cls.toggle("pn-reduce-motion", !!reduceMotion);
    applyPointerThemeToDocument(appTheme);
    void ipc.setAppIconTheme(appTheme).catch((err) => {
      console.warn("failed to update themed app icon", err);
    });
    void ipc.setThemeMenuActive(appTheme).catch((err) => {
      console.warn("failed to update active theme menu item", err);
    });
  }, [reduceMotion, appTheme]);

  const initSession = useSession((s) => s.init);
  const sessionHydrated = useSession((s) => s.hydrated);
  const dockView = useSession((s) => s.dockView);
  const noteDockView = useSession((s) => s.noteDockView);
  const recents = useSession((s) => s.recents);
  const removeRecent = useSession((s) => s.removeRecent);
  const treeCollapsed = useSession((s) => s.treeCollapsed);
  const zenMode = useSession((s) => s.zenMode ?? false);
  const noteTreeCollapsed = useSession((s) => s.noteTreeCollapsed);
  const fileTreeWidth = useSession((s) => s.fileTreeWidth);

  // ⌘L toggles the unified Assistant view; ⌘, toggles AI control view.
  // If the dock is collapsed (or showing a different view) the toggle
  // expands to the requested view first.
  const toggleDockView = (target: "assistant" | "history" | "ai") => {
    noteDockView(dockView === target ? null : target);
  };
  const showDockView = (target: "assistant" | "history" | "ai") => {
    if (dockView !== target) noteDockView(target);
  };

  const root = useWorkspace((s) => s.root);
  const setRoot = useWorkspace((s) => s.setRoot);
  const terminalOpen = useTerminals((s) => s.open);

  const openFile = useEditorStore((s) => s.openFile);
  const setActive = useEditorStore((s) => s.setActive);
  const saveActive = useEditorStore((s) => s.saveActive);
  const saveAll = useEditorStore((s) => s.saveAll);
  const activeEditorTab = useEditorStore((s) => s.getActive());
  const diffSpec = useDiffViewer((s) => s.spec);
  const setFimEnabled = useSettings((s) => s.setFimEnabled);
  const setChatEnabled = useSettings((s) => s.setChatEnabled);
  const setAgentEnabled = useSettings((s) => s.setAgentEnabled);
  const setInlineEditEnabled = useSettings((s) => s.setInlineEditEnabled);
  const setIndexingEnabled = useSettings((s) => s.setIndexingEnabled);

  const askConfirm = useConfirm();

  // Boot sequence: hydrate persisted state, restore session, then decide whether
  // to show the onboarding wizard.
  //
  // React StrictMode runs effects twice in dev — both invocations would race
  // through `openFile(path)`, both pass the "tab already open?" check before
  // either has set state, and we'd end up with the same file tabbed twice. A
  // module-level boot promise pins this to exactly one execution.
  useEffect(() => {
    bootOnce(async () => {
      await Promise.all([initSettings(), initSession()]);
      // Restore bookmarks lazily — they're orthogonal to the
      // session boot path, so we don't block hydrate-readiness on
      // them. Worst case the gutter glyphs flash in a tick late.
      void (async () => {
        try {
          const { useBookmarks } = await import("@/store/bookmarks");
          await useBookmarks.getState().init();
        } catch {
          /* persistence missing — ignore */
        }
      })();
      void (async () => {
        try {
          const { useDebuggerStore } = await import("@/store/debugger");
          await useDebuggerStore.getState().init();
        } catch {
          /* persistence missing — ignore */
        }
      })();
      // Honour the user's autostart preference: only fire the daemon when
      // they've opted in. The Ollama status poll will reflect either way.
      try {
        const st = useSettings.getState();
        if (st.ollamaAutostart && !st.ollamaReady) {
          ipc.ollamaStart().catch(() => {
            /* surfaced via status poll + AI panel */
          });
        }
      } catch {
        /* ignore */
      }
      const sess = useSession.getState();
      if (sess.root) {
        try {
          await setRoot(sess.root);
          // Dedup paths before replay in case a stale session.v1 wrote
          // duplicates from before this fix shipped.
          const seen = new Set<string>();
          for (const p of sess.openTabs ?? []) {
            if (!p || seen.has(p)) continue;
            seen.add(p);
            try {
              await openFile(p);
            } catch {
              /* file may have been deleted while we were gone */
            }
          }
          if (sess.activePath) setActive(sess.activePath);
        } catch (e) {
          console.warn("session restore failed", e);
        }
      }
      if (!useSettings.getState().onboarded) setShowOnboarding(true);
      markE2EAppReady();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Git status: track the open workspace and poll on a coarse interval.
  // The poll is deliberately slow (5s) because the FileTree dot only needs
  // soft-real-time accuracy. Explicit refreshes happen on save and on
  // window focus so the user always sees an up-to-date dot after their
  // own actions.
  useEffect(() => {
    const git = useGit.getState();
    git.setWorkspace(root || "");
    if (!root) return;
    const id = window.setInterval(() => {
      useGit.getState().refresh();
    }, 5000);
    const onFocus = () => useGit.getState().refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [root]);

  // Keep tree/tab git colors tight after external writes, agent patches,
  // staging, and checkout-style changes. The watcher can emit bursts, so
  // refresh git once after the dust settles instead of per event.
  useEffect(() => {
    let off: (() => void) | undefined;
    let timer: number | undefined;
    listenEvent<{ kind: string; paths: string[] }>("fs:change", () => {
      if (!useGit.getState().workspace) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void useGit.getState().refresh();
      }, 350);
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      off?.();
    };
  }, []);

  // Also refresh git status whenever the editor finishes a save. That's
  // the single highest-signal moment for "the dirty set probably changed",
  // so it should not wait for the coarse poll or watcher debounce.
  useEffect(() => {
    const unsub = useEditorStore.subscribe((state, prev) => {
      // Compare the count of dirty tabs to detect clean->dirty transitions
      // and save events (dirty->clean). Either way we want to re-poll git.
      const a = state.tabs.filter((t) => t.dirty).length;
      const b = prev.tabs.filter((t) => t.dirty).length;
      if (a !== b) useGit.getState().refresh();
    });
    return unsub;
  }, []);

  // Refactor watcher: listens for editor content changes and, when
  // the user pauses typing, asks "did you just rename a single
  // identifier?". If so + the rest of the workspace still references
  // the old name, we surface a "apply rename everywhere?" card. The
  // watcher is constructed once and torn down on unmount.
  useEffect(() => {
    const watcher = createRefactorWatcher({
      search: (q, l) => ipc.searchText(q, l),
    });
    const unsub = useEditorStore.subscribe((state, prev) => {
      // Find tabs whose content changed since the previous state.
      // We diff the maps cheaply by walking the new tabs and
      // comparing pointers / content.
      const prevByPath = new Map(prev.tabs.map((t) => [t.path, t.content]));
      for (const tab of state.tabs) {
        const before = prevByPath.get(tab.path);
        if (before === tab.content) continue;
        watcher.observe(tab.path, tab.content);
      }
    });
    return () => {
      unsub();
      watcher.dispose();
    };
  }, []);

  /**
   * Spawn a terminal in the workspace root with a default title. Lives at
   * App scope because the ⌘` shortcut, the View menu, and the empty-state
   * button all call into the same code path.
   */
  const spawnTerminalFromShortcut = useCallback(async () => {
    const ws = useWorkspace.getState().root;
    const { id, title } = nextTerminalTitle();
    try {
      const result = await ipc.terminalOpen(id, ws, 100, 24);
      useTerminals.getState().add({
        id,
        title,
        shell: result.shell,
        cwd: ws || "",
        exited: false,
        exitCode: null,
      });
    } catch (e: any) {
      toast.error(`Failed to start terminal: ${e?.message ?? e}`);
    }
  }, []);

  /** Close a tab; if dirty, prompt to Save / Discard / Cancel. */
  const closeTabWithGuard = useCallback(async (path: string): Promise<boolean> => {
    const editor = useEditorStore.getState();
    const tab = editor.tabs.find((t) => t.path === path);
    if (!tab) return true;
    let pathToClose = path;
    if (tab.dirty) {
      editor.setActive(path);
      const choice = await choose({
        title: `Save changes to ${tab.name}?`,
        body: "This file has unsaved edits. Closing without saving will lose them.",
        confirmLabel: "Save & close",
        secondaryLabel: "Discard",
        cancelLabel: "Cancel",
      });
      if (choice === "cancel") return false;
      if (choice === "confirm") {
        try {
          await useEditorStore.getState().saveActive();
        } catch (e) {
          toast.error("Couldn't save before closing", {
            body: e instanceof Error ? e.message : String(e),
          });
          return false;
        }
        const after = useEditorStore.getState();
        const savedTab =
          after.tabs.find((t) => t.path === path) ??
          (after.activePath ? after.tabs.find((t) => t.path === after.activePath) : null);
        if (savedTab?.dirty) return false;
        pathToClose = savedTab?.path ?? path;
      } else {
        useSession.getState().noteHotExit(path, null);
      }
    }
    useEditorStore.getState().closeTab(pathToClose);
    return true;
  }, []);

  /** Close the active tab; if dirty, prompt to save / discard. */
  const closeActiveTab = useCallback(async () => {
    const editor = useEditorStore.getState();
    const tab = editor.tabs.find((t) => t.path === editor.activePath);
    if (!tab) return;
    await closeTabWithGuard(tab.path);
  }, [closeTabWithGuard]);

  const closeTabsWithGuard = useCallback(
    async (paths: string[], restoreActivePath?: string | null) => {
      for (const path of paths) {
        const closed = await closeTabWithGuard(path);
        if (!closed) break;
      }
      if (
        restoreActivePath &&
        useEditorStore.getState().tabs.some((t) => t.path === restoreActivePath)
      ) {
        useEditorStore.getState().setActive(restoreActivePath);
      }
    },
    [closeTabWithGuard],
  );

  const switchWorkspaceRoot = useCallback(
    async (nextRoot: string): Promise<boolean> => {
      const currentRoot = useWorkspace.getState().root;
      if (currentRoot === nextRoot) return true;
      const openPaths = useEditorStore.getState().tabs.map((t) => t.path);
      if (openPaths.length > 0) {
        await closeTabsWithGuard(openPaths);
        if (useEditorStore.getState().tabs.length > 0) return false;
      }
      useDiffViewer.getState().close();
      setMdPreview({});
      await setRoot(nextRoot);
      return true;
    },
    [closeTabsWithGuard, setRoot],
  );

  const openFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await switchWorkspaceRoot(selected);
    }
  }, [switchWorkspaceRoot]);

  /** ⌘K chord state. After ⌘K is pressed without a follow-up
   *  modifier, we enter "chord mode" and wait up to 1.5s for a
   *  second keystroke. This mirrors VS Code's binding semantics so
   *  shortcuts like ⌘K Z (Zen), ⌘K ⌘S (Keyboard Shortcuts), etc.
   *  feel natural to users coming from VS Code. */
  const chordTimerRef = useRef<number | null>(null);
  const inChordRef = useRef<boolean>(false);
  const clearChord = useCallback(() => {
    inChordRef.current = false;
    if (chordTimerRef.current != null) {
      window.clearTimeout(chordTimerRef.current);
      chordTimerRef.current = null;
    }
  }, []);
  const armChord = useCallback(() => {
    inChordRef.current = true;
    if (chordTimerRef.current != null)
      window.clearTimeout(chordTimerRef.current);
    chordTimerRef.current = window.setTimeout(clearChord, 1500);
  }, [clearChord]);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Chord-second-key handling first. Once armed, we consume the
      // next non-modifier keypress regardless of whether it matches
      // a known chord — that's what users expect; otherwise the
      // editor would receive a stray Z, M, etc.
      if (inChordRef.current) {
        if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") {
          return;
        }
        e.preventDefault();
        const k = e.key.toLowerCase();
        clearChord();
        if (k === "z") dispatchAction("view:toggle_zen");
        else if (k === "s" && !e.shiftKey)
          dispatchAction("file:save_without_formatting");
        else if (k === "s" && e.shiftKey) dispatchAction("help:shortcuts");
        else if (k === "m") dispatchAction("view:toggle_minimap");
        else if (k === "w") dispatchAction("view:toggle_word_wrap");
        else if (k === "t") dispatchAction("view:toggle_terminal");
        else if (k === "o") openFolder();
        // Any other key just consumes the chord and is a no-op.
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        // Arm the ⌘K chord. We don't preventDefault here for the
        // first keystroke — Monaco needs to know if the user
        // actually meant a single-stroke ⌘K (delete line in some
        // bindings) — but we set up a window to capture the next
        // key globally.
        e.preventDefault();
        armChord();
        return;
      }
      if (mod && e.shiftKey && (e.code === "Space" || e.key === " ")) {
        // ⌘⇧Space — explicitly ask the FIM model for a completion.
        // This is the manual counterpart to automatic tab completion.
        e.preventDefault();
        dispatchAction("ai:request_fim");
        return;
      }
      if (mod && e.shiftKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setShowPalette(true);
        setShowFinder(false);
      } else if (mod && !e.shiftKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setShowFinder(true);
        setShowPalette(false);
      } else if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        openFolder();
      } else if (mod && !e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveActive();
      } else if (mod && e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveAll();
      } else if (mod && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        closeActiveTab();
      } else if (mod && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        noteTreeCollapsed(!treeCollapsed);
      } else if (mod && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        toggleDockView("assistant");
      } else if (mod && e.shiftKey && e.key === ",") {
        // ⌘⇧, → AI Control Panel. The old single-key gesture is
        // reclaimed for the dedicated Settings page below.
        e.preventDefault();
        toggleDockView("ai");
      } else if (mod && e.key === ",") {
        // ⌘, → Settings (VS Code / macOS parity).
        e.preventDefault();
        setShowSettings(true);
      } else if (mod && e.shiftKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        setShowMonitor((v) => !v);
      } else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setShowFindInFiles((v) => !v);
      } else if (mod && e.shiftKey && (e.key === "t" || e.key === "T")) {
        // NOTE: ⌘J (Toggle Terminal) and ⌘` (New Terminal) used to be
        // intercepted here too, but the native menu in
        // `src-tauri/src/menu.rs` already registers those same
        // accelerators. On macOS BOTH paths fire for one keystroke —
        // the menu emits `menu:action` → action handler spawns, AND
        // this JS keydown also runs and spawns. The two spawns race on
        // `nextTerminalTitle()` (which reads `tabs.length === 0` both
        // times because neither `ipc.terminalOpen` has returned yet),
        // so the user sees two tabs both labelled "Terminal 1". The
        // menu accelerator is now the sole path — the action handler
        // at `onAction("view:toggle_terminal" / "view:new_terminal")`
        // below does the right thing in both cases.
        // ⌘⇧T — reopen the most recently closed tab. Matches every
        // major editor and is the #1 ask after the user accidentally
        // ⌘W's the wrong file.
        e.preventDefault();
        dispatchAction("tabs:reopen_closed");
      } else if (mod && e.altKey && (e.key === "ArrowRight")) {
        e.preventDefault();
        dispatchAction("tabs:next");
      } else if (mod && e.altKey && (e.key === "ArrowLeft")) {
        e.preventDefault();
        dispatchAction("tabs:prev");
      } else if (mod && e.shiftKey && (e.key === "b" || e.key === "B")) {
        // ⌘⇧B — Run task (VS Code parity for "Run Build Task").
        e.preventDefault();
        dispatchAction("tasks:run");
      } else if (mod && e.altKey && (e.key === "k" || e.key === "K")) {
        // ⌘⌥K — toggle bookmark on the current line. Modeled on the
        // Bookmarks extension binding for VS Code; not in use
        // elsewhere in our keymap.
        e.preventDefault();
        dispatchAction("bookmark:toggle");
      } else if (mod && e.altKey && (e.key === "." || e.key === ">")) {
        // ⌘⌥. — next bookmark in this file.
        e.preventDefault();
        dispatchAction("bookmark:next");
      } else if (mod && e.altKey && (e.key === "," || e.key === "<")) {
        // ⌘⌥, — previous bookmark in this file.
        e.preventDefault();
        dispatchAction("bookmark:prev");
      } else if (mod && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        dispatchAction("editor:goto_line");
      } else if (mod && e.shiftKey && (e.key === "o" || e.key === "O")) {
        // Free up ⌘⇧O for Goto Symbol — ⌘O already opens folder.
        e.preventDefault();
        dispatchAction("editor:goto_symbol_file");
      } else if (mod && (e.key === "t" || e.key === "T") && !e.shiftKey) {
        // ⌘T — workspace symbol search (matches VS Code).
        e.preventDefault();
        dispatchAction("editor:goto_symbol_workspace");
      } else if (mod && e.key === "?") {
        // ⌘? — keyboard cheat sheet. Easier-to-reach version of the
        // VS Code F1 / menu Help → Keyboard.
        e.preventDefault();
        dispatchAction("help:shortcuts");
      } else if (mod && e.shiftKey && (e.key === "i" || e.key === "I")) {
        // ⌘⇧I — format document (mirrors VS Code's ⇧⌥F when alt is
        // hard to reach with the rest of the keyboard).
        e.preventDefault();
        dispatchAction("editor:format_document");
      } else if (mod && (e.key === "+" || e.key === "=")) {
        // ⌘+ (or ⌘= since "+" requires shift on US layouts) — zoom in.
        e.preventDefault();
        dispatchAction("view:font_zoom_in");
      } else if (mod && e.key === "-") {
        e.preventDefault();
        dispatchAction("view:font_zoom_out");
      } else if (mod && e.key === "0") {
        e.preventDefault();
        dispatchAction("view:font_zoom_reset");
      } else if (e.altKey && !mod && (e.key === "z" || e.key === "Z")) {
        // ⌥Z — toggle word wrap (VS Code parity). Skip when the
        // editor is focused so users typing Z don't lose the toggle.
        const target = e.target as HTMLElement | null;
        const inField =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          (target as { isContentEditable?: boolean } | null)?.isContentEditable;
        if (!inField) {
          e.preventDefault();
          dispatchAction("view:toggle_word_wrap");
        }
      } else if (mod && e.shiftKey && (e.key === "e" || e.key === "E")) {
        // ⌘⇧E — focus the file tree's filter. Matches the VS Code
        // "Focus Explorer" gesture closely enough for muscle memory.
        e.preventDefault();
        if (treeCollapsed) noteTreeCollapsed(false);
        dispatchAction("tree:focus_filter");
      } else if (mod && e.shiftKey && (e.key === "g" || e.key === "G")) {
        // ⌘⇧G — open the Source Control panel (VS Code parity).
        e.preventDefault();
        dispatchAction("git:show_panel");
      } else if (mod && (e.key === "r" || e.key === "R") && !e.shiftKey) {
        // ⌘R — Open Recent picker (VS Code parity). The browser's
        // "reload page" gesture has no meaning inside Tauri, so we
        // can reclaim it.
        e.preventDefault();
        dispatchAction("file:open_recent");
      } else if (e.key === "F8" && !e.shiftKey) {
        e.preventDefault();
        dispatchAction("editor:next_problem");
      } else if (e.key === "F8" && e.shiftKey) {
        e.preventDefault();
        dispatchAction("editor:prev_problem");
      } else if (mod && e.shiftKey && (e.key === "v" || e.key === "V")) {
        // ⌘⇧V — toggle Markdown preview for the active file
        // (VS Code parity). The editor knows whether the file is
        // Markdown — non-md tabs surface a hint and a no-op.
        e.preventDefault();
        dispatchAction("md:toggle_preview");
      } else if (mod && e.altKey && e.key === "[") {
        // ⌘⌥[ — fold the section at the cursor (VS Code parity).
        e.preventDefault();
        dispatchAction("editor:fold");
      } else if (mod && e.altKey && e.key === "]") {
        // ⌘⌥] — unfold at the cursor.
        e.preventDefault();
        dispatchAction("editor:unfold");
      } else if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "-") {
        // Ctrl+- — navigate back through cursor history (VS Code parity
        // on macOS; we use Ctrl on all platforms because Alt-Left is
        // already wired to "move word" inside Monaco).
        e.preventDefault();
        dispatchAction("editor:nav_back");
      } else if (e.ctrlKey && !e.metaKey && e.shiftKey && e.key === "_") {
        // Ctrl+Shift+- — forward through history. `_` is the shifted
        // form of `-` on US keyboards, so we match either form.
        e.preventDefault();
        dispatchAction("editor:nav_forward");
      } else if (e.ctrlKey && !e.metaKey && e.shiftKey && e.key === "-") {
        e.preventDefault();
        dispatchAction("editor:nav_forward");
      } else if (e.key === "Escape") {
        setShowPalette(false);
        setShowFinder(false);
        setShowFindInFiles(false);
        // Close the diff overlay too — Esc is the standard close
        // gesture and the user expects it to work uniformly across
        // every transient surface.
        if (useDiffViewer.getState().spec) {
          useDiffViewer.getState().close();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openFolder, saveActive, saveAll, closeActiveTab, dockView, treeCollapsed],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  // Auto-save on focus loss when the user opts in. The blur event
  // fires for every tab/dock change inside the window too, but we
  // gate inside autoSaveOnFocusLoss on the persisted setting so
  // unrelated focus juggling is cheap (one settings read).
  useEffect(() => {
    const onBlur = () => {
      autoSaveOnFocusLoss().catch(() => {});
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // Native OS drag-and-drop. The Tauri window event gives us absolute
  // paths (HTML5 dnd does not), which is what we need to open files
  // and folders. Heuristic: a single folder = open as workspace,
  // otherwise open every dropped file in a tab.
  useEffect(() => {
    let unlisten: undefined | (() => void);
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        unlisten = await win.onDragDropEvent(async (event) => {
          if (event.payload.type !== "drop") return;
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          if (
            (window as unknown as { __pointerDropContext?: string })
              .__pointerDropContext === "assistant"
          ) {
            const { stat } = await import("@tauri-apps/plugin-fs");
            const assistant = useAssistant.getState();
            for (const p of paths) {
              try {
                const meta = await stat(p);
                assistant.addRef({ kind: meta.isDirectory ? "folder" : "file", path: p });
              } catch {
                assistant.addRef({ kind: "file", path: p });
              }
            }
            noteDockView("assistant");
            return;
          }
          if (paths.length === 1) {
            // If it's a folder, treat as "open workspace". We
            // dynamic-import the FS plugin so this is cost-free for
            // users who never drag anything.
            try {
              const { stat } = await import("@tauri-apps/plugin-fs");
              const meta = await stat(paths[0]);
              if (meta.isDirectory) {
                await switchWorkspaceRoot(paths[0]);
                return;
              }
            } catch {
              /* fall through to "open as file" */
            }
          }
          for (const p of paths) {
            try {
              await useEditorStore.getState().openFile(p);
            } catch (e) {
              console.warn("drag-open failed", p, e);
            }
          }
        });
      } catch (e) {
        console.warn("dnd listener failed", e);
      }
    })();
    return () => {
      try {
        unlisten?.();
      } catch {
        /* no-op */
      }
    };
  }, [switchWorkspaceRoot]);

  // Bridge: the native macOS menu emits `menu:action` from Rust. Re-dispatch
  // each one through the same action bus the in-app shortcuts use — so File →
  // Save (menu), ⌘S (keyboard), and the palette all hit one code path.
  useEffect(() => {
    let off: (() => void) | undefined;
    listenEvent<{ id: ActionId }>("menu:action", (p) => {
      if (p?.id) dispatchAction(p.id);
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  // Git remote operations can request SSH key passphrases or HTTPS
  // credentials. Those prompts must stay inside Pointer rather than
  // leaking to the terminal that launched `tauri dev`.
  useEffect(() => {
    let off: (() => void) | undefined;
    listenEvent<GitCredentialPrompt>("git:credential-prompt", async (prompt) => {
      if (!prompt?.id) return;
      if (activeGitCredentialPrompts.has(prompt.id)) return;
      activeGitCredentialPrompts.add(prompt.id);
      const response = await secretPrompt({
        title: "Git authentication",
        prompt: prompt.prompt,
        secret: prompt.secret,
        confirmLabel: "Send to Git",
      });
      await ipc.gitCredentialRespond(prompt.id, response).catch((error) => {
        toast.error("Git prompt expired", { body: String(error) });
      }).finally(() => {
        activeGitCredentialPrompts.delete(prompt.id);
      });
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  // Bridge "New File / New Folder" from the menu, palette, etc. into the
  // workspace store. The FileTree component watches `pendingCreate` and
  // renders the inline input. If no folder is open yet we tell the user
  // instead of silently doing nothing — which is what the bug audit caught.
  const beginCreateFromMenu = useCallback(
    (kind: "file" | "folder") => {
      const ws = useWorkspace.getState();
      if (!ws.root) {
        toast.warn("Open a folder first", {
          body: "Use File → Open Folder (⌘O) to pick a workspace.",
        });
        return;
      }
      // The tree must be visible for the user to actually see the new-name
      // input. Expand it if collapsed.
      if (useSession.getState().treeCollapsed) {
        noteTreeCollapsed(false);
      }
      ws.requestCreate(kind, ws.root);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Action subscriptions for the things that live in App.tsx scope.
  useEffect(() => {
    const subs: Array<() => void> = [
      // App-level "preferences" (⌘,) now opens the dedicated
      // Settings page rather than the AI panel — VS Code parity.
      // The AI panel still has its own opener (ai:show_ai / ⌘L et al).
      onAction("app:preferences", () => setShowSettings(true)),
      onAction("app:onboarding", () => setShowOnboarding(true)),
      ...POINTER_THEMES.map((theme) =>
        onAction(themeActionId(theme.id), () => {
          useSettings.getState().setAppTheme(theme.id);
          toast.info(`Theme: ${theme.label}`);
        }),
      ),
      onAction("file:new", () => beginCreateFromMenu("file")),
      onAction("file:new_folder", () => beginCreateFromMenu("folder")),
      onAction("file:open_folder", () => openFolder()),
      onAction("file:find_file", () => setShowFinder(true)),
      onAction("file:save", () => saveActive()),
      onAction("file:save_all", () => saveAll()),
      onAction("file:save_without_formatting", () =>
        useEditorStore.getState().saveActiveRaw(),
      ),
      onAction("file:revert", async () => {
        // Drop in-memory edits for the active tab and re-read from
        // disk. Mirrors VS Code's "Revert File" — destructive, so
        // we require a confirm when the buffer is dirty.
        const ed = useEditorStore.getState();
        const tab = ed.tabs.find((t) => t.path === ed.activePath);
        if (!tab) return;
        if (tab.dirty) {
          const ok = await askConfirm({
            title: `Discard changes to ${tab.name}?`,
            body: "Reload the file from disk. Unsaved edits will be lost.",
            confirmLabel: "Revert",
            danger: true,
          });
          if (!ok) return;
        }
        try {
          const fresh = await ipc.readTextFile(tab.path);
          useEditorStore.getState().discardStagedContent(tab.path);
          useEditorStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.path === tab.path
                ? { ...t, content: fresh, dirty: false, externalContent: null }
                : t,
            ),
          }));
          useSession.getState().noteHotExit(tab.path, null);
          toast.info("File reverted");
        } catch (e) {
          toast.error("Couldn't revert", {
            body: e instanceof Error ? e.message : String(e),
          });
        }
      }),
      onAction("file:close_tab", () => closeActiveTab()),
      onAction("edit:palette", () => setShowPalette(true)),
      onAction("edit:find_in_files", () => setShowFindInFiles(true)),
      onAction("ai:toggle_assistant", () => toggleDockView("assistant")),
      onAction("ai:assistant_ask", () => {
        showDockView("assistant");
        const active = useAssistant.getState().getActive();
        if (active) useAssistant.getState().setSessionMode(active.id, "ask");
      }),
      onAction("ai:assistant_plan", () => {
        showDockView("assistant");
        const active = useAssistant.getState().getActive();
        if (active) useAssistant.getState().setSessionMode(active.id, "plan");
      }),
      onAction("ai:assistant_agent", () => {
        showDockView("assistant");
        const active = useAssistant.getState().getActive();
        if (active) useAssistant.getState().setSessionMode(active.id, "agent");
      }),
      onAction("ai:show_history", () => showDockView("history")),
      onAction("ai:show_ai", () => showDockView("ai")),
      onAction("debug:show_panel", () => noteDockView("debug")),
      onAction("ai:toggle_fim", () => {
        const next = !useSettings.getState().fimEnabled;
        setFimEnabled(next);
        toast.info(`Tab completion ${next ? "enabled" : "disabled"}`);
      }),
      onAction("ai:request_fim", () => {
        if (!isFeatureUsable("fim")) {
          toast.info("Tab completion isn't ready", {
            body: featureBlockReason("fim") ?? undefined,
          });
          return;
        }
        window.dispatchEvent(new Event("pointer:request_fim"));
      }),
      onAction("ai:toggle_feature_chat", () => {
        const next = !useSettings.getState().chatEnabled;
        setChatEnabled(next);
        toast.info(`Chat ${next ? "enabled" : "disabled"}`);
      }),
      onAction("ai:toggle_feature_agent", () => {
        const next = !useSettings.getState().agentEnabled;
        setAgentEnabled(next);
        toast.info(`Agent ${next ? "enabled" : "disabled"}`);
      }),
      onAction("ai:toggle_feature_inline_edit", () => {
        const next = !useSettings.getState().inlineEditEnabled;
        setInlineEditEnabled(next);
        toast.info(`Inline edit ${next ? "enabled" : "disabled"}`);
      }),
      onAction("ai:toggle_feature_indexing", () => {
        const next = !useSettings.getState().indexingEnabled;
        setIndexingEnabled(next);
        toast.info(`Codebase indexing ${next ? "enabled" : "disabled"}`);
      }),
      onAction("ai:toggle_ollama", async () => {
        const ready = useSettings.getState().ollamaReady;
        try {
          if (ready) {
            const r = await ipc.ollamaStop();
            if (r.still_running) {
              toast.warn("Couldn't stop Ollama", {
                body:
                  "Likely a launchd / menu-bar Ollama is respawning it. Quit it from there, or use the system monitor.",
                sticky: true,
              });
            } else if (r.killed_foreign_pids.length > 0) {
              toast.success(
                `Ollama stopped (PIDs ${r.killed_foreign_pids.join(", ")})`,
              );
            } else {
              toast.success("Ollama stopped");
            }
          } else {
            await ipc.ollamaStart();
            toast.success("Ollama starting…");
          }
        } catch (e) {
          toast.error("Couldn't toggle Ollama", {
            body: e instanceof Error ? e.message : String(e),
          });
        }
      }),
      onAction("ai:index_workspace", () => {
        const r = useWorkspace.getState().root;
        if (!r) {
          toast.warn("Open a folder first", {
            body: "Indexing needs a workspace root.",
          });
          return;
        }
        // Single, consistent gate. Covers: indexing toggle, ollama running,
        // models installed, embed model picked, embed model still
        // installed. The body surfaces the precise reason.
        if (!isFeatureUsable("indexing")) {
          toast.warn("Codebase indexing isn't ready", {
            body: featureBlockReason("indexing"),
          });
          return;
        }
        const em = useSettings.getState().embedModel;
        ipc.indexWorkspace({ root: r, embed_model: em }).catch((e) =>
          toast.error("Indexing failed to start", {
            body: e instanceof Error ? e.message : String(e),
          }),
        );
        toast.info("Indexing started");
      }),
      onAction("view:toggle_tree", () =>
        noteTreeCollapsed(!useSession.getState().treeCollapsed),
      ),
      onAction("view:toggle_dock", () => {
        const cur = useSession.getState().dockView;
        noteDockView(cur === null ? "assistant" : null);
      }),
      onAction("view:toggle_terminal", () => {
        const st = useTerminals.getState();
        // Convenience: opening the panel with no terminals is jarring,
        // so we auto-spawn one as part of the toggle-open transition.
        if (!st.open && st.tabs.length === 0) {
          spawnTerminalFromShortcut().then(() => {
            useTerminals.getState().setOpen(true);
          });
        } else {
          st.toggleOpen();
        }
      }),
      onAction("view:new_terminal", () => {
        void spawnTerminalFromShortcut();
      }),
      onAction("view:toggle_problems", () => setShowProblems((v) => !v)),
      onAction("view:toggle_zen", () => {
        const cur = useSession.getState().zenMode ?? false;
        useSession.getState().noteZenMode(!cur);
      }),
      onAction("view:system_monitor", () => setShowMonitor((v) => !v)),
      onAction("help:onboarding", () => setShowOnboarding(true)),
      onAction("help:docs", () => {
        shellOpen("https://github.com").catch(() => {});
      }),
      onAction("help:shortcuts", () => setShowShortcutsHelp(true)),
      onAction("settings:open", () => setShowSettings(true)),
      onAction("settings:open_workspace", async () => {
        const root = useWorkspace.getState().root;
        if (!root) {
          toast.info("Open a folder first");
          return;
        }
        try {
          const { ensureWorkspaceSettingsFile } = await import(
            "@/lib/workspaceSettings"
          );
          const path = await ensureWorkspaceSettingsFile(root);
          await useEditorStore.getState().openFile(path);
        } catch (e) {
          toast.error("Couldn't open workspace settings", {
            body: e instanceof Error ? e.message : String(e),
          });
        }
      }),
      onAction("settings:open_snippets", async () => {
        const root = useWorkspace.getState().root;
        if (!root) {
          toast.info("Open a folder first");
          return;
        }
        try {
          const { ensureSnippetsFile } = await import("@/lib/snippets");
          const path = await ensureSnippetsFile(root);
          await useEditorStore.getState().openFile(path);
        } catch (e) {
          toast.error("Couldn't open snippets file", {
            body: e instanceof Error ? e.message : String(e),
          });
        }
      }),
      onAction("settings:keybindings", () => setShowShortcutsHelp(true)),
      onAction("tabs:reopen_closed", () => {
        useEditorStore.getState().reopenLastClosed();
      }),
      onAction("tabs:close_others", () => {
        const ed = useEditorStore.getState();
        const active = ed.activePath;
        if (!active) return;
        void closeTabsWithGuard(
          ed.tabs.filter((t) => t.path !== active).map((t) => t.path),
          active,
        );
      }),
      onAction("tabs:close_to_right", () => {
        const ed = useEditorStore.getState();
        const i = ed.tabs.findIndex((t) => t.path === ed.activePath);
        if (i < 0) return;
        void closeTabsWithGuard(
          ed.tabs.slice(i + 1).map((t) => t.path),
          ed.activePath,
        );
      }),
      onAction("tabs:close_all", () => {
        const ed = useEditorStore.getState();
        void closeTabsWithGuard(ed.tabs.map((t) => t.path));
      }),
      onAction("tabs:next", () => {
        const ed = useEditorStore.getState();
        const i = ed.tabs.findIndex((t) => t.path === ed.activePath);
        if (i < 0 || ed.tabs.length < 2) return;
        const next = ed.tabs[(i + 1) % ed.tabs.length];
        if (next) ed.setActive(next.path);
      }),
      onAction("tabs:prev", () => {
        const ed = useEditorStore.getState();
        const i = ed.tabs.findIndex((t) => t.path === ed.activePath);
        if (i < 0 || ed.tabs.length < 2) return;
        const prev = ed.tabs[(i - 1 + ed.tabs.length) % ed.tabs.length];
        if (prev) ed.setActive(prev.path);
      }),
      onAction("editor:goto_line", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.gotoLine" },
        }));
      }),
      onAction("editor:goto_definition", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.revealDefinition" },
        }));
      }),
      onAction("editor:peek_definition", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.peekDefinition" },
        }));
      }),
      onAction("editor:goto_symbol_file", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.quickOutline" },
        }));
      }),
      onAction("editor:format_document", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.formatDocument" },
        }));
      }),
      onAction("editor:format_selection", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.formatSelection" },
        }));
      }),
      onAction("editor:transpose_chars", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.transposeLetters" },
        }));
      }),
      onAction("editor:rename_symbol", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.rename" },
        }));
      }),
      onAction("editor:fold", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.fold" },
        }));
      }),
      onAction("editor:duplicate_line", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.copyLinesDownAction" },
        }));
      }),
      onAction("editor:toggle_line_comment", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.commentLine" },
        }));
      }),
      onAction("editor:toggle_block_comment", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.blockComment" },
        }));
      }),
      onAction("editor:join_lines", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.joinLines" },
        }));
      }),
      onAction("editor:sort_lines_asc", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.sortLinesAscending" },
        }));
      }),
      onAction("editor:sort_lines_desc", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.sortLinesDescending" },
        }));
      }),
      onAction("editor:trim_trailing_whitespace", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.trimTrailingWhitespace" },
        }));
      }),
      onAction("editor:upper_case", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.transformToUppercase" },
        }));
      }),
      onAction("editor:lower_case", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.transformToLowercase" },
        }));
      }),
      onAction("editor:title_case", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.action.transformToTitlecase" },
        }));
      }),
      onAction("editor:insert_uuid", () => {
        const uuid = (
          (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ??
          fallbackUuid()
        );
        window.dispatchEvent(new CustomEvent("pointer:editor_insert", {
          detail: { text: uuid },
        }));
      }),
      onAction("editor:insert_datetime", () => {
        // ISO-8601 in local time, second precision — what most
        // changelogs / commit messages want. Format chosen to be
        // unambiguous regardless of locale.
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const text = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        window.dispatchEvent(new CustomEvent("pointer:editor_insert", {
          detail: { text },
        }));
      }),
      onAction("editor:unfold", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.unfold" },
        }));
      }),
      onAction("editor:fold_all", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.foldAll" },
        }));
      }),
      onAction("editor:unfold_all", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "editor.unfoldAll" },
        }));
      }),
      onAction("editor:toggle_indent", () => {
        const s = useSettings.getState();
        s.setEditorInsertSpaces(!s.editorInsertSpaces);
        toast.info(
          `Indent: ${!s.editorInsertSpaces ? "Spaces" : "Tabs"} (${s.editorTabSize})`,
        );
      }),
      onAction("debug:toggle_breakpoint", () => {
        window.dispatchEvent(new CustomEvent("pointer:editor_command", {
          detail: { id: "pointer.toggleBreakpoint" },
        }));
      }),
      onAction("editor:change_language", () => setShowLanguagePicker(true)),
      onAction("editor:change_eol", async () => {
        // Toggle between LF and CRLF for the active buffer. We do
        // this by rewriting the in-memory content so save persists
        // the new sequence — no separate "EOL setting" to manage.
        const ed = useEditorStore.getState();
        const tab = ed.tabs.find((t) => t.path === ed.activePath);
        if (!tab) return;
        const content = ed.getContent(tab.path) ?? tab.content;
        const hasCRLF = /\r\n/.test(content);
        const target = hasCRLF ? "LF" : "CRLF";
        const ok = await askConfirm({
          title: `Switch this file to ${target}?`,
          body:
            target === "CRLF"
              ? "Replace every newline with \\r\\n. Saves immediately."
              : "Replace every \\r\\n with \\n. Saves immediately.",
          confirmLabel: target,
        });
        if (!ok) return;
        const next =
          target === "LF"
            ? content.replace(/\r\n/g, "\n")
            : content.replace(/\r?\n/g, "\r\n");
        useEditorStore.getState().updateContent(tab.path, next);
        await useEditorStore.getState().saveActive();
        toast.info(`Line endings: ${target}`);
      }),
      onAction("edit:replace_in_files", () => setShowFindInFiles(true)),
      onAction("editor:goto_symbol_workspace", () =>
        setShowWorkspaceSymbols(true),
      ),
      onAction("view:toggle_minimap", () => {
        const s = useSettings.getState();
        s.setEditorMinimap(!s.editorMinimap);
        toast.info(`Minimap ${!s.editorMinimap ? "shown" : "hidden"}`);
      }),
      onAction("view:toggle_word_wrap", () => {
        const s = useSettings.getState();
        s.setEditorWordWrap(!s.editorWordWrap);
        toast.info(`Word wrap ${!s.editorWordWrap ? "on" : "off"}`);
      }),
      onAction("view:font_zoom_in", () => {
        const s = useSettings.getState();
        s.setEditorFontSize(Math.min(32, (s.editorFontSize || 14) + 1));
      }),
      onAction("view:font_zoom_out", () => {
        const s = useSettings.getState();
        s.setEditorFontSize(Math.max(8, (s.editorFontSize || 14) - 1));
      }),
      onAction("view:font_zoom_reset", () => {
        useSettings.getState().setEditorFontSize(14);
      }),
      onAction("view:reveal_in_tree", () => {
        const active = useEditorStore.getState().activePath;
        if (!active) {
          toast.info("No active file to reveal.");
          return;
        }
        window.dispatchEvent(
          new CustomEvent("pointer:reveal_in_tree", { detail: { path: active } }),
        );
      }),
      onAction("tree:focus_filter", () => {
        window.dispatchEvent(new CustomEvent("pointer:focus_tree_filter"));
      }),
      onAction("tree:collapse_all", () => {
        window.dispatchEvent(new CustomEvent("pointer:collapse_tree"));
      }),
      onAction("git:show_panel", () => noteDockView("scm")),
      onAction("git:fetch", () => {
        const r = useWorkspace.getState().root;
        if (!r) {
          toast.warn("Open a folder first");
          return;
        }
        noteDockView("scm");
        const toastId = toast.info("Fetching from remote", {
          body: "Pointer is running git fetch.",
          sticky: true,
        });
        ipc.gitFetch(r).then(
          (out) => {
            toast.dismiss(toastId);
            void useGit.getState().refresh();
            toast.success("Fetched", { body: out.trim() || undefined });
          },
          (e) => {
            toast.dismiss(toastId);
            toast.error("Fetch failed", { body: String(e) });
          },
        );
      }),
      onAction("git:pull", () => {
        const r = useWorkspace.getState().root;
        if (!r) {
          toast.warn("Open a folder first");
          return;
        }
        noteDockView("scm");
        const toastId = toast.info("Pulling from remote", {
          body: "Pointer is running git pull --ff-only.",
          sticky: true,
        });
        ipc.gitPull(r).then(
          (out) => {
            toast.dismiss(toastId);
            void useGit.getState().refresh();
            toast.success("Pulled", { body: out.trim() || undefined });
          },
          (e) => {
            toast.dismiss(toastId);
            toast.error("Pull failed", { body: String(e) });
          },
        );
      }),
      onAction("git:push", () => {
        const r = useWorkspace.getState().root;
        if (!r) {
          toast.warn("Open a folder first");
          return;
        }
        noteDockView("scm");
        const toastId = toast.info("Pushing to remote", {
          body: "Pointer is running git push. Authentication prompts will open in Pointer.",
          sticky: true,
        });
        ipc.gitPush(r).then(
          (out) => {
            toast.dismiss(toastId);
            void useGit.getState().refresh();
            toast.success("Pushed", { body: out.trim() || undefined });
          },
          (e) => {
            toast.dismiss(toastId);
            toast.error("Push failed", { body: String(e) });
          },
        );
      }),
      onAction("file:open_recent", () => setShowOpenRecent(true)),
      onAction("file:new_untitled", () => {
        void useEditorStore.getState().openUntitled();
      }),
      onAction("help:notifications", () => setShowNotifications(true)),
      onAction("tasks:run", () => setShowTasks(true)),
      onAction("bookmark:toggle", async () => {
        const ed = useEditorStore.getState();
        const path = ed.activePath;
        if (!path) return;
        const line = ed.cursor?.line ?? 1;
        const tab = ed.tabs.find((t) => t.path === path);
        const preview = tab
          ? (ed.getContent(tab.path) ?? tab.content).split("\n")[line - 1]?.trim().slice(0, 120) ?? ""
          : "";
        const { useBookmarks } = await import("@/store/bookmarks");
        const present = useBookmarks
          .getState()
          .toggle({ path, line, preview, ts: Date.now() });
        toast.info(present ? `Bookmark added · line ${line}` : "Bookmark removed");
      }),
      onAction("bookmark:next", async () => {
        const ed = useEditorStore.getState();
        const path = ed.activePath;
        if (!path) return;
        const { useBookmarks } = await import("@/store/bookmarks");
        const marks = useBookmarks.getState().forFile(path);
        if (marks.length === 0) return;
        const cur = ed.cursor?.line ?? 1;
        const next = marks.find((m) => m.line > cur) ?? marks[0];
        ed.revealAt(path, next.line, 1);
      }),
      onAction("bookmark:prev", async () => {
        const ed = useEditorStore.getState();
        const path = ed.activePath;
        if (!path) return;
        const { useBookmarks } = await import("@/store/bookmarks");
        const marks = useBookmarks.getState().forFile(path);
        if (marks.length === 0) return;
        const cur = ed.cursor?.line ?? 1;
        const prev = [...marks].reverse().find((m) => m.line < cur) ??
          marks[marks.length - 1];
        ed.revealAt(path, prev.line, 1);
      }),
      onAction("bookmark:list", () => setShowBookmarks(true)),
      onAction("bookmark:clear_file", async () => {
        const path = useEditorStore.getState().activePath;
        if (!path) return;
        const { useBookmarks } = await import("@/store/bookmarks");
        useBookmarks.getState().clearFile(path);
        toast.info("Bookmarks cleared for this file");
      }),
      onAction("bookmark:clear_all", async () => {
        const { useBookmarks } = await import("@/store/bookmarks");
        useBookmarks.getState().clearAll();
        toast.info("All bookmarks cleared");
      }),
      onAction("tasks:edit", async () => {
        const root = useWorkspace.getState().root;
        if (!root) {
          toast.error("Open a folder first");
          return;
        }
        try {
          const { ensureWorkspaceTasksFile } = await import("@/lib/tasks");
          const file = await ensureWorkspaceTasksFile(root);
          await useEditorStore.getState().openFile(file);
        } catch (e) {
          toast.error("Couldn't open tasks.json", {
            body: e instanceof Error ? e.message : String(e),
          });
        }
      }),
      onAction("help:about", () => {
        toast.info("Pointer", { body: "An AI-first code editor — local models, zero cloud." });
      }),
      onAction("editor:next_problem", () => navigateProblem("next")),
      onAction("editor:prev_problem", () => navigateProblem("prev")),
      onAction("diagnostics:run_project_check", () => {
        setShowProblems(true);
        void useDiagnostics.getState().runProjectCheck();
      }),
      onAction("editor:nav_back", async () => {
        const { useNavHistory } = await import("@/store/navHistory");
        const entry = useNavHistory.getState().back();
        if (entry) {
          // Note: don't go through revealAt — that would push a *new*
          // history entry, defeating the back walk. Open + reveal
          // directly via the same pendingReveal channel.
          await useEditorStore.getState().openFile(entry.path);
          useEditorStore.setState({
            pendingReveal: {
              path: entry.path,
              line: entry.line,
              column: entry.column,
              nonce: Date.now(),
            },
          });
        }
      }),
      onAction("editor:nav_forward", async () => {
        const { useNavHistory } = await import("@/store/navHistory");
        const entry = useNavHistory.getState().forward();
        if (entry) {
          await useEditorStore.getState().openFile(entry.path);
          useEditorStore.setState({
            pendingReveal: {
              path: entry.path,
              line: entry.line,
              column: entry.column,
              nonce: Date.now(),
            },
          });
        }
      }),
      onAction("md:toggle_preview", () => {
        const active = useEditorStore.getState().activePath;
        if (!active || !/\.(md|markdown|mdx)$/i.test(active)) {
          toast.info("Open a Markdown file first");
          return;
        }
        setMdPreview((prev) => {
          const cur = prev[active] ?? null;
          return { ...prev, [active]: cur === "preview" ? null : "preview" };
        });
      }),
      onAction("md:open_preview_side", () => {
        const active = useEditorStore.getState().activePath;
        if (!active || !/\.(md|markdown|mdx)$/i.test(active)) {
          toast.info("Open a Markdown file first");
          return;
        }
        setMdPreview((prev) => ({ ...prev, [active]: "split" }));
      }),
    ];
    return () => {
      for (const u of subs) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = settingsHydrated && sessionHydrated;

  return (
    <div className="pn-app-shell h-screen w-screen flex flex-col bg-noir-canvas text-noir-text overflow-hidden">
      {!zenMode && <Titlebar onOpenAIPanel={() => noteDockView("ai")} />}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {!treeCollapsed && !zenMode && (
          <aside
            className="shrink-0 min-h-0 overflow-hidden relative border-r border-noir-line/50 bg-noir-panel flex flex-col shadow-[1px_0_0_rgba(0,0,0,0.28)]"
            style={{ width: fileTreeWidth ?? 256 }}
          >
            {/* Sidebar view selector — Files vs Outline. Lightweight
                tab strip; clicking switches the pane in-place. */}
            <div className="flex shrink-0 gap-1 border-b border-noir-line/60 bg-noir-canvas/25 p-1 text-[10px] uppercase tracking-wider">
              <button
                onClick={() => setSidebarView("files")}
                className={`flex-1 h-7 rounded-md transition-colors ${
                  sidebarView === "files"
                    ? "text-noir-text bg-noir-ridge/80 ring-1 ring-noir-accent/15"
                    : "text-noir-mute hover:text-noir-text hover:bg-noir-ridge/40"
                }`}
              >
                Files
              </button>
              <button
                onClick={() => setSidebarView("outline")}
                className={`flex-1 h-7 rounded-md transition-colors ${
                  sidebarView === "outline"
                    ? "text-noir-text bg-noir-ridge/80 ring-1 ring-noir-accent/15"
                    : "text-noir-mute hover:text-noir-text hover:bg-noir-ridge/40"
                }`}
              >
                Outline
              </button>
            </div>
            {sidebarView === "files" ? <FileTree /> : <Outline />}
            {/* Drag handle for the file tree. Lives on the RIGHT
                edge so users can grab it without overshooting into
                the editor. Min 160px so the tree never collapses to
                nothing; max 600px so it can't eat the editor. */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = fileTreeWidth ?? 256;
                const note = useSession.getState().noteFileTreeWidth;
                const move = (ev: MouseEvent) => {
                  const next = Math.max(160, Math.min(600, startW + (ev.clientX - startX)));
                  note(next);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }}
              onDoubleClick={() => useSession.getState().noteFileTreeWidth(256)}
              className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-noir-accent/40 z-pn-dock-handle"
              title="Drag to resize · double-click to reset"
            />
          </aside>
        )}
        <main className="flex-1 min-w-0 flex flex-col bg-noir-canvas">
          {!zenMode && <Tabs />}
          {!zenMode && <Breadcrumbs />}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 relative bg-noir-canvas">
              {root ? (
                <EditorSurface activeTab={activeEditorTab} />
              ) : (
                <Welcome
                  ready={ready}
                  onOpen={openFolder}
                  recents={recents}
                  onOpenRecent={(p) => {
                    void switchWorkspaceRoot(p);
                  }}
                  onRemoveRecent={removeRecent}
                  onShowAIPanel={() => noteDockView("ai")}
                />
              )}
              {diffSpec && (
                <Suspense fallback={null}>
                  <DiffView />
                </Suspense>
              )}
              <ActiveMarkdownPreview state={mdPreview} setState={setMdPreview} />
            </div>
            {showProblems && (
              <Suspense fallback={null}>
                <ProblemsPanel onClose={() => setShowProblems(false)} />
              </Suspense>
            )}
            {!zenMode && terminalOpen && (
              <Suspense fallback={null}>
                <TerminalPanel />
              </Suspense>
            )}
          </div>
        </main>
        {!zenMode && <RightDock />}
      </div>
      {!zenMode && <StatusBar onOpenMonitor={() => setShowMonitor(true)} />}
      {zenMode && (
        <button
          onClick={() => useSession.getState().noteZenMode(false)}
          className="fixed top-2 right-2 z-pn-toast text-[10px] uppercase tracking-wider text-noir-mute hover:text-noir-text bg-noir-panel/60 border border-noir-line/40 rounded px-2 py-1"
          title="Exit Zen Mode (⌘K Z)"
        >
          Exit Zen
        </button>
      )}

      {showPalette && (
        <Suspense fallback={null}>
          <CommandPalette
            onClose={() => setShowPalette(false)}
            openFinder={() => {
              setShowPalette(false);
              setShowFinder(true);
            }}
            toggleAssistant={() => toggleDockView("assistant")}
            openOnboarding={() => setShowOnboarding(true)}
            openAIPanel={() => noteDockView("ai")}
            openMonitor={() => setShowMonitor(true)}
          />
        </Suspense>
      )}
      {showFinder && (
        <Suspense fallback={null}>
          <FileFinder onClose={() => setShowFinder(false)} />
        </Suspense>
      )}
      {showFindInFiles && (
        <Suspense fallback={null}>
          <FindInFiles onClose={() => setShowFindInFiles(false)} />
        </Suspense>
      )}
      {showMonitor && (
        <Suspense fallback={<OverlayLoading label="Opening monitor" />}>
          <SystemMonitor onClose={() => setShowMonitor(false)} />
        </Suspense>
      )}
      {showShortcutsHelp && (
        <Suspense fallback={null}>
          <ShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />
        </Suspense>
      )}
      {showSettings && (
        <Suspense fallback={<OverlayLoading label="Opening settings" />}>
          <SettingsPage onClose={() => setShowSettings(false)} />
        </Suspense>
      )}
      {showOpenRecent && (
        <Suspense fallback={<OverlayLoading label="Opening recent workspaces" />}>
          <OpenRecentPicker
            onClose={() => setShowOpenRecent(false)}
            onOpenRecent={switchWorkspaceRoot}
          />
        </Suspense>
      )}
      {showWorkspaceSymbols && (
        <Suspense fallback={null}>
          <WorkspaceSymbols onClose={() => setShowWorkspaceSymbols(false)} />
        </Suspense>
      )}
      {showNotifications && (
        <Suspense fallback={null}>
          <NotificationCenter onClose={() => setShowNotifications(false)} />
        </Suspense>
      )}
      {showTasks && (
        <Suspense fallback={null}>
          <TasksPicker onClose={() => setShowTasks(false)} />
        </Suspense>
      )}
      {showBookmarks && (
        <Suspense fallback={null}>
          <BookmarksPicker onClose={() => setShowBookmarks(false)} />
        </Suspense>
      )}
      {showLanguagePicker && (
        <Suspense fallback={null}>
          <LanguagePicker onClose={() => setShowLanguagePicker(false)} />
        </Suspense>
      )}
      {/* The wizard renders whenever `showOnboarding` is true. We don't
          gate on `!onboarded` here — that gate already lives in the boot
          effect (which decides whether to auto-show the wizard on launch).
          Adding it here would silently break the menu items "Setup /
          Onboarding…" and "Re-run Setup", which are exactly the entry
          points an already-onboarded user reaches for. */}
      {showOnboarding && (
        <Suspense fallback={<OverlayLoading label="Opening setup" />}>
          <Onboarding
            onDone={() => {
              markOnboarded();
              setShowOnboarding(false);
            }}
          />
        </Suspense>
      )}
      <ConfirmModalHost />
      <SecretPromptHost />
      <LspIdleManager />
      <ToastHost />
      <RefactorSuggestion />
    </div>
  );
}

function EditorSurface({ activeTab }: { activeTab: Tab | null }) {
  if (!activeTab) return <NoFileOpen />;
  if (activeTab.preview === "image") {
    return (
      <Suspense fallback={<EditorLoading label="Opening image" />}>
        <ImagePreview path={activeTab.path} />
      </Suspense>
    );
  }
  if (activeTab.preview === "binary") {
    return (
      <Suspense fallback={<EditorLoading label="Opening file" />}>
        <BinaryPreview path={activeTab.path} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<EditorLoading label="Opening editor" />}>
      <Editor />
    </Suspense>
  );
}

function NoFileOpen() {
  return (
    <div className="h-full w-full flex items-center justify-center font-sans">
      <div className="text-center max-w-sm px-6">
        <div className="mb-3 flex justify-center">
          <PointerMarkSvg
            decorative
            className="pn-brand-mark h-7 w-7 text-noir-accent opacity-90"
          />
        </div>
        <div className="text-[13px] text-noir-text mb-2">No file open</div>
        <div className="text-[11.5px] text-noir-mute leading-relaxed space-y-1">
          <div>
            Pick a file from the tree, or press <span className="pn-kbd">⌘P</span>{" "}
            to fuzzy-find.
          </div>
          <div>
            Ask the chat with <span className="pn-kbd">⌘L</span>, run the agent,
            or open AI settings with <span className="pn-kbd">⌘⇧,</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

function EditorLoading({ label }: { label: string }) {
  return (
    <div className="h-full w-full grid place-items-center bg-noir-canvas font-sans text-[11.5px] text-noir-mute">
      {label}…
    </div>
  );
}

function Welcome({
  ready,
  onOpen,
  recents,
  onOpenRecent,
  onRemoveRecent,
  onShowAIPanel,
}: {
  ready: boolean;
  onOpen: () => void;
  recents: string[];
  onOpenRecent: (p: string) => void;
  onRemoveRecent: (p: string) => void;
  onShowAIPanel: () => void;
}) {
  const ollamaReady = useSettings((s) => s.ollamaReady);
  // The "Models" chip on the welcome screen used to light up the moment
  // the user had ever picked a chat model — even if they later uninstalled
  // it. That was misleading: the chip claimed setup was done while the
  // configured model was gone. We now consult the effective slot, which
  // returns "" when the configured model isn't installed (or Ollama is
  // offline), so the chip honestly reflects whether chat is wired up.
  const effectiveChat = useSettings((s) => effectiveAssignedModel("chat", s));
  const onboarded = useSettings((s) => s.onboarded);

  const setupComplete = ollamaReady && !!effectiveChat;

  return (
    <main
      className="pn-welcome-surface h-full w-full overflow-hidden relative"
      aria-label="Welcome screen"
    >
      <div className="relative z-10 flex h-full items-center justify-center px-6 py-8">
        <div className="pn-welcome-grid w-full max-w-5xl gap-6 items-center">
          <section className="min-w-0 text-center xl:text-left">
            <PointerWordmarkSvg
              title="Pointer"
              className="pn-brand-logo mx-auto mb-5 h-auto w-[min(430px,100%)] select-none xl:mx-0"
            />
            <h1 className="sr-only">Pointer</h1>
            <p className="mx-auto mb-7 max-w-xl font-sans text-[13px] leading-6 text-noir-subtext xl:mx-0">
              A local-first IDE for moving quickly through real code with your editor, terminal, and AI assistant in one workspace.
            </p>

            <div className="flex flex-wrap justify-center gap-2 font-sans xl:justify-start">
              <button
                onClick={onOpen}
                className="pn-button-accent flex items-center gap-1.5"
                aria-label="Open folder (Command O)"
              >
                <Folder size={11} aria-hidden="true" /> Open Folder
                <kbd className="opacity-70 ml-1.5">⌘O</kbd>
              </button>
              <button
                onClick={onShowAIPanel}
                className="pn-button flex items-center gap-1.5"
                aria-label="Open AI setup (Command Shift Comma)"
              >
                <Sparkles size={11} aria-hidden="true" /> AI Setup
                <kbd className="opacity-70 ml-1.5">⌘⇧,</kbd>
              </button>
            </div>
          </section>

          <section className="pn-premium-panel mx-auto w-full max-w-[380px] rounded-lg p-4 font-sans">
            {ready && onboarded && (
              <button
                onClick={onShowAIPanel}
                className="pn-soft-panel w-full rounded-md border p-3 text-left transition-colors hover:border-noir-accent/40"
                title="Open AI Control Panel"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-wider text-noir-mute">
                    Setup status
                  </div>
                  <div
                    className={`text-[10px] ${setupComplete ? "text-noir-ok" : "text-noir-warn"}`}
                  >
                    {setupComplete ? "Ready" : "Action needed"}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <SetupChip on={ollamaReady} label="Ollama" />
                  <SetupChip on={!!effectiveChat} label="Models" />
                </div>
              </button>
            )}

            {ready && recents.length > 0 && (
              <section
                className={ready && onboarded ? "mt-4 text-left" : "text-left"}
                aria-labelledby="welcome-recents-heading"
              >
                <h2
                  id="welcome-recents-heading"
                  className="mb-2 flex items-center gap-1.5 font-sans text-[10px] font-normal uppercase tracking-wider text-noir-mute"
                >
                  <Clock size={10} aria-hidden="true" /> Recent
                </h2>
                <ul className="divide-y divide-noir-line/40 overflow-hidden rounded-md border border-noir-line/80 bg-noir-canvas/40">
                  {recents.map((p) => {
                    const name = p.split(/[\\/]/).pop() ?? p;
                    const parent = p.slice(0, p.length - name.length).replace(/\/+$/, "");
                    return (
                      <li
                        key={p}
                        className="group flex items-center justify-between transition-colors hover:bg-noir-ridge/40"
                      >
                        <button
                          onClick={() => onOpenRecent(p)}
                          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                          title={p}
                          aria-label={`Open ${name} at ${parent}`}
                        >
                          <Folder
                            size={11}
                            aria-hidden="true"
                            className="shrink-0 text-noir-subtext"
                          />
                          <div className="min-w-0">
                            <div className="truncate font-sans text-[12px] text-noir-text">
                              {name}
                            </div>
                            <div className="truncate font-mono text-[10.5px] text-noir-mute">
                              {parent}
                            </div>
                          </div>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveRecent(p);
                          }}
                          className="p-2 text-noir-mute opacity-0 transition-opacity hover:text-noir-err group-hover:opacity-100"
                          title="Remove from recents"
                          aria-label={`Remove ${name} from recents`}
                        >
                          <X size={11} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function OverlayLoading({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-pn-modal flex items-center justify-center bg-black/55">
      <div className="rounded-md border border-noir-line bg-noir-panel px-3 py-2 text-[11px] font-sans text-noir-subtext shadow-soft">
        {label}…
      </div>
    </div>
  );
}

function SetupChip({
  on,
  label,
  optional,
}: {
  on: boolean;
  label: string;
  optional?: boolean;
}) {
  return (
    <div
      className={`rounded-md border px-2 py-1.5 flex items-center justify-between gap-2 ${
        on
          ? "border-noir-ok/30 bg-noir-ok/5"
          : optional
          ? "border-noir-line bg-noir-canvas/40"
          : "border-noir-warn/30 bg-noir-warn/5"
      }`}
    >
      <span className="text-noir-text">{label}</span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          on ? "bg-noir-ok" : optional ? "bg-noir-mute" : "bg-noir-warn"
        }`}
      />
    </div>
  );
}

/** Wraps MarkdownView so it only mounts when the *active* tab is
 *  a Markdown file in preview mode. Keying off `mdPreview[active]`
 *  lets every md file remember its own mode independently. */
function ActiveMarkdownPreview({
  state,
  setState,
}: {
  state: Record<string, "preview" | "split" | null>;
  setState: React.Dispatch<
    React.SetStateAction<Record<string, "preview" | "split" | null>>
  >;
}) {
  const active = useEditorStore((s) => s.activePath);
  if (!active) return null;
  if (!/\.(md|markdown|mdx)$/i.test(active)) return null;
  const mode = state[active] ?? null;
  if (!mode) return null;
  const close = () => setState((p) => ({ ...p, [active]: null }));
  const set = (m: "preview" | "split" | null) =>
    setState((p) => ({ ...p, [active]: m }));
  return (
    <Suspense fallback={null}>
      <MarkdownView
        path={active}
        mode={mode}
        onSetMode={set}
        onClose={close}
      />
    </Suspense>
  );
}
