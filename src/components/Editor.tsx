import MonacoEditor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor, languages } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { POINTER_NOIR_ID, pointerNoirTheme } from "@/theme/pointer-noir";
import { setupMonaco } from "@/lib/setupMonaco";
import { installEditorE2EHooks } from "@/lib/e2eHooks";
import { useDiagnostics } from "@/store/diagnostics";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import { useInlineBlame } from "@/lib/inlineBlame";
import { useBookmarkDecorations } from "@/lib/bookmarkDecorations";
import { useBreakpointDecorations } from "@/lib/breakpointDecorations";
import { registerColorProviders } from "@/lib/colorProvider";
import { useSession } from "@/store/session";
import { useSettings, isFeatureUsable } from "@/store/settings";
import { useDebuggerStore } from "@/store/debugger";
import {
  ipc,
  listenEvent,
  newRequestId,
  type LspCompletionItem,
  type LspDiagnosticEvent,
  type LspLocation,
  type LspRange,
} from "@/lib/ipc";
import { onAction } from "@/lib/actions";
import { toast } from "@/components/Toast";
import { InlineEdit } from "@/components/InlineEdit";
import { DiffOverlay } from "@/components/DiffOverlay";
import { ImagePreview, BinaryPreview } from "@/components/Preview";
import {
  sendBreakpointToAI,
  sendDiagnosticToAI,
  sendSelectionToAI,
  type AiTarget,
} from "@/lib/sendToAI";
import { useAssistant } from "@/store/assistant";
import { useRecentEdits } from "@/store/recentEdits";
import { aiStageDecorationsFor } from "@/lib/aiStageDecorations";
import { buildFimContext } from "@/lib/fimContext";
import { FimRequestCoordinator } from "@/lib/fimRequestCoordinator";
import {
  extractPathTarget,
  resolvePathTarget,
  type PathTarget,
} from "@/lib/fileNavigation";
import {
  definitionSearchPatterns,
  findLocalDefinitions,
  symbolAtPosition,
} from "@/lib/symbolNavigation";
import {
  vueCompletionSymbolsForPosition,
  type VueSymbolKind,
} from "@/lib/vueIntelligence";
import { pathFromMonacoUri } from "@/lib/monacoUri";

type PointerLspCompletion = languages.CompletionItem & {
  __pointerLsp?: {
    path: string;
    language: string;
    content: string;
    item: LspCompletionItem;
  };
};

export function Editor() {
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Mirror of `editorRef.current` exposed as React state so hooks
  // that need to react to the editor's mount lifecycle (inline
  // blame, decorations) can re-run when it changes.
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  const activePath = useEditorStore((s) => s.activePath);
  const tabs = useEditorStore((s) => s.tabs);
  const updateContent = useEditorStore((s) => s.updateContent);
  const setSelection = useEditorStore((s) => s.setSelection);
  const fimModel = useSettings((s) => s.fimModel);
  const fimEnabled = useSettings((s) => s.fimEnabled);
  const fimDebounceMs = useSettings((s) => s.fimDebounceMs);
  const editorFontSize = useSettings((s) => s.editorFontSize);
  const editorTabSize = useSettings((s) => s.editorTabSize);
  const editorInsertSpaces = useSettings((s) => s.editorInsertSpaces);
  const editorWordWrap = useSettings((s) => s.editorWordWrap);
  const editorRenderWhitespace = useSettings((s) => s.editorRenderWhitespace);
  const editorMinimap = useSettings((s) => s.editorMinimap);
  const editorStickyScroll = useSettings((s) => s.editorStickyScroll);
  const [inlineEdit, setInlineEdit] = useState<null | {
    selection: { startLine: number; endLine: number; text: string };
    position: { top: number; left: number };
  }>(null);
  const [pendingDiff, setPendingDiff] = useState<null | {
    original: string;
    proposed: string;
    description?: string;
    stats?: { validated: boolean; elapsedMs: number; charsPerSec: number };
  }>(null);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;

  /** Open the inline-edit prompt over the editor's current selection. Reused
   *  by the Monaco Cmd+K command *and* by the AI → Inline Edit Selection
   *  menu / action bus subscription, so the behaviour is identical no
   *  matter where the user triggers it from. */
  const triggerInlineEdit = useCallback(() => {
    if (!isFeatureUsable("inlineEdit")) {
      const reason =
        useSettings
          .getState()
          // Surface the precise blocker (missing model / no runtime / etc.)
          // so the user knows what to fix, not just "it's off".
          .installedModels;
      const explanation = (() => {
        const s = useSettings.getState();
        if (!s.inlineEditEnabled)
          return "Turn it back on in AI Control Panel → AI features.";
        if (!s.ollamaReady) return "Start Ollama first (AI Control Panel).";
        if (reason.length === 0)
          return "Install at least one model from the AI Control Panel.";
        if (!s.chatModel)
          return "Pick a chat model first — inline edit uses the same model.";
        if (!reason.includes(s.chatModel))
          return `Configured chat model isn't installed: ${s.chatModel}.`;
        return "Inline edit unavailable.";
      })();
      toast.warn("Inline edit isn't ready", { body: explanation });
      return;
    }
    const ed = editorRef.current;
    if (!ed) {
      toast.warn("Open a file first", {
        body: "Inline edit needs a focused editor with a selection.",
      });
      return;
    }
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (!sel || !model || sel.isEmpty()) {
      toast.info("Select some code first", {
        body: "Highlight the lines you want Pointer to edit, then try again.",
      });
      return;
    }
    const text = model.getValueInRange(sel);
    const pos = ed.getScrolledVisiblePosition({
      lineNumber: sel.startLineNumber,
      column: sel.startColumn,
    });
    const dom = ed.getDomNode();
    const rect = dom?.getBoundingClientRect();
    setInlineEdit({
      selection: {
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        text,
      },
      position: {
        top: (rect?.top ?? 0) + (pos?.top ?? 0) + 24,
        left: (rect?.left ?? 0) + (pos?.left ?? 0),
      },
    });
  }, []);

  // Bridge: the menu emits `ai:inline_edit` from outside Monaco's command
  // scope. Subscribing here keeps menu / palette / keyboard all on one path.
  useEffect(() => {
    return onAction("ai:inline_edit", () => triggerInlineEdit());
  }, [triggerInlineEdit]);

  // ────────────────────────────────────────────────────────────────────
  // AI-staged ref decorations. Watches the unified Assistant's pending
  // refs and redraws whenever the active Assistant mode changes, the
  // editor's active path changes, or the editor instance itself is
  // replaced. Decoration IDs are tracked in a ref so we can call
  // `deltaDecorations(prev, next)` cleanly.
  // ────────────────────────────────────────────────────────────────────
  const assistantPendingRefs = useAssistant((s) => s.pendingRefs);
  const assistantMode = useAssistant(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.mode ?? "ask",
  );
  const stagedDecos = useMemo(() => {
    const surface = assistantMode === "ask" ? "chat" : "agent";
    return aiStageDecorationsFor(assistantPendingRefs, surface, activePath);
  }, [assistantPendingRefs, assistantMode, activePath]);
  const decoIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    decoIdsRef.current = ed.deltaDecorations(
      decoIdsRef.current,
      // The aiStageDecorations module is intentionally Monaco-free
      // for unit-test reasons; Monaco's deltaDecorations is shape-
      // compatible with our descriptors so the cast is safe.
      stagedDecos as unknown as editor.IModelDeltaDecoration[],
    );
  }, [stagedDecos]);
  // Drop decorations when the file changes — Monaco's per-model
  // bookkeeping does this for us, but we also clear our ID list so
  // the next deltaDecorations call doesn't try to update IDs that
  // belong to an unmounted model.
  useEffect(() => {
    decoIdsRef.current = [];
  }, [activePath]);

  // Reveal pump: external callers (Problems panel, find-in-files, future
  // go-to-definition) set `pendingReveal` to ask us to scroll + focus a
  // particular line. We watch for that and clear it after applying so
  // identical requests can fire again via the bumped nonce.
  const pendingReveal = useEditorStore((s) => s.pendingReveal);
  const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal);
  useEffect(() => {
    if (!pendingReveal) return;
    if (!activeTab || activeTab.path !== pendingReveal.path) return;
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.revealLineInCenter(pendingReveal.line);
      ed.setPosition({
        lineNumber: pendingReveal.line,
        column: pendingReveal.column,
      });
      ed.focus();
    } catch {
      /* model not ready yet — caller bumps nonce on next attempt */
    }
    clearPendingReveal();
  }, [pendingReveal, activeTab, clearPendingReveal]);

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    setEditorInstance(ed);
    ed.onDidDispose(() => {
      // Match the ref's lifecycle so hooks subscribed to the
      // instance don't keep a stale handle after the editor goes
      // away (HMR, route changes).
      setEditorInstance((cur) => (cur === ed ? null : cur));
    });
    monacoRef.current = monaco;
    monaco.editor.defineTheme(POINTER_NOIR_ID, pointerNoirTheme);
    monaco.editor.setTheme(POINTER_NOIR_ID);
    // Color decorators + inline picker for CSS / JSON / HTML etc.
    // Idempotent: a no-op on subsequent editor mounts.
    registerColorProviders(monaco);

    // Register MDX + extra file extensions, configure TS/JSX compiler
    // defaults, and wire JSON schema-store validation. Idempotent — safe
    // to call on every mount.
    setupMonaco(monaco);
    installEditorE2EHooks(ed, monaco);

    // Subscribe the diagnostics store to Monaco's global marker stream.
    // Also idempotent — guarded by an internal flag in the store.
    useDiagnostics.getState().installFromMonaco(monaco);
    registerLspDiagnostics(monaco);

    // Cmd+K inside Monaco. Re-reads the gate via triggerInlineEdit so
    // toggling the feature in the AI panel takes effect immediately.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      triggerInlineEdit();
    });

    // ────────────────────────────────────────────────────────────────
    // "Send to AI" editor actions — show up in the right-click context
    // menu *and* the command palette (⇧⌘P). We register the same four
    // actions for selection vs diagnostic, chat vs agent, and let the
    // user pick from there. Each action is gated on the corresponding
    // feature being usable, so a missing model surfaces as a greyed-out
    // entry rather than a silent no-op.
    // ────────────────────────────────────────────────────────────────
    const aiActions: {
      id: string;
      label: string;
      target: AiTarget;
      run: () => void;
    }[] = [
      {
        id: "pointer.sendSelectionToChat",
        label: "Pointer: Send selection to Ask",
        target: "ask",
        run: () => sendSelectionFromEditor(ed, "ask"),
      },
      {
        id: "pointer.sendSelectionToAgent",
        label: "Pointer: Send selection to agent",
        target: "agent",
        run: () => sendSelectionFromEditor(ed, "agent"),
      },
    ];
    for (const a of aiActions) {
      ed.addAction({
        id: a.id,
        label: a.label,
        contextMenuGroupId: "1_pointer",
        contextMenuOrder: 1.5,
        // Only show the action when there's a selection — empty
        // selection commands would silently no-op.
        precondition: "editorHasSelection",
        run: a.run,
      });
    }
    ed.addAction({
      id: "pointer.toggleBreakpoint",
      label: "Pointer: Toggle breakpoint",
      contextMenuGroupId: "1_pointer",
      contextMenuOrder: 1.1,
      run: () => {
        toggleBreakpointAtCursor(ed);
      },
    });
    for (const target of ["ask", "plan", "agent"] as const) {
      ed.addAction({
        id: `pointer.sendBreakpointTo${target[0].toUpperCase()}${target.slice(1)}`,
        label: `Pointer: Send breakpoint to ${target === "ask" ? "Ask" : target}`,
        contextMenuGroupId: "1_pointer",
        contextMenuOrder: 1.7,
        run: () => sendCurrentBreakpointFromEditor(ed, target),
      });
    }
    // Cmd+L sends the selection straight to Ask (Cursor-parity
    // shortcut). Cmd+Shift+L sends it to the agent.
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL,
      () => sendSelectionFromEditor(ed, "ask"),
    );
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL,
      () => sendSelectionFromEditor(ed, "agent"),
    );
    ed.addCommand(monaco.KeyCode.F9, () => {
      toggleBreakpointAtCursor(ed);
    });

    // Global Monaco registrations — code-action provider, code lens,
    // marker-routing commands — only need to happen once. The Editor
    // can remount (all tabs closed then a fresh open) and
    // `monaco.languages.register…` accumulates providers across calls,
    // so a guard saves us from running every diagnostic through
    // 2× / 3× / N× providers. The provider bodies read live state
    // through store getters so they stay accurate on remount.
    registerGlobalAiProviders(monaco);

    // Workspace snippets. Loaded once on first mount; re-loaded
    // when the workspace root changes (handled below via effect).
    void import("@/lib/snippets").then(async ({ loadSnippets }) => {
      const root = useWorkspace.getState().root;
      await loadSnippets(root, monaco);
    });

    // Track selection for chat references.
    ed.onDidChangeCursorSelection((e) => {
      const model = ed.getModel();
      if (!model) return setSelection(null);
      const sel = e.selection;
      if (sel.isEmpty()) return setSelection(null);
      setSelection({
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        text: model.getValueInRange(sel),
      });
    });

    // Track cursor position for the StatusBar "Ln 12, Col 4" readout.
    // Updates only when the *primary* cursor moves so multi-cursor
    // sessions show the leader rather than flickering between heads.
    const setCursor = useEditorStore.getState().setCursor;
    setCursor({
      line: ed.getPosition()?.lineNumber ?? 1,
      column: ed.getPosition()?.column ?? 1,
    });
    ed.onDidChangeCursorPosition((e) => {
      setCursor({ line: e.position.lineNumber, column: e.position.column });
    });

    // Pointer-grade file navigation: Monaco can handle rich definitions
    // for TS/JS open models, but developers also expect Cmd/Ctrl-click
    // on import strings, markdown links, and stack-trace paths to open
    // files in the workbench. This small language-agnostic layer fills
    // that gap across frameworks without needing a full LSP for each one.
    ed.onMouseDown((mouseEvent) => {
      if (toggleBreakpointFromGutter(ed, monaco, mouseEvent)) return;
      void openFileTargetUnderPointer(ed, mouseEvent);
    });

    // Bridge: outside-the-editor surfaces (palette, status bar, menu)
    // dispatch `pointer:editor_command` with a Monaco action id. We
    // run the action against the currently focused editor. This is
    // how Goto Line, Format Document, Rename Symbol, and the like get
    // wired without re-implementing Monaco's command catalog.
    const onExternalCommand = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      const id = ce.detail?.id;
      if (!id) return;
      ed.focus();
      // Monaco's typings expose `getAction(id).run()`; missing actions
      // resolve to null and we toast a friendly error.
      const action = ed.getAction(id);
      if (action) {
        action.run();
      } else {
        // Fall back to trigger so commands without registered actions
        // (e.g. internal triggers) still work.
        ed.trigger("pointer", id, undefined);
      }
    };
    window.addEventListener("pointer:editor_command", onExternalCommand);

    // Sibling channel for "insert this literal text at the cursor"
    // (insert-UUID, insert-datetime). Doing it through the editor
    // ensures undo/redo see the insertion as a single edit and that
    // multi-cursor selections all receive the text.
    const onInsert = (e: Event) => {
      const ce = e as CustomEvent<{ text: string }>;
      const text = ce.detail?.text;
      if (typeof text !== "string") return;
      ed.focus();
      const selections = ed.getSelections();
      if (!selections || selections.length === 0) {
        ed.trigger("pointer", "type", { text });
        return;
      }
      ed.executeEdits(
        "pointer-insert",
        selections.map((sel) => ({ range: sel, text, forceMoveMarkers: true })),
      );
    };
    window.addEventListener("pointer:editor_insert", onInsert);

    // Language override coming from the status-bar picker. Monaco
    // retokenises on `setModelLanguage` so we don't need to
    // re-create the model.
    const onSetLanguage = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      const id = ce.detail?.id;
      const model = ed.getModel();
      if (!id || !model) return;
      try {
        monaco.editor.setModelLanguage(model, id);
        useEditorStore
          .getState()
          .setLanguage(pathFromMonacoUri(model.uri.toString()), id);
      } catch {
        /* unknown language id — ignore */
      }
    };
    window.addEventListener("pointer:set_language", onSetLanguage);

    // Cleanup on dispose — Monaco unmount handles other listeners.
    ed.onDidDispose(() => {
      window.removeEventListener("pointer:editor_command", onExternalCommand);
      window.removeEventListener("pointer:editor_insert", onInsert);
      window.removeEventListener("pointer:set_language", onSetLanguage);
    });
  };

  // Re-apply theme whenever it might have been clobbered.
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(POINTER_NOIR_ID);
    }
  }, [activePath]);

  // Reload workspace snippets when the user opens a different folder.
  const workspaceRoot = useWorkspace((s) => s.root);
  useEffect(() => {
    if (!monacoRef.current) return;
    const m = monacoRef.current;
    void import("@/lib/snippets").then(({ loadSnippets }) => {
      loadSnippets(workspaceRoot, m);
    });
  }, [workspaceRoot]);

  // Keep external language servers in sync with the active buffer. The
  // backend is lazy: when no server exists for the language this is a
  // cheap no-op; when one does exist (e.g. rust-analyzer), this is what
  // unlocks hover, completion, definitions, symbols, and diagnostics.
  useEffect(() => {
    if (!activeTab || activeTab.preview || activeTab.path.startsWith("untitled:")) return;
    const handle = window.setTimeout(() => {
      ipc
        .lspDidOpen({
          path: activeTab.path,
          language: activeTab.language,
          content: activeTab.content,
        })
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(handle);
  }, [activeTab?.path, activeTab?.language, activeTab?.content, activeTab?.preview]);

  // Inline blame on the current cursor line. Skipped for dirty
  // files (line numbers drift) and when no workspace is open.
  useInlineBlame(editorInstance, activeTab?.path ?? null, activeTab?.dirty ?? false);
  // Persistent bookmark gutter glyphs.
  useBookmarkDecorations(editorInstance, activeTab?.path ?? null);
  // Persistent debugger breakpoint glyphs.
  useBreakpointDecorations(editorInstance, activeTab?.path ?? null);

  // Restore per-file editor state (cursor + scroll + folds) on
  // tab activation. Monaco's view-state blob is opaque JSON so we
  // round-trip through it for fidelity; we also fall back to a
  // plain line:column position when the blob fails to deserialize
  // (e.g. structure changed across versions).
  useEffect(() => {
    if (!activePath) return;
    const ed = editorRef.current;
    if (!ed) return;
    const session = useSession.getState();
    const vs = session.viewState[activePath];
    if (!vs) return;
    try {
      if (vs.monacoBlob) {
        ed.restoreViewState(JSON.parse(vs.monacoBlob));
      } else {
        ed.setPosition({ lineNumber: vs.line, column: vs.column });
        ed.revealPositionInCenterIfOutsideViewport({
          lineNumber: vs.line,
          column: vs.column,
        });
        if (vs.scrollTop !== undefined) ed.setScrollTop(vs.scrollTop);
        if (vs.scrollLeft !== undefined) ed.setScrollLeft(vs.scrollLeft);
      }
    } catch {
      // Stale blob — fall back to position-only restore.
      try {
        ed.setPosition({ lineNumber: vs.line, column: vs.column });
      } catch {
        /* model not ready yet — ignore. */
      }
    }
  }, [activePath]);

  // Save per-file view state when leaving a tab (active path
  // changes) and when the editor loses focus. We capture the
  // Monaco blob (folds + selection arrays + viewport) plus the
  // primary cursor and scroll position as a redundant safety net.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !activePath) return;
    const path = activePath;
    const save = () => {
      try {
        const ed = editorRef.current;
        if (!ed) return;
        const pos = ed.getPosition();
        if (!pos) return;
        const blob = ed.saveViewState();
        useSession.getState().noteViewState(path, {
          line: pos.lineNumber,
          column: pos.column,
          scrollTop: ed.getScrollTop(),
          scrollLeft: ed.getScrollLeft(),
          monacoBlob: blob ? JSON.stringify(blob) : undefined,
        });
      } catch {
        /* race during unmount — next change will catch up. */
      }
    };
    // Save on blur and on path change unmount. Throttle to avoid
    // hammering persistence on rapid scroll.
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const disposable = ed.onDidScrollChange(() => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(save, 400);
    });
    return () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      disposable.dispose();
      save();
    };
  }, [activePath]);

  // Make fim model changes flow.
  useEffect(() => {
    /* settings live-read in provider via useSettings.getState() */
  }, [fimModel, fimEnabled, fimDebounceMs]);

  // External-change detection: if the file backing an open tab changes on
  // disk (agent wrote it, git pull, formatter ran outside Pointer…) and the
  // local copy is NOT dirty, transparently reload. If it IS dirty we'd risk
  // clobbering edits — leave it alone; the user will see "unsaved" in the
  // status bar and can decide.
  useEffect(() => {
    let off: (() => void) | undefined;
    listenEvent<{ kind: string; paths: string[] }>("fs:change", async (p) => {
      const openTabs = useEditorStore.getState().tabs;
      for (const path of p.paths) {
        // Untitled buffers have no on-disk counterpart — the fs watcher
        // never emits for them, but defend against accidental matches.
        if (path.startsWith("untitled:")) continue;
        const tab = openTabs.find((t) => t.path === path);
        if (!tab) continue;
        try {
          const next = await ipc.readTextFile(path);
          if (next === tab.content) continue;
          if (tab.dirty) {
            // Conflict: we have unsaved edits AND the on-disk version
            // changed. Stash the new on-disk content on the tab and
            // surface a banner; the user decides whether to reload
            // (discard local) or keep their changes.
            useEditorStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.path === path ? { ...t, externalContent: next } : t,
              ),
            }));
          } else {
            // Clean buffer — silently reload to match disk.
            useEditorStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.path === path
                  ? { ...t, content: next, dirty: false, externalContent: null }
                  : t,
              ),
            }));
          }
        } catch {
          /* file may have been removed */
        }
      }
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  if (!activeTab) {
    return (
      <div className="h-full w-full flex items-center justify-center font-sans">
        <div className="text-center max-w-sm px-6">
          <div
            className="text-4xl mb-3 select-none"
            style={{
              background: "linear-gradient(135deg, #FF2D7E, #FFD480)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              display: "inline-block",
            }}
          >
            ▸
          </div>
          <div className="text-[13px] text-noir-text mb-2">
            No file open
          </div>
          <div className="text-[11.5px] text-noir-mute leading-relaxed space-y-1">
            <div>
              Pick a file from the tree, or press{" "}
              <span className="pn-kbd">⌘P</span> to fuzzy-find.
            </div>
            <div>
              Ask the chat with <span className="pn-kbd">⌘L</span>, run the
              agent, or open AI settings with <span className="pn-kbd">⌘⇧,</span>.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Non-text previews: image viewer + binary placeholder. We route
  // before Monaco mounts so the editor never tries to interpret the
  // file as text (which would either crash on invalid UTF-8 or
  // worse, render garbled output).
  if (activeTab.preview === "image") {
    return <ImagePreview path={activeTab.path} />;
  }
  if (activeTab.preview === "binary") {
    return <BinaryPreview path={activeTab.path} />;
  }

  return (
    <div className="relative h-full w-full">
      {activeTab.externalContent != null && (
        <ExternalChangeBanner
          path={activeTab.path}
          externalContent={activeTab.externalContent}
        />
      )}
      <MonacoEditor
        height="100%"
        path={activeTab.path}
        language={activeTab.language}
        value={activeTab.content}
        theme={POINTER_NOIR_ID}
        onMount={onMount}
        onChange={(v) =>
          activeTab && updateContent(activeTab.path, v ?? "")
        }
        options={{
          fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
          fontSize: editorFontSize,
          fontLigatures: true,
          lineHeight: 1.55,
          letterSpacing: 0,
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          minimap: { enabled: editorMinimap, scale: 1, renderCharacters: false },
          // Need the glyph margin on for bookmark dots; harmless when
          // no decorations are present (gutter just stays blank).
          glyphMargin: true,
          // Render the swatch in the gutter for any colour our
          // provider returns, and surface the picker on hover.
          colorDecorators: true,
          colorDecoratorsActivatedOn: "clickAndHover",
          padding: { top: 18, bottom: 64 },
          renderWhitespace: editorRenderWhitespace ? "all" : "selection",
          renderLineHighlight: "line",
          scrollBeyondLastLine: true,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          guides: { indentation: true, bracketPairs: true },
          bracketPairColorization: { enabled: true },
          inlineSuggest: { enabled: true, mode: "subword" },
          fixedOverflowWidgets: true,
          tabSize: editorTabSize,
          insertSpaces: editorInsertSpaces,
          wordWrap: editorWordWrap ? "on" : "off",
          stickyScroll: { enabled: editorStickyScroll },
          unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
        }}
      />
      {inlineEdit && (
        <InlineEdit
          selection={inlineEdit.selection}
          position={inlineEdit.position}
          onClose={() => setInlineEdit(null)}
          onProposeDiff={(orig, proposed, desc) => {
            setPendingDiff({ original: orig, proposed, description: desc });
            setInlineEdit(null);
          }}
        />
      )}
      {pendingDiff && (
        <DiffOverlay
          original={pendingDiff.original}
          proposed={pendingDiff.proposed}
          description={pendingDiff.description}
          stats={pendingDiff.stats}
          onAccept={() => {
            if (activeTab) updateContent(activeTab.path, pendingDiff.proposed);
            setPendingDiff(null);
          }}
          onReject={() => setPendingDiff(null)}
        />
      )}
    </div>
  );
}

/** Truncate a string with an ellipsis. Used for the diagnostic title
 *  that appears in the CodeLens — Monaco renders this in the gutter
 *  area which is narrow, so an 80-char message wraps awkwardly. */
function truncate(s: string, max: number): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

/**
 * Inline banner shown above the editor when the on-disk version of
 * the current file diverged while the user has unsaved changes.
 * Offers three explicit choices:
 *   • Reload — replace the buffer with disk content (loses local edits)
 *   • Compare — open the side-by-side diff so the user can decide
 *   • Keep mine — dismiss the banner; on save the local copy wins
 */
function ExternalChangeBanner({
  path,
  externalContent,
}: {
  path: string;
  externalContent: string;
}) {
  const reload = () => {
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? { ...t, content: externalContent, dirty: false, externalContent: null }
          : t,
      ),
    }));
  };
  const keep = () => {
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, externalContent: null } : t,
      ),
    }));
  };
  const compare = () => {
    const tab = useEditorStore.getState().tabs.find((t) => t.path === path);
    if (!tab) return;
    void import("@/store/diffViewer").then(({ useDiffViewer }) => {
      useDiffViewer.getState().show({
        title: `${path}  ·  Disk ↔ Buffer`,
        language: tab.language,
        original: externalContent,
        modified: tab.content,
        readOnly: true,
        path,
        source: "literal",
      });
    });
  };
  return (
    <div className="absolute top-0 left-0 right-0 z-pn-editor-overlay flex items-center gap-3 px-3 py-2 text-[12px] font-sans border-b border-amber-400/40 bg-amber-400/10 text-noir-text">
      <span className="font-medium text-amber-300">⚠ Modified on disk</span>
      <span className="text-noir-subtext truncate flex-1 min-w-0">
        This file changed outside Pointer while you have unsaved edits.
      </span>
      <button
        onClick={compare}
        className="px-2 py-0.5 rounded text-noir-text hover:bg-noir-ridge/60"
      >
        Compare
      </button>
      <button
        onClick={reload}
        className="px-2 py-0.5 rounded bg-amber-400/20 text-amber-200 hover:bg-amber-400/30"
      >
        Reload from disk
      </button>
      <button
        onClick={keep}
        className="px-2 py-0.5 rounded text-noir-subtext hover:text-noir-text"
      >
        Keep mine
      </button>
    </div>
  );
}

/**
 * Register the global Monaco providers Pointer ships:
 *   • Code-action provider (Quick Fix lightbulb for diagnostics)
 *   • Code lens provider ("Fix with Pointer" inline)
 *   • Marker-routing commands invoked by both above
 *   • FIM inline completion provider
 *
 * Idempotent: the first call wires everything; subsequent calls
 * (Editor remounts) are no-ops. Providers read live state through
 * Zustand `getState()` calls so they don't go stale on remount.
 */
let aiProvidersRegistered = false;
let lspDiagnosticsRegistered = false;

function registerLspDiagnostics(monaco: Monaco) {
  if (lspDiagnosticsRegistered) return;
  lspDiagnosticsRegistered = true;
  listenEvent<LspDiagnosticEvent>("lsp:diagnostics", (event) => {
    const model = monaco.editor
      .getModels()
      .find((m) => pathFromMonacoUri(m.uri.toString()) === event.path);
    if (!model) return;
    if (!usesExternalLspDiagnostics(model.getLanguageId())) {
      monaco.editor.setModelMarkers(model, "lsp", []);
      return;
    }
    monaco.editor.setModelMarkers(
      model,
      "lsp",
      event.diagnostics.map((d) => ({
        startLineNumber: d.range.startLine,
        startColumn: d.range.startColumn,
        endLineNumber: d.range.endLine,
        endColumn: d.range.endColumn,
        severity: lspSeverity(monaco, d.severity),
        message: d.message,
        source: d.source ?? "lsp",
        code: d.code ?? undefined,
      })),
    );
  }).catch(() => {});
}

function usesExternalLspDiagnostics(language: string): boolean {
  // Monaco's TS/JS worker is the source of truth for plain .ts/.js buffers.
  // The external language server still powers completion/hover/definition, but
  // letting both publish diagnostics can create contradictory squiggles while
  // tsserver is warming up or has inferred-project settings out of date.
  return language !== "typescript" && language !== "javascript";
}

export function registerGlobalAiProviders(monaco: Monaco) {
  if (aiProvidersRegistered) return;
  aiProvidersRegistered = true;

  // Quick Fix / lightbulb actions on diagnostic markers.
  monaco.languages.registerCodeActionProvider(
    { pattern: "**" },
    {
      provideCodeActions: (_model, _range, ctx) => {
        if (!ctx.markers.length) return { actions: [], dispose: () => {} };
        const actions: languages.CodeAction[] = [];
        for (const m of ctx.markers) {
          const label = m.message.split("\n")[0].slice(0, 80);
          actions.push({
            title: `Pointer · Send to Ask: ${label}`,
            kind: "quickfix",
            diagnostics: [m],
            command: {
              id: "pointer.sendMarkerToChat",
              title: "Send to Ask",
              arguments: [m, "ask"],
            },
          });
          actions.push({
            title: `Pointer · Fix with agent: ${label}`,
            kind: "quickfix",
            diagnostics: [m],
            command: {
              id: "pointer.sendMarkerToAgent",
              title: "Fix with agent",
              arguments: [m, "agent"],
            },
          });
        }
        return { actions, dispose: () => {} };
      },
    },
  );

  // Marker-routing commands. We read the active tab through the store
  // at *invocation* time so the closure can never go stale (key win
  // over the previous closure-over-`activeTab` approach: a fix
  // triggered from the second file the user opens uses the right
  // path).
  const dispatchMarker = (target: AiTarget) => (
    _acc: unknown,
    marker: editor.IMarkerData,
  ) => {
    const active = useEditorStore.getState().getActive();
    const path = active?.path ?? "";
    const uri = path
      ? path.startsWith("/")
        ? `file://${path}`
        : `file:///${path}`
      : "";
    sendDiagnosticToAI(target, {
      uri,
      name: path.split(/[\\/]/).pop() || path,
      startLine: marker.startLineNumber,
      startCol: marker.startColumn,
      endLine: marker.endLineNumber,
      endCol: marker.endColumn,
      severity:
        marker.severity >= 8
          ? "error"
          : marker.severity >= 4
          ? "warning"
          : marker.severity >= 2
          ? "info"
          : "hint",
      message: marker.message,
      source: marker.source || "lint",
      code:
        typeof marker.code === "string" ? marker.code : marker.code?.value,
    });
  };
  monaco.editor.registerCommand(
    "pointer.sendMarkerToChat",
    dispatchMarker("ask"),
  );
  monaco.editor.registerCommand(
    "pointer.sendMarkerToAgent",
    dispatchMarker("agent"),
  );

  // CodeLens for diagnostics. Tied to Monaco's marker-change event so
  // a fresh diagnostic immediately materialises its lens.
  const lensEmitter = new monaco.Emitter<languages.CodeLensProvider>();
  const lensProvider: languages.CodeLensProvider = {
    onDidChange: lensEmitter.event,
    provideCodeLenses: (model) => {
      const markers = monaco.editor.getModelMarkers({ resource: model.uri });
      if (!markers.length) return { lenses: [], dispose: () => {} };
      const byLine = new Map<number, typeof markers>();
      for (const m of markers) {
        const arr = byLine.get(m.startLineNumber) ?? [];
        arr.push(m);
        byLine.set(m.startLineNumber, arr);
      }
      const lenses: languages.CodeLens[] = [];
      for (const [line, group] of byLine.entries()) {
        const summary =
          group.length === 1
            ? truncate(group[0].message, 60)
            : `${group.length} issues on this line`;
        const headMarker = group[0];
        lenses.push({
          range: {
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: 1,
          },
          command: {
            id: "pointer.sendMarkerToChat",
            title: `$(comment-discussion) Pointer · Ask: ${summary}`,
            arguments: [headMarker, "ask"],
          },
        });
        lenses.push({
          range: {
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: 1,
          },
          command: {
            id: "pointer.sendMarkerToAgent",
            title: "$(sparkle) Fix with agent",
            arguments: [headMarker, "agent"],
          },
        });
      }
      return { lenses, dispose: () => {} };
    },
  };
  monaco.languages.registerCodeLensProvider({ pattern: "**" }, lensProvider);
  monaco.editor.onDidChangeMarkers(() => lensEmitter.fire(lensProvider));

  // Cross-language definition fallback. Monaco's TS/JS worker already
  // gives rich definitions, but many local repos also have Rust,
  // Python, Go, config-adjacent scripts, etc. Without a full LSP
  // transport, F12 / Cmd-click should still land somewhere useful
  // instead of feeling broken, so we search for declaration-shaped
  // lines in the workspace and return them as definition locations.
  monaco.languages.registerDefinitionProvider(
    { pattern: "**" },
    {
      provideDefinition: async (model, position) => {
        const word = symbolAtPosition(
          model.getLineContent(position.lineNumber),
          position.column,
        );
        if (!word) return null;
        const language = model.getLanguageId();
        const patterns = definitionSearchPatterns(word.symbol, language);
        const sourcePath = pathFromMonacoUri(model.uri.toString());

        const lspLocations = await ipc
          .lspDefinition({
            path: sourcePath,
            language,
            content: model.getValue(),
            line: position.lineNumber,
            column: position.column,
            limit: 30,
          })
          .catch(() => []);
        if (lspLocations.length > 0) {
          return lspLocations.map((loc) => ({
            uri: monaco.Uri.file(loc.path),
            range: new monaco.Range(
              loc.line,
              loc.column,
              loc.endLine,
              loc.endColumn,
            ),
          }));
        }

        if (patterns.length === 0) return null;

        const batches = await Promise.all(
          patterns.map((pattern) =>
            ipc
              .searchText(pattern, 25, {
                regex: true,
                case_sensitive: true,
              })
              .catch(() => []),
          ),
        );
        const seen = new Set<string>();
        const hits = batches
          .flat()
          .filter((hit) => {
            const key = `${hit.path}:${hit.line}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => {
            const sameA = a.path === sourcePath ? 0 : 1;
            const sameB = b.path === sourcePath ? 0 : 1;
            if (sameA !== sameB) return sameA - sameB;
            return a.path.localeCompare(b.path) || a.line - b.line;
          })
          .slice(0, 30);
        if (hits.length === 0) return null;
        return hits.map((hit) => {
          const start = Math.max(1, hit.text.indexOf(word.symbol) + 1);
          return {
            uri: monaco.Uri.file(hit.path),
            range: new monaco.Range(
              hit.line,
              start,
              hit.line,
              start + word.symbol.length,
            ),
          };
        });
      },
    },
  );

  // Cross-language references. Prefer the active language server; when
  // one is missing or warming up, fall back to a precise whole-word
  // workspace scan so Shift+F12 / "Find All References" still works
  // in repos that do not have every language tool installed.
  monaco.languages.registerReferenceProvider(
    { pattern: "**" },
    {
      provideReferences: async (model, position) => {
        const word = symbolAtPosition(
          model.getLineContent(position.lineNumber),
          position.column,
        );
        if (!word) return null;
        const sourcePath = pathFromMonacoUri(model.uri.toString());
        const language = model.getLanguageId();
        const lspLocations = await ipc
          .lspReferences({
            path: sourcePath,
            language,
            content: model.getValue(),
            line: position.lineNumber,
            column: position.column,
            limit: 100,
          })
          .catch(() => []);
        if (lspLocations.length > 0) {
          return dedupeLocations(lspLocations).map((loc) =>
            locationFromLsp(monaco, loc),
          );
        }

        const hits = await ipc
          .searchText(word.symbol, 100, {
            case_sensitive: true,
            whole_word: true,
          })
          .catch(() => []);
        if (hits.length === 0) return null;
        return hits.map((hit) => {
          const start =
            (hit.col ?? -1) >= 0
              ? (hit.col ?? 0) + 1
              : Math.max(1, hit.text.indexOf(word.symbol) + 1);
          const length = hit.match_len && hit.match_len > 0
            ? hit.match_len
            : word.symbol.length;
          return {
            uri: monaco.Uri.file(hit.path),
            range: new monaco.Range(
              hit.line,
              start,
              hit.line,
              start + length,
            ),
          };
        });
      },
    },
  );

  // Hover affordance for the file-navigation layer above. This is
  // intentionally advisory only; the actual open happens from the
  // editor mouse handler so the file lands in Pointer's tab model.
  monaco.languages.registerHoverProvider(
    { pattern: "**" },
    {
      provideHover: async (model, position) => {
        const target = extractPathTarget(
          model.getLineContent(position.lineNumber),
          position.column,
        );
        if (!target) {
          const word = symbolAtPosition(
            model.getLineContent(position.lineNumber),
            position.column,
          );
          if (!word) return null;
          const sourcePath = pathFromMonacoUri(model.uri.toString());
          const lspHover = await ipc
            .lspHover({
              path: sourcePath,
              language: model.getLanguageId(),
              content: model.getValue(),
              line: position.lineNumber,
              column: position.column,
            })
            .catch(() => null);
          if (lspHover?.contents) {
            return {
              range: modelRangeFromLsp(
                monaco,
                position.lineNumber,
                word.startColumn,
                word.endColumn,
                lspHover.range,
              ),
              contents: [{ value: lspHover.contents }],
            };
          }
          const defs = findLocalDefinitions(
            model.getValue(),
            word.symbol,
            model.getLanguageId(),
          );
          const best = defs[0];
          if (!best) return null;
          return {
            range: new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            ),
            contents: [
              {
                value: `Pointer definition: line ${best.line}\n\n\`${best.text}\``,
              },
            ],
          };
        }
        const sourcePath = pathFromMonacoUri(model.uri.toString());
        const resolved = await resolvePathTarget({
          target,
          sourcePath,
          workspaceRoot: useWorkspace.getState().root,
        });
        const range = new monaco.Range(
          position.lineNumber,
          target.startColumn,
          position.lineNumber,
          target.endColumn,
        );
        if (!resolved) {
          return {
            range,
            contents: [{ value: `File target not found: \`${target.raw}\`` }],
          };
        }
        return {
          range,
          contents: [
            {
              value: `${primaryModifierLabel()}-click to open \`${shortPath(resolved.path)}\``,
            },
          ],
        };
      },
    },
  );

  monaco.languages.registerCompletionItemProvider(
    { pattern: "**" },
    {
      triggerCharacters: [".", ":", "<", '"', "'", "/", "@"],
      provideCompletionItems: async (model, position) => {
        const sourcePath = pathFromMonacoUri(model.uri.toString());
        const language = model.getLanguageId();
        const content = model.getValue();
        const items = await ipc
          .lspCompletion({
            path: sourcePath,
            language,
            content,
            line: position.lineNumber,
            column: position.column,
            limit: 80,
          })
          .catch(() => []);
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        if (items.length === 0 && language === "vue") {
          const fallback = vueCompletionSymbolsForPosition(
            content,
            position.lineNumber,
            position.column,
          );
          return {
            suggestions: fallback.map((item) => ({
              label: item.name,
              kind: vueCompletionKind(monaco, item.kind),
              insertText: item.name,
              detail: `Vue ${item.kind}`,
              range,
            })),
          };
        }
        if (items.length === 0) return { suggestions: [] };
        return {
          suggestions: items.map((item) =>
            completionItemFromLsp(monaco, item, range, {
              path: sourcePath,
              language,
              content,
            }),
          ),
        };
      },
      resolveCompletionItem: async (completion) => {
        const meta = (completion as PointerLspCompletion).__pointerLsp;
        if (!meta) return completion;
        const resolved = await ipc
          .lspCompletionResolve({
            path: meta.path,
            language: meta.language,
            content: meta.content,
            item: meta.item,
          })
          .catch(() => null);
        if (!resolved) return completion;
        const next = completionItemFromLsp(
          monaco,
          resolved,
          completion.range,
          {
            path: meta.path,
            language: meta.language,
            content: meta.content,
          },
        );
        Object.assign(completion, next);
        return completion;
      },
    },
  );

  // FIM inline completion provider. Pulls all of its config via
  // `useSettings.getState()` at call time so the FIM model / debounce
  // can be reconfigured without a Monaco restart.
  const fimCoordinator = new FimRequestCoordinator();
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      provideInlineCompletions: async (
        textModel,
        position,
        _context,
        cancelToken,
      ) => {
        if (!isFeatureUsable("fim")) return { items: [] };
        const line = textModel.getLineContent(position.lineNumber);
        if (position.column <= 1 && line.trim() === "") return { items: [] };

        const text = await fimCoordinator.request({
          debounceMs: useSettings.getState().fimDebounceMs,
          token: cancelToken,
          createRequestId: () => newRequestId("fim"),
          cancelRequest: (id) => {
            void ipc.ollamaCancel(id).catch(() => {});
          },
          generate: async (id) => {
            const rawPrefix = textModel.getValueInRange({
              startLineNumber: Math.max(1, position.lineNumber - 200),
              startColumn: 1,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            });
            const rawSuffix = textModel.getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: Math.min(
                textModel.getLineCount(),
                position.lineNumber + 200,
              ),
              endColumn: textModel.getLineMaxColumn(
                Math.min(textModel.getLineCount(), position.lineNumber + 200),
              ),
            });
            // Enrich the prompt with cross-file context:
            //   • the most-recently edited files in the workspace
            //     (the user's working set — most relevant to what
            //     they're typing right now);
            //   • other open tabs (the "ambient" context — files
            //     they're reading along with);
            //   • a one-line pattern hint comment when the local
            //     prefix shows a clear pattern (list, import block,
            //     function signature, body).
            // The local prefix is preserved verbatim; references are
            // budgeted out of the remaining char budget.
            const activePath = textModel.uri.path;
            const recentFiles = useRecentEdits
              .getState()
              .selectRecent(activePath, 4);
            const openTabs = useEditorStore
              .getState()
              .tabs.filter((t) => t.path !== activePath)
              .slice(0, 4)
              .map((t) => ({ path: t.path, content: t.content }));
            const ctx = buildFimContext({
              filePath: activePath,
              prefix: rawPrefix,
              suffix: rawSuffix,
              language: textModel.getLanguageId(),
              recentFiles,
              openTabs,
              // The whole FIM payload is sent verbatim to the model
              // as `prompt`; we cap at ~6 KB to keep per-keystroke
              // wire cost predictable. The local prefix stays whole
              // — only references get trimmed when this budget is
              // tight.
              budgetChars: 6_000,
            });
            return ipc.ollamaFim(id, {
              model: useSettings.getState().fimModel,
              prefix: ctx.prefix,
              suffix: ctx.suffix,
              num_predict: 96,
              stop: ctx.stop,
            });
          },
        });

        if (!text.trim()) return { items: [] };
        return {
          items: [
            {
              insertText: text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        };
      },
      freeInlineCompletions: () => undefined,
    },
  );
}

function toggleBreakpointAtCursor(ed: editor.IStandaloneCodeEditor): boolean {
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos) return false;
  const path = pathFromMonacoUri(model.uri.toString());
  useDebuggerStore.getState().toggleBreakpoint(path, pos.lineNumber);
  toast.info("Breakpoint toggled", { body: `${shortPath(path)}:${pos.lineNumber}` });
  return true;
}

function sendCurrentBreakpointFromEditor(
  ed: editor.IStandaloneCodeEditor,
  target: AiTarget,
) {
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos) {
    toast.info("Open a file first", {
      body: "Pointer needs an editor location to send a breakpoint.",
    });
    return;
  }
  const path = pathFromMonacoUri(model.uri.toString());
  const store = useDebuggerStore.getState();
  let breakpoint = store
    .breakpointsForPath(path)
    .find((bp) => bp.line === pos.lineNumber);
  if (!breakpoint) {
    const id = store.addBreakpoint({
      path,
      line: pos.lineNumber,
      enabled: true,
    });
    breakpoint = useDebuggerStore.getState().breakpoints.find((bp) => bp.id === id);
  }
  if (!breakpoint) return;
  sendBreakpointToAI(target, breakpoint);
}

function toggleBreakpointFromGutter(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  mouseEvent: Parameters<editor.IStandaloneCodeEditor["onMouseDown"]>[0] extends (
    listener: (event: infer E) => unknown,
  ) => unknown
    ? E
    : any,
): boolean {
  const type = mouseEvent.target.type;
  const isBreakpointZone =
    type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
    type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
  if (!isBreakpointZone) return false;
  const position = mouseEvent.target.position;
  const model = ed.getModel();
  if (!position || !model) return false;
  const event = mouseEvent.event as unknown as {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
  event.preventDefault?.();
  event.stopPropagation?.();
  useDebuggerStore
    .getState()
    .toggleBreakpoint(pathFromMonacoUri(model.uri.toString()), position.lineNumber);
  return true;
}

async function openFileTargetUnderPointer(
  ed: editor.IStandaloneCodeEditor,
  mouseEvent: Parameters<editor.IStandaloneCodeEditor["onMouseDown"]>[0] extends (
    listener: (event: infer E) => unknown,
  ) => unknown
    ? E
    : any,
) {
  const event = mouseEvent.event as unknown as {
    metaKey?: boolean;
    ctrlKey?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
  if (!event.metaKey && !event.ctrlKey) return;
  const position = mouseEvent.target.position;
  if (!position) return;
  const model = ed.getModel();
  if (!model) return;
  const target = extractPathTarget(
    model.getLineContent(position.lineNumber),
    position.column,
  );
  if (!target) return;

  event.preventDefault?.();
  event.stopPropagation?.();
  const resolved = await resolveTargetFromModel(model, target);
  if (!resolved) {
    toast.info("No file found for link", { body: target.raw });
    return;
  }
  useEditorStore.getState().revealAt(resolved.path, 1, 1).catch(() => {});
}

async function resolveTargetFromModel(
  model: editor.ITextModel,
  target: PathTarget,
) {
  return resolvePathTarget({
    target,
    sourcePath: pathFromMonacoUri(model.uri.toString()),
    workspaceRoot: useWorkspace.getState().root,
  });
}

function primaryModifierLabel(): string {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)) {
    return "Cmd";
  }
  return "Ctrl";
}

function lspSeverity(monaco: Monaco, severity: number | null | undefined) {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
}

function lspCompletionKind(monaco: Monaco, kind: number | null | undefined) {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 2:
      return k.Method;
    case 3:
      return k.Function;
    case 4:
      return k.Constructor;
    case 5:
      return k.Field;
    case 6:
      return k.Variable;
    case 7:
      return k.Class;
    case 8:
      return k.Interface;
    case 9:
      return k.Module;
    case 10:
      return k.Property;
    case 12:
      return k.Value;
    case 13:
      return k.Enum;
    case 14:
      return k.Keyword;
    case 15:
      return k.Snippet;
    case 16:
      return k.Color;
    case 17:
      return k.File;
    case 18:
      return k.Reference;
    case 20:
      return k.EnumMember;
    case 21:
      return k.Constant;
    case 22:
      return k.Struct;
    case 23:
      return k.Event;
    case 24:
      return k.Operator;
    case 25:
      return k.TypeParameter;
    default:
      return k.Text;
  }
}

function vueCompletionKind(monaco: Monaco, kind: VueSymbolKind) {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "component":
      return k.Class;
    case "computed":
    case "data":
    case "prop":
    case "ref":
    case "setup":
      return k.Property;
    case "method":
      return k.Method;
    default:
      return k.Text;
  }
}

function completionItemFromLsp(
  monaco: Monaco,
  item: LspCompletionItem,
  fallbackRange: languages.CompletionItem["range"],
  meta: { path: string; language: string; content: string },
): PointerLspCompletion {
  const insertText = item.insertText || item.label;
  const completion: PointerLspCompletion = {
    label: item.label,
    kind: lspCompletionKind(monaco, item.kind),
    insertText,
    insertTextRules:
      item.insertTextFormat === 2 || /\$\d|\$\{/.test(insertText)
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    detail: item.detail ?? undefined,
    documentation: item.documentation ? { value: item.documentation } : undefined,
    range: item.range ? lspRangeToMonaco(monaco, item.range) : fallbackRange,
    sortText: item.sortText ?? undefined,
    filterText: item.filterText ?? undefined,
    preselect: item.preselect ?? undefined,
    additionalTextEdits: item.additionalTextEdits.map((edit) => ({
      range: lspRangeToMonaco(monaco, edit.range),
      text: edit.newText,
    })),
    __pointerLsp: {
      ...meta,
      item,
    },
  };
  return completion;
}

function lspRangeToMonaco(monaco: Monaco, range: LspRange) {
  return new monaco.Range(
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
  );
}

function locationFromLsp(monaco: Monaco, loc: LspLocation): languages.Location {
  return {
    uri: monaco.Uri.file(loc.path),
    range: new monaco.Range(
      loc.line,
      loc.column,
      loc.endLine,
      loc.endColumn,
    ),
  };
}

function dedupeLocations(locations: LspLocation[]): LspLocation[] {
  const seen = new Set<string>();
  const out: LspLocation[] = [];
  for (const loc of locations) {
    const key = `${loc.path}:${loc.line}:${loc.column}:${loc.endLine}:${loc.endColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}

function modelRangeFromLsp(
  monaco: Monaco,
  fallbackLine: number,
  fallbackStart: number,
  fallbackEnd: number,
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null,
) {
  if (range) {
    return new monaco.Range(
      range.startLine,
      range.startColumn,
      range.endLine,
      range.endColumn,
    );
  }
  return new monaco.Range(fallbackLine, fallbackStart, fallbackLine, fallbackEnd);
}

function shortPath(path: string): string {
  const root = useWorkspace.getState().root;
  if (root && path.startsWith(root)) {
    return path.slice(root.length).replace(/^[\\/]+/, "");
  }
  return path;
}

/**
 * Lift the editor's current selection into the Ask / Agent picker.
 * Centralised so the Cmd+L shortcut, the right-click action and the
 * command palette all go through one code path — which means each
 * trigger surfaces the same toasts (and the same "select something
 * first" fallback when the selection is empty).
 */
function sendSelectionFromEditor(
  ed: editor.IStandaloneCodeEditor,
  target: AiTarget,
) {
  const sel = ed.getSelection();
  const model = ed.getModel();
  if (!sel || !model || sel.isEmpty()) {
    toast.info("Select some code first", {
      body: "Highlight the lines you want to discuss, then try again.",
    });
    return;
  }
  const text = model.getValueInRange(sel);
  // Monaco model URIs are `file:///abs/path`. The send-to-AI helper
  // expects a workspace-relative *path*; we strip the scheme + the
  // Windows leading slash that follows it.
  const path = pathFromMonacoUri(model.uri.toString());
  sendSelectionToAI(target, {
    path,
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber,
    text,
  });
}
