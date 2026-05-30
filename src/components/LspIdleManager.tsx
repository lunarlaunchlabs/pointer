import { useEffect, useMemo, useRef } from "@/lib/preactSignalCompat";
import { toast } from "@/components/Toast";
import { ipc } from "@/lib/ipc";
import { useEditorStore, type Tab } from "@/store/editor";
import { normalizeRuntimeLanguage, useLspRuntime } from "@/store/lspRuntime";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "keydown",
  "pointerdown",
  "mousemove",
  "wheel",
  "touchstart",
  "focus",
];

export function LspIdleManager() {
  const root = useWorkspace((s) => s.root);
  const tabs = useEditorStore((s) => s.tabs);
  const activePath = useEditorStore((s) => s.activePath);
  const enabled = useSettings((s) => s.lspAutoStopEnabled);
  const idleMs = useSettings((s) => s.lspAutoStopIdleMs);
  const lastInteractionAtRef = useRef(Date.now());
  const focusLostAtRef = useRef<number | null>(
    typeof document !== "undefined" && document.hasFocus() ? null : Date.now(),
  );
  const noEditorsSinceRef = useRef<number | null>(null);
  const lastNeededByLanguageRef = useRef<Record<string, number>>({});
  const pendingStopRef = useRef(false);
  const rootRef = useRef<string | null>(root);
  const previousRootRef = useRef<string | null>(root);
  const editorTabsRef = useRef<Tab[]>([]);
  const activePathRef = useRef<string | null>(activePath);
  const activeLanguagesRef = useRef<string[]>([]);

  const editorTabs = useMemo(
    () => tabs.filter((tab) => isTextEditorTab(tab)),
    [tabs],
  );

  const activeLanguages = useMemo(() => {
    const languages = new Set<string>();
    for (const tab of editorTabs) {
      languages.add(normalizeRuntimeLanguage(tab.language));
    }
    return [...languages].sort();
  }, [editorTabs]);
  const activeLanguageKey = activeLanguages.join("\0");

  useEffect(() => {
    rootRef.current = root;
    editorTabsRef.current = editorTabs;
    activePathRef.current = activePath;
    activeLanguagesRef.current = activeLanguages;
  }, [activeLanguageKey, activePath, editorTabs, root]);

  useEffect(() => {
    const previousRoot = previousRootRef.current;
    previousRootRef.current = root;
    if (previousRoot && previousRoot !== root) {
      void ipc
        .lspStopIdle({ workspace: previousRoot, stopAll: true, languages: [] })
        .catch((error) => {
          console.warn("failed to stop language servers for previous workspace", error);
        });
    }
    useLspRuntime.getState().clear();
    lastNeededByLanguageRef.current = {};
    noEditorsSinceRef.current = editorTabs.length === 0 ? Date.now() : null;
  }, [root]);

  useEffect(() => {
    const now = Date.now();
    if (editorTabs.length === 0) {
      noEditorsSinceRef.current ??= now;
    } else {
      noEditorsSinceRef.current = null;
    }
    for (const language of activeLanguages) {
      lastNeededByLanguageRef.current[language] = now;
    }
  }, [activeLanguageKey, editorTabs.length]);

  useEffect(() => {
    const onActivity = () => {
      lastInteractionAtRef.current = Date.now();
      focusLostAtRef.current = null;
      restartOpenLanguageServers(
        rootRef.current,
        editorTabsRef.current,
        activePathRef.current,
      );
    };
    const onBlur = () => {
      focusLostAtRef.current = Date.now();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        focusLostAtRef.current = Date.now();
      } else {
        onActivity();
      }
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !root) return;
    const pollMs = Math.max(5000, Math.min(15000, Math.floor(idleMs / 4)));
    const run = () => {
      if (pendingStopRef.current) return;
      const now = Date.now();
      const inactiveLongEnough = now - lastInteractionAtRef.current >= idleMs;
      const unfocusedLongEnough =
        focusLostAtRef.current !== null && now - focusLostAtRef.current >= idleMs;
      const noEditorsLongEnough =
        noEditorsSinceRef.current !== null && now - noEditorsSinceRef.current >= idleMs;

      if (inactiveLongEnough || unfocusedLongEnough || noEditorsLongEnough) {
        void stopLanguageServers(root, true, [], "idle", pendingStopRef);
        return;
      }

      const active = new Set(activeLanguagesRef.current);
      const staleLanguages = Object.entries(lastNeededByLanguageRef.current)
        .filter(([language, lastNeededAt]) => {
          return !active.has(language) && now - lastNeededAt >= idleMs;
        })
        .map(([language]) => language);

      if (staleLanguages.length > 0) {
        void stopLanguageServers(root, false, staleLanguages, "unused", pendingStopRef);
      }
    };
    const id = window.setInterval(run, pollMs);
    run();
    return () => window.clearInterval(id);
  }, [enabled, idleMs, root]);

  return null;
}

function isTextEditorTab(tab: Tab): boolean {
  return !tab.preview && !tab.path.startsWith("untitled:");
}

async function stopLanguageServers(
  workspace: string,
  stopAll: boolean,
  languages: string[],
  reason: "idle" | "unused",
  pendingRef: { current: boolean },
) {
  pendingRef.current = true;
  try {
    const stopped = await ipc.lspStopIdle({ workspace, stopAll, languages });
    if (stopped.length === 0) return;
    useLspRuntime.getState().markIdleStopped(stopped);
    toast.info(
      stopped.length === 1
        ? "Language server paused"
        : "Language servers paused",
      {
        body:
          reason === "idle"
            ? `${formatServerList(stopped)} stopped due to no use for memory efficiency.`
            : `${formatServerList(stopped)} stopped because no open editor currently needs it.`,
      },
    );
  } catch (error) {
    console.warn("failed to stop idle language servers", error);
  } finally {
    pendingRef.current = false;
  }
}

function restartOpenLanguageServers(
  workspace: string | null,
  tabs: Tab[],
  activePath: string | null,
) {
  if (!workspace || tabs.length === 0) return;
  const byLanguage = new Map<string, Tab>();
  for (const tab of tabs) {
    const language = normalizeRuntimeLanguage(tab.language);
    if (!byLanguage.has(language) || tab.path === activePath) {
      byLanguage.set(language, tab);
    }
  }
  for (const tab of byLanguage.values()) {
    const restart = useLspRuntime
      .getState()
      .beginRestartIfIdleStopped(tab.language);
    if (!restart) continue;
    toast.info(`${restart.label} loading`, {
      body: "Pointer paused it to save memory and is starting it again.",
    });
    ipc
      .lspDidOpen({
        path: tab.path,
        language: tab.language,
        content: useEditorStore.getState().getContent(tab.path) ?? tab.content,
      })
      .then(() => {
        useLspRuntime.getState().finishRestart(restart.language);
        toast.success(`${restart.label} ready`);
      })
      .catch((error) => {
        useLspRuntime.getState().finishRestart(restart.language);
        toast.warn(`${restart.label} could not start`, {
          body: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

function formatServerList(servers: Array<{ label: string }>): string {
  const labels = [...new Set(servers.map((server) => server.label))];
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}
