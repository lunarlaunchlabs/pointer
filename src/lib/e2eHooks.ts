import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useAssistant } from "@/store/assistant";
import { useEditorStore } from "@/store/editor";
import { useDebuggerStore } from "@/store/debugger";
import { useSettings } from "@/store/settings";
import { ipc } from "@/lib/ipc";
import { pathFromMonacoUri } from "@/lib/monacoUri";
import type { AppThemeId } from "@/theme/themes";

type E2EBridge = {
  appReady?: boolean;
  markAppReady?: () => void;
  editor?: Record<string, unknown>;
  assistant?: Record<string, unknown>;
  theme?: Record<string, unknown>;
  debug?: Record<string, unknown>;
};

declare global {
  interface Window {
    __POINTER_E2E__?: E2EBridge;
  }
}

export function markE2EAppReady() {
  const bridge = window.__POINTER_E2E__;
  if (!bridge) return;
  bridge.appReady = true;
  bridge.markAppReady?.();
  window.dispatchEvent(new CustomEvent("pointer:e2e-ready"));
}

export function installEditorE2EHooks(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: Monaco,
) {
  const bridge = window.__POINTER_E2E__;
  if (!bridge) return;

  bridge.editor = {
    activeTab: () => useEditorStore.getState().getActive(),
    cursor: () => useEditorStore.getState().cursor,
    openFile: (path: string) => useEditorStore.getState().openFile(path),
    setCursor: (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
    },
    language: () => editorInstance.getModel()?.getLanguageId() ?? null,
    content: () => editorInstance.getModel()?.getValue() ?? "",
    modelOptions: () => {
      const options = editorInstance.getModel()?.getOptions();
      return options
        ? {
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
          }
        : null;
    },
    markers: () => {
      const model = editorInstance.getModel();
      if (!model) return [];
      return monaco.editor.getModelMarkers({ resource: model.uri }).map((m) => ({
        message: m.message,
        severity: m.severity,
        source: m.source,
        code: typeof m.code === "string" ? m.code : m.code?.value,
        line: m.startLineNumber,
        column: m.startColumn,
      }));
    },
    tokenClassesForLine: (line: number) => {
      const root = editorInstance.getDomNode();
      const lines = Array.from(
        root?.querySelectorAll<HTMLElement>(".view-line") ?? [],
      );
      const lineNode = lines[Math.max(0, line - 1)] ?? lines[0] ?? null;
      return Array.from(
        lineNode?.querySelectorAll<HTMLElement>("span[class*='mtk']") ?? [],
      ).map((node) => node.className);
    },
    visibleTokenClasses: () => {
      const root = editorInstance.getDomNode();
      return Array.from(
        root?.querySelectorAll<HTMLElement>(".view-line span[class*='mtk']") ?? [],
      ).map((node) => node.className);
    },
    visibleTokenStyles: () => {
      const root = editorInstance.getDomNode();
      return Array.from(
        root?.querySelectorAll<HTMLElement>(".view-line span[class*='mtk']") ?? [],
      ).map(tokenStyleSnapshot);
    },
    tokenStylesForLine: (line: number) => {
      const root = editorInstance.getDomNode();
      const lines = Array.from(
        root?.querySelectorAll<HTMLElement>(".view-line") ?? [],
      );
      const lineNode = lines[Math.max(0, line - 1)] ?? null;
      return Array.from(
        lineNode?.querySelectorAll<HTMLElement>("span[class*='mtk']") ?? [],
      ).map(tokenStyleSnapshot);
    },
    setInlayHints: (enabled: boolean) => {
      editorInstance.updateOptions({
        inlayHints: { enabled: enabled ? "on" : "off" },
      });
    },
    visibleGhostText: () => {
      const root = editorInstance.getDomNode();
      return Array.from(
        root?.querySelectorAll<HTMLElement>(
          ".ghost-text-decoration, .ghost-text-decoration-preview",
        ) ?? [],
      ).map((node) => {
        const style = window.getComputedStyle(node);
        return {
          text: node.textContent ?? "",
          color: style.color,
          backgroundColor: style.backgroundColor,
          display: style.display,
          visibility: style.visibility,
        };
      });
    },
    gitDiffDecorationClasses: () => {
      const root = editorInstance.getDomNode();
      return Array.from(
        root?.querySelectorAll<HTMLElement>(
          ".pn-git-diff-line, .pn-git-diff-bar, .pn-git-diff-glyph, .pn-git-diff-deleted-text",
        ) ?? [],
      ).map((node) => node.className);
    },
    breakpointDecorationClasses: () => {
      const root = editorInstance.getDomNode();
      return Array.from(
        root?.querySelectorAll<HTMLElement>(
          ".pn-breakpoint-glyph, .pn-breakpoint-disabled",
        ) ?? [],
      ).map((node) => node.className);
    },
    toggleBreakpointAt: async (line: number, column = 1) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      await editorInstance.getAction("pointer.toggleBreakpoint")?.run();
      await nextPaint();
      await nextPaint();
      return useDebuggerStore.getState().breakpoints;
    },
    runAction: async (id: string) => {
      editorInstance.focus();
      await editorInstance.getAction(id)?.run();
    },
    triggerSuggest: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      await editorInstance.getAction("editor.action.triggerSuggest")?.run();
    },
    clientPointForPosition: async (line: number, column: number) => {
      editorInstance.revealPositionInCenterIfOutsideViewport({
        lineNumber: line,
        column,
      });
      await nextPaint();
      await nextPaint();
      const visible = editorInstance.getScrolledVisiblePosition({
        lineNumber: line,
        column,
      });
      const rect = editorInstance.getDomNode()?.getBoundingClientRect();
      if (!visible || !rect) return null;
      return {
        x: rect.left + visible.left,
        y: rect.top + visible.top + visible.height / 2,
      };
    },
    visibleSuggestItems: () => {
      const root = editorInstance.getDomNode()?.ownerDocument ?? document;
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          ".suggest-widget .monaco-list-row .monaco-highlighted-label, .suggest-widget .monaco-list-row .label-name",
        ),
      )
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean);
    },
    showHoverAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      await editorInstance.getAction("editor.action.showHover")?.run();
      await nextPaint();
      await nextPaint();
      const root = editorInstance.getDomNode()?.ownerDocument ?? document;
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          ".monaco-hover .hover-contents, .monaco-hover .markdown-hover, .monaco-hover",
        ),
      )
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
    },
    triggerInlineSuggest: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      await editorInstance.getAction("editor.action.inlineSuggest.trigger")?.run();
    },
    triggerInlineSuggestAtCursor: async () => {
      editorInstance.focus();
      await editorInstance.getAction("editor.action.inlineSuggest.trigger")?.run();
    },
    gotoDefinitionAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (model) {
        const sourcePath = pathFromMonacoUri(model.uri.toString());
        const locations = await ipc
          .lspDefinition({
            path: sourcePath,
            language: model.getLanguageId(),
            content: model.getValue(),
            line,
            column,
            limit: 30,
          })
          .catch(() => []);
        const target = locations[0];
        if (target) {
          await useEditorStore
            .getState()
            .revealAt(target.path, target.line, target.column);
          return useEditorStore.getState().getActive()?.path ?? null;
        }
      }
      await editorInstance.getAction("editor.action.revealDefinition")?.run();
      return useEditorStore.getState().getActive()?.path ?? null;
    },
    hoverAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (!model) return null;
      return ipc
        .lspHover({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
          line,
          column,
        })
        .catch(() => null);
    },
    completionItemsAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (!model) return [];
      return ipc
        .lspCompletion({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
          line,
          column,
          limit: 80,
        })
        .catch(() => []);
    },
    referencesAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (!model) return [];
      return ipc
        .lspReferences({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
          line,
          column,
          limit: 80,
        })
        .catch(() => []);
    },
    documentHighlightsAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (!model) return [];
      return ipc
        .lspDocumentHighlight({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
          line,
          column,
          limit: 80,
        })
        .catch(() => []);
    },
    documentSymbols: async () => {
      const model = editorInstance.getModel();
      if (!model) return [];
      return ipc
        .lspDocumentSymbols({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
        })
        .catch(() => []);
    },
    renameEditsAt: async (line: number, column: number, newName: string) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (!model) return [];
      return ipc
        .lspRename({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
          line,
          column,
          newName,
        })
        .catch(() => []);
    },
    inlayHintsAt: async (
      startLine: number,
      startColumn: number,
      endLine: number,
      endColumn: number,
    ) => {
      const model = editorInstance.getModel();
      if (!model) return [];
      return ipc
        .lspInlayHints({
          path: pathFromMonacoUri(model.uri.toString()),
          language: model.getLanguageId(),
          content: model.getValue(),
          startLine,
          startColumn,
          endLine,
          endColumn,
          limit: 250,
        })
        .catch(() => []);
    },
    revealAt: async (path: string, line = 1, column = 1) => {
      await useEditorStore.getState().revealAt(path, line, column);
      return useEditorStore.getState().getActive()?.path ?? null;
    },
  };

  bridge.assistant = {
    active: () => useAssistant.getState().getActive(),
    pendingRefs: () => useAssistant.getState().pendingRefs,
  };

  bridge.theme = {
    active: () => useSettings.getState().appTheme,
    setTheme: (themeId: AppThemeId) => {
      useSettings.getState().setAppTheme(themeId);
    },
  };

  bridge.debug = {
    breakpoints: () => useDebuggerStore.getState().breakpoints,
    values: () => useDebuggerStore.getState().values,
  };
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function tokenStyleSnapshot(node: HTMLElement) {
  const style = window.getComputedStyle(node);
  return {
    text: node.textContent ?? "",
    className: node.className,
    color: style.color,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
  };
}
