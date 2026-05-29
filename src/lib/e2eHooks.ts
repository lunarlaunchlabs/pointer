import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useAssistant } from "@/store/assistant";
import { useEditorStore } from "@/store/editor";
import { useDebuggerStore } from "@/store/debugger";
import { ipc } from "@/lib/ipc";

type E2EBridge = {
  appReady?: boolean;
  markAppReady?: () => void;
  editor?: Record<string, unknown>;
  assistant?: Record<string, unknown>;
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
    openFile: (path: string) => useEditorStore.getState().openFile(path),
    setCursor: (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
    },
    language: () => editorInstance.getModel()?.getLanguageId() ?? null,
    content: () => editorInstance.getModel()?.getValue() ?? "",
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
    triggerSuggest: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      await editorInstance.getAction("editor.action.triggerSuggest")?.run();
    },
    gotoDefinitionAt: async (line: number, column: number) => {
      editorInstance.setPosition({ lineNumber: line, column });
      editorInstance.focus();
      const model = editorInstance.getModel();
      if (model) {
        const sourcePath = model.uri.toString().replace(/^file:\/\//, "");
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
    revealAt: async (path: string, line = 1, column = 1) => {
      await useEditorStore.getState().revealAt(path, line, column);
      return useEditorStore.getState().getActive()?.path ?? null;
    },
  };

  bridge.assistant = {
    active: () => useAssistant.getState().getActive(),
    pendingRefs: () => useAssistant.getState().pendingRefs,
  };

  bridge.debug = {
    breakpoints: () => useDebuggerStore.getState().breakpoints,
    values: () => useDebuggerStore.getState().values,
  };
}
