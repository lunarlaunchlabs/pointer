import { lazy, Suspense, useEffect, useState } from "react";
import {
  Activity,
  Bot,
  Bug,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  History,
  Settings2,
} from "lucide-react";
import { useSession, type DockView } from "@/store/session";
import { useSettings, isFeatureUsable } from "@/store/settings";
import { useGit } from "@/store/git";
import { useAssistant } from "@/store/assistant";
import { useDebuggerStore } from "@/store/debugger";
import { ipc, listenEvent, type InferenceSnapshot } from "@/lib/ipc";

const AssistantView = lazy(() =>
  import("@/components/Assistant/AssistantView").then((m) => ({
    default: m.AssistantView,
  })),
);
const AIPanelView = lazy(() =>
  import("@/components/AIPanel").then((m) => ({ default: m.AIPanelView })),
);
const ModelActivityPanel = lazy(() =>
  import("@/components/ModelActivityPanel").then((m) => ({
    default: m.ModelActivityPanel,
  })),
);
const HistoryView = lazy(() =>
  import("@/components/Chat/HistoryView").then((m) => ({ default: m.HistoryView })),
);
const SourceControlPanel = lazy(() =>
  import("@/components/Git/SourceControlPanel").then((m) => ({
    default: m.SourceControlPanel,
  })),
);
const DebugPanel = lazy(() =>
  import("@/components/Debug/DebugPanel").then((m) => ({
    default: m.DebugPanel,
  })),
);

/** The right-hand dock. A persistent rail with view buttons + an optionally-
 *  collapsible panel area. The rail is always visible so the user can never
 *  lose access to the Assistant, history, or AI settings.
 *
 *  Note: the old Chat and Agent rail icons collapsed into a single
 *  Assistant icon (the unified panel handles all three modes via its
 *  internal picker). History, SCM, and AI Control stay as separate
 *  surfaces because they're not part of the conversation. */
export function RightDock() {
  const dockView = useSession((s) => s.dockView);
  const setDockView = useSession((s) => s.noteDockView);
  const chatWidth = useSession((s) => s.chatWidth);
  const noteChatWidth = useSession((s) => s.noteChatWidth);
  const [mountedViews, setMountedViews] = useState<
    Set<Exclude<DockView, null>>
  >(() => (dockView ? new Set([dockView]) : new Set()));

  // Hydrate the unified assistant store once. Migration from the
  // legacy chat/agent stores runs inside `init()` if needed.
  const assistantInit = useAssistant((s) => s.init);
  const assistantHydrated = useAssistant((s) => s.hydrated);
  useEffect(() => {
    if (!assistantHydrated) assistantInit();
  }, [assistantHydrated, assistantInit]);

  const panelOpen = dockView !== null;
  const select = (v: Exclude<DockView, null>) => {
    setDockView(dockView === v ? null : v);
  };
  useEffect(() => {
    if (!dockView) return;
    setMountedViews((current) => {
      if (current.has(dockView)) return current;
      const next = new Set(current);
      next.add(dockView);
      return next;
    });
  }, [dockView]);
  // Feature gates: the rail icon stays visible (so the user can see
  // it exists) but dims when chat isn't usable. Clicking still
  // opens the view, which renders a precise banner with the reason.
  const chatUsable = useSettings((s) => isFeatureUsable("chat", s));

  return (
    <div className="h-full flex shrink-0 border-l border-noir-line/80 bg-noir-panel/92 backdrop-blur-xl shadow-[-1px_0_0_rgba(255,255,255,0.02)]">
      {mountedViews.size > 0 && (
        <PanelContainer
          width={chatWidth ?? 420}
          onResize={noteChatWidth}
          hidden={!panelOpen}
        >
          <Suspense fallback={<DockLoading />}>
            {mountedViews.has("assistant") && (
              <DockPane active={dockView === "assistant"}>
                <AssistantView />
              </DockPane>
            )}
            {mountedViews.has("history") && (
              <DockPane active={dockView === "history"}>
                <HistoryView onNavigate={(v) => setDockView(v)} />
              </DockPane>
            )}
            {mountedViews.has("ai") && (
              <DockPane active={dockView === "ai"}>
                <AIPanelView />
              </DockPane>
            )}
            {mountedViews.has("activity") && (
              <DockPane active={dockView === "activity"}>
                <ModelActivityPanel />
              </DockPane>
            )}
            {mountedViews.has("scm") && (
              <DockPane active={dockView === "scm"}>
                <SourceControlPanel />
              </DockPane>
            )}
            {mountedViews.has("debug") && (
              <DockPane active={dockView === "debug"}>
                <DebugPanel />
              </DockPane>
            )}
          </Suspense>
        </PanelContainer>
      )}
      <nav
        className="w-11 shrink-0 border-l border-noir-line/70 bg-noir-canvas/45 flex flex-col items-center py-2 gap-1"
        aria-label="Right dock"
        role="tablist"
        aria-orientation="vertical"
      >
        {/* Unified Assistant — replaces the old Chat + Agent rail icons.
            One panel, three modes (Ask | Plan | Agent) selected inside. */}
        <RailButton
          icon={<Bot size={14} aria-hidden="true" />}
          label={chatUsable ? "Assistant (⌘L)" : "Assistant (not ready)"}
          active={dockView === "assistant"}
          dim={!chatUsable}
          onClick={() => select("assistant")}
          badge={<RunningBadge />}
        />
        {/* Visual separator — secondary tools (history, scm, settings). */}
        <div className="w-5 h-px bg-noir-line/60 my-1.5" aria-hidden="true" />
        <RailButton
          icon={<Activity size={14} aria-hidden="true" />}
          label="Model Activity"
          active={dockView === "activity"}
          onClick={() => select("activity")}
          badge={<InferenceBadge />}
        />
        <RailButton
          icon={<GitBranch size={14} aria-hidden="true" />}
          label="Source Control"
          active={dockView === "scm"}
          onClick={() => select("scm")}
          badge={<DirtyBadge />}
        />
        <RailButton
          icon={<Bug size={14} aria-hidden="true" />}
          label="Debug"
          active={dockView === "debug"}
          onClick={() => select("debug")}
          badge={<BreakpointBadge />}
        />
        <RailButton
          icon={<History size={14} aria-hidden="true" />}
          label="History"
          active={dockView === "history"}
          onClick={() => select("history")}
        />
        <RailButton
          icon={<Settings2 size={14} aria-hidden="true" />}
          label="AI control (⌘⇧,)"
          active={dockView === "ai"}
          onClick={() => select("ai")}
        />
        <div className="flex-1" />
        <button
          onClick={() => setDockView(panelOpen ? null : dockView ?? "assistant")}
          className="w-7 h-7 rounded-md text-noir-mute hover:text-noir-text hover:bg-noir-ridge/60 inline-flex items-center justify-center transition-colors"
          title={panelOpen ? "Collapse panel (⌘L / ⌘,)" : "Expand panel"}
          aria-label={panelOpen ? "Collapse right dock panel" : "Expand right dock panel"}
          aria-expanded={panelOpen}
        >
          {panelOpen ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronLeft size={12} aria-hidden="true" />}
        </button>
      </nav>
    </div>
  );
}

function DockLoading() {
  return (
    <div className="h-full flex items-center justify-center bg-noir-canvas text-[11px] font-sans text-noir-mute">
      Loading…
    </div>
  );
}

function PanelContainer({
  width,
  onResize,
  hidden,
  children,
}: {
  width: number;
  onResize: (w: number) => void;
  hidden?: boolean;
  children: React.ReactNode;
}) {
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => {
      const next = Math.max(280, Math.min(720, startW + (startX - ev.clientX)));
      onResize(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className={`relative h-full ${hidden ? "hidden" : ""}`}
      style={{ width }}
    >
      <div
        onMouseDown={startDrag}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-noir-accent/40 z-pn-dock-handle"
        title="Resize"
      />
      <div className="h-full overflow-hidden">{children}</div>
    </div>
  );
}

function DockPane({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={active ? "h-full" : "hidden"} aria-hidden={!active}>
      {children}
    </div>
  );
}

function RailButton({
  icon,
  label,
  active,
  dim,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  dim?: boolean;
  onClick: () => void;
  badge?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      role="tab"
      aria-selected={active}
      className={`relative w-7 h-7 rounded-md inline-flex items-center justify-center transition-colors ${
        active
          ? "bg-noir-accent/16 text-noir-accent shadow-[inset_0_0_0_1px_rgba(255,45,126,0.24)]"
          : "text-noir-mute hover:text-noir-text hover:bg-noir-ridge/60"
      } ${dim ? "opacity-45" : ""}`}
    >
      {active && (
        <span
          className="absolute -left-2 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-noir-accent"
          aria-hidden="true"
        />
      )}
      {icon}
      {badge}
    </button>
  );
}

/** "Something is happening in the Assistant right now" indicator.
 *  Reads from the unified store's phase machine, which spans all
 *  three modes (Ask streams, Plan loops, Agent loops). */
function RunningBadge() {
  const phase = useAssistant((s) => s.phase);
  if (phase.kind === "idle") return null;
  if (phase.kind === "awaiting_approval") {
    return (
      <span
        className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-noir-warn animate-pulse"
        aria-label="Assistant awaiting approval"
        role="status"
      />
    );
  }
  return (
    <span
      className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-noir-accent animate-pulse"
      aria-label="Assistant is running"
      role="status"
    />
  );
}

function InferenceBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    listenEvent<InferenceSnapshot>("inference:changed", (snapshot) => {
      if (alive) setCount(snapshot.active_count);
    }).then((u) => (off = u));
    const refresh = () => {
      ipc
        .inferenceStatus()
        .then((snapshot) => {
          if (alive) setCount(snapshot.active_count);
        })
        .catch(() => {
          if (alive) setCount(0);
        });
    };
    refresh();
    const id = window.setInterval(refresh, 1500);
    return () => {
      alive = false;
      off?.();
      window.clearInterval(id);
    };
  }, []);
  if (count === 0) return null;
  return (
    <span
      className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-noir-accent text-[9px] font-medium text-white flex items-center justify-center"
      aria-label={`${count} model job${count === 1 ? "" : "s"} running`}
      role="status"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function DirtyBadge() {
  const dirty = useGit((s) => s.status.dirty_count);
  if (dirty === 0) return null;
  return (
    <span
      className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-noir-accent text-[9px] font-medium text-white flex items-center justify-center"
      title={`${dirty} change${dirty === 1 ? "" : "s"}`}
      aria-label={`${dirty} uncommitted change${dirty === 1 ? "" : "s"}`}
      role="status"
    >
      {dirty > 9 ? "9+" : dirty}
    </span>
  );
}

function BreakpointBadge() {
  const count = useDebuggerStore((s) => s.breakpoints.length);
  if (count === 0) return null;
  return (
    <span
      className="absolute -top-1 -right-1 min-w-[12px] h-[12px] px-1 rounded-full bg-noir-err text-[8px] font-mono text-white flex items-center justify-center"
      aria-label={`${count} breakpoint${count === 1 ? "" : "s"}`}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}
