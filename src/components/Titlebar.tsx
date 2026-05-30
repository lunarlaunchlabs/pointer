import { useEffect, useLayoutEffect, useRef, useState } from "@/lib/preactSignalCompat";
import { createPortal } from "@/lib/preactSignalDomCompat";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bot,
  ChevronDown,
  FileText,
  Folder,
  GitBranch as GitBranchIcon,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  ScrollText,
  Sparkles,
  Type,
} from "@/lib/lucide";
import { useWorkspace } from "@/store/workspace";
import {
  isModelInInstalledList,
  useSettings,
  type AiFeature,
} from "@/store/settings";
import { useGit } from "@/store/git";
import { ipc } from "@/lib/ipc";
import { modelFitness } from "@/lib/modelFitness";
import { PointerMarkSvg } from "@/components/BrandLogo";

type Purpose = "chat" | "agent" | "fim" | "embed" | "vision" | "document";

export function Titlebar({
  onOpenAIPanel,
}: {
  onOpenAIPanel: () => void;
}) {
  const root = useWorkspace((s) => s.root);
  const openFolder = useWorkspace((s) => s.openFolder);
  const chatModel = useSettings((s) => s.chatModel);
  const agentModel = useSettings((s) => s.agentModel);
  const fimModel = useSettings((s) => s.fimModel);
  const embedModel = useSettings((s) => s.embedModel);
  const visionModel = useSettings((s) => s.visionModel);
  const documentModel = useSettings((s) => s.documentModel);
  const ollamaReady = useSettings((s) => s.ollamaReady);
  const setOllamaReady = useSettings((s) => s.setOllamaReady);
  const setChatModel = useSettings((s) => s.setChatModel);
  const setAgentModel = useSettings((s) => s.setAgentModel);
  const setFimModel = useSettings((s) => s.setFimModel);
  const setEmbedModel = useSettings((s) => s.setEmbedModel);
  const setVisionModel = useSettings((s) => s.setVisionModel);
  const setDocumentModel = useSettings((s) => s.setDocumentModel);
  const setInstalledModels = useSettings((s) => s.setInstalledModels);
  const [models, setModels] = useState<string[]>([]);

  // Poll Ollama status / installed list. Critically, this does NOT mutate
  // the user's model assignments anymore — silent re-assignment was hiding
  // unset state from the UI. If a saved model isn't installed, the picker
  // simply renders it as missing so the user can choose what to do.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await ipc.ollamaStatus();
        if (!alive) return;
        setOllamaReady(s.running);
        if (s.running) {
          const list = await ipc.ollamaListModels().catch(() => []);
          if (!alive) return;
          const names = list.map((m) => m.name);
          setModels(names);
          // Publish to the global settings store so every feature gate
          // (chat send, agent send, FIM, indexing, UI toggles, status bar)
          // reads from a single source of truth.
          setInstalledModels(names);
        } else {
          setModels([]);
          setInstalledModels([]);
        }
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setOllamaReady, setInstalledModels]);

  const startDrag = async () => {
    try {
      await getCurrentWindow().startDragging();
    } catch {
      /* not in tauri */
    }
  };

  const folderName = root?.split(/[\\/]/).pop() ?? "No folder";

  const assignments: { purpose: Purpose; label: string; model: string; icon: React.ReactNode; set: (m: string) => void }[] =
    [
      {
        purpose: "chat",
        label: "Chat",
        model: chatModel,
        icon: <MessageSquare size={11} />,
        set: setChatModel,
      },
      {
        purpose: "agent",
        label: "Agent",
        model: agentModel,
        icon: <ScrollText size={11} />,
        set: setAgentModel,
      },
      {
        purpose: "fim",
        label: "Tab",
        model: fimModel,
        icon: <Type size={11} />,
        set: setFimModel,
      },
      {
        purpose: "embed",
        label: "Embed",
        model: embedModel,
        icon: <Layers size={11} />,
        set: setEmbedModel,
      },
      {
        purpose: "vision",
        label: "Vision",
        model: visionModel,
        icon: <ImageIcon size={11} />,
        set: setVisionModel,
      },
      {
        purpose: "document",
        label: "Doc",
        model: documentModel,
        icon: <FileText size={11} />,
        set: setDocumentModel,
      },
    ];

  const anyMissing =
    ollamaReady &&
    models.length > 0 &&
    assignments.some((a) => a.model && !isModelInInstalledList(a.model, models));

  return (
    <header
      data-tauri-drag-region
      onMouseDown={startDrag}
      className="pn-titlebar h-[40px] min-h-[40px] flex items-center justify-between px-4 pt-[4px] pb-[3px] select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      aria-label="Title bar"
    >
      <div className="flex items-center gap-3 pl-16 min-w-0 flex-1">
        <span className="inline-flex items-center gap-2 shrink-0">
          <PointerMarkSvg
            decorative
            glow={false}
            className="pn-brand-mark h-5 w-5"
          />
        </span>
        <button
          onClick={openFolder}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-sans text-[12px] text-noir-subtext hover:bg-noir-ridge/50 hover:text-noir-text transition-colors min-w-0"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={folderName}
          aria-label={`Open folder. Current workspace: ${folderName}`}
        >
          <Folder size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{folderName}</span>
        </button>
        <GitBranchPill />
      </div>
      <div
        className="flex items-center gap-2 shrink-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={onOpenAIPanel}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors ${
            ollamaReady
              ? "border-noir-ok/30 bg-noir-ok/5 hover:bg-noir-ok/10 shadow-[0_0_18px_-14px_rgba(124,240,189,0.95)]"
              : "border-noir-line/80 bg-noir-panel/75 hover:bg-noir-ridge"
          }`}
          title={ollamaReady ? "Ollama ready — click to open AI Control Panel (⌘,)" : "Ollama offline — click to open AI Control Panel (⌘,)"}
          aria-label={`Inference runtime ${ollamaReady ? "ready" : "offline"}. Open AI Control Panel.`}
        >
          <Bot
            size={12}
            aria-hidden="true"
            className={ollamaReady ? "text-noir-ok" : "text-noir-mute"}
          />
          <span className="hidden md:inline font-sans text-[11px] text-noir-subtext">
            {ollamaReady ? "Local · ready" : "Local · offline"}
          </span>
        </button>
        <ModelsPill
          assignments={assignments}
          installedModels={models}
          ollamaReady={ollamaReady}
          anyMissing={anyMissing}
          onOpenAIPanel={onOpenAIPanel}
        />
      </div>
    </header>
  );
}

function ModelsPill({
  assignments,
  installedModels,
  ollamaReady,
  anyMissing,
  onOpenAIPanel,
}: {
  assignments: {
    purpose: Purpose;
    label: string;
    model: string;
    icon: React.ReactNode;
    set: (m: string) => void;
  }[];
  installedModels: string[];
  ollamaReady: boolean;
  anyMissing: boolean;
  onOpenAIPanel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );

  // The titlebar uses `backdrop-blur`, which establishes a CSS stacking
  // context. Any `z-index` we set on a child is *bounded* by that context —
  // and the titlebar's stacking context itself sits at z-auto in the App
  // root, which means everything painted later in DOM order (editor, dock,
  // status bar) covers our popover. The fix is to portal the popover to
  // `document.body` so it escapes that trap entirely.
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords({
        top: r.bottom + 4, // 4px gap below the trigger
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      // Click is fine if it lands on the trigger or anywhere inside the
      // portaled popover — both are part of "this widget" even though
      // they're in different DOM subtrees now.
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Compact summary — show unique non-empty model names so when one model
  // serves all purposes the user sees a clean badge instead of duplicates.
  // Empty strings (unset slots) collapse out so the badge doesn't pretend a
  // slot is configured.
  //
  // When the runtime is *up* we additionally drop any slot whose model
  // isn't currently installed — those are surfaced as warnings in the
  // popover, but on the truncated titlebar chip they would otherwise read
  // as if the model were active, which is the "lying about state" UX the
  // user asked us to fix. When the runtime is *down* we can't verify
  // membership (`installedModels` is empty by definition), so we fall back
  // to the raw configured names so the chip still tells the user what's
  // wired up — the offline indicator to the left already explains why
  // nothing is actually running.
  const isLive = (m: string) =>
    !!m && (!ollamaReady || isModelInInstalledList(m, installedModels));
  const effectiveModels = assignments
    .map((a) => (isLive(a.model) ? a.model : ""))
    .filter(Boolean);
  const uniqueModels = Array.from(new Set(effectiveModels));
  // A slot is "needs attention" if it's unset OR set-but-uninstalled; in
  // either case we don't have a working model for that purpose.
  const anyUnset = assignments.some(
    (a) =>
      !a.model ||
      (ollamaReady && !isModelInInstalledList(a.model, installedModels)),
  );
  const summary =
    uniqueModels.length === 0
      ? "no models picked"
      : uniqueModels.length === 1
      ? uniqueModels[0]
      : `${uniqueModels.length} models`;

  const popover =
    open && coords ? (
      <div
        ref={popoverRef}
        // `position: fixed` + portal to body bypasses every ancestor
        // stacking context (titlebar's backdrop-blur, the dock, etc.). The
        // z value is set globally now, so it sits above main chrome but
        // still below true modals (palette / confirm / etc.).
        style={{
          position: "fixed",
          top: coords.top,
          right: coords.right,
          maxWidth: "calc(100vw - 1rem)",
        }}
        className="pn-premium-panel w-80 rounded-md shadow-soft z-pn-titlebar-popover overflow-hidden"
      >
        <div className="px-3 py-2 border-b border-noir-line/60 flex items-center justify-between">
          <span className="text-[10.5px] text-noir-mute font-sans uppercase tracking-wider">
            Model assignments
          </span>
          <button
            onClick={() => {
              onOpenAIPanel();
              setOpen(false);
            }}
            className="text-[10.5px] text-noir-accent hover:text-noir-text font-sans"
          >
            Manage…
          </button>
        </div>
        <div className="divide-y divide-noir-line/40 max-h-[70vh] overflow-y-auto">
          {assignments.map((a) => (
            <AssignmentRow
              key={a.purpose}
              label={a.label}
              icon={a.icon}
              model={a.model}
              installedModels={installedModels}
              ollamaReady={ollamaReady}
              onChange={a.set}
              feature={purposeToFeature(a.purpose)}
            />
          ))}
        </div>
      </div>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Model assignments: ${summary}${anyMissing || anyUnset ? ". Needs attention." : ""}. Click to manage.`}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors border ${
          anyMissing || anyUnset
            ? "border-noir-warn/40 bg-noir-warn/5 hover:bg-noir-warn/10"
            : "border-noir-line/0 bg-noir-panel/40 hover:border-noir-line/70 hover:bg-noir-ridge/70"
        }`}
        title="Per-purpose model assignments"
      >
        <Sparkles
          size={11}
          aria-hidden="true"
          className={`shrink-0 ${anyMissing || anyUnset ? "text-noir-warn" : "text-noir-accent"}`}
        />
        <span
          className={`hidden sm:inline font-sans text-[11px] max-w-[160px] truncate ${
            anyMissing || anyUnset ? "text-noir-warn" : "text-noir-subtext"
          }`}
        >
          Models · <span className="font-mono">{summary}</span>
        </span>
        <ChevronDown
          size={10}
          aria-hidden="true"
          className={`opacity-70 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {popover && createPortal(popover, document.body)}
    </>
  );
}

function purposeToFeature(p: Purpose): AiFeature {
  // The titlebar's Purpose enum predates AiFeature; this is a 1:1 mapping
  // except for "embed" -> "indexing". Centralising it here keeps the rest
  // of the file readable.
  if (p === "embed") return "indexing";
  return p;
}

function AssignmentRow({
  label,
  icon,
  model,
  installedModels,
  ollamaReady,
  onChange,
  feature,
}: {
  label: string;
  icon: React.ReactNode;
  model: string;
  installedModels: string[];
  ollamaReady: boolean;
  onChange: (m: string) => void;
  feature: AiFeature;
}) {
  const [open, setOpen] = useState(false);
  const unset = !model;
  const missing =
    !unset &&
    ollamaReady &&
    installedModels.length > 0 &&
    !isModelInInstalledList(model, installedModels);
  const flag = unset || missing;
  const fit = model ? modelFitness(model, feature) : null;
  // Only call attention when the user has a "real" model assigned and we
  // think it's the wrong tool. We don't double-flag missing/unset (the
  // capability gate handles those already).
  const fitWarn = fit && fit.level === "warn" && !flag;

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 text-[10.5px] font-sans uppercase tracking-wider w-14 ${
            flag ? "text-noir-warn" : fitWarn ? "text-noir-warn" : "text-noir-mute"
          }`}
        >
          {icon}
          {label}
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`${label} model: ${unset ? "not set" : model}. Click to change.`}
          className={`flex-1 flex items-center justify-between px-2 py-1 rounded border min-w-0 ${
            flag
              ? "border-noir-warn/40 bg-noir-warn/5 text-noir-warn"
              : fitWarn
              ? "border-noir-warn/30 bg-noir-warn/[0.03] text-noir-text hover:border-noir-warn/60"
              : "border-noir-line bg-noir-canvas/40 text-noir-text hover:border-noir-accent/40"
          }`}
          title={
            unset
              ? `No ${label.toLowerCase()} model picked — choose one.`
              : missing
              ? `${model} isn't installed — pick another or pull it from the AI panel.`
              : fit && fit.level !== "good"
              ? fit.reason
              : `Change ${label.toLowerCase()} model`
          }
        >
          <span className="font-mono text-[11.5px] truncate">
            {unset ? "— not set —" : model}
          </span>
          <ChevronDown size={10} aria-hidden="true" className="opacity-70 shrink-0 ml-1.5" />
        </button>
      </div>
      {fitWarn && fit && (
        <div className="mt-1 ml-16 text-[10px] text-noir-warn/90 leading-snug">
          {fit.reason}
        </div>
      )}
      {open && (
        <div className="mt-1 max-h-44 overflow-y-auto bg-noir-canvas/60 border border-noir-line rounded-md">
          {installedModels.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-noir-mute font-sans">
              No models installed.
            </div>
          ) : (
            installedModels.map((m) => {
              const optFit = modelFitness(m, feature);
              return (
                <button
                  key={m}
                  onClick={() => {
                    onChange(m);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-[11.5px] font-mono hover:bg-noir-ridge flex items-center gap-2 ${
                    m === model ? "text-noir-accent" : "text-noir-text"
                  }`}
                  title={optFit.reason || `Use ${m} for ${label.toLowerCase()}`}
                >
                  <span className="truncate flex-1">{m}</span>
                  {optFit.level === "warn" && (
                    <span className="text-[9px] uppercase tracking-wider text-noir-warn shrink-0">
                      mismatch
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Git branch pill. Hidden entirely when the workspace isn't a git repo —
 * developers without git installed (or working in non-git folders) should
 * not see a misleading badge. Kept very compact so we never compete with
 * the model assignments pill for attention.
 */
function GitBranchPill() {
  const isRepo = useGit((s) => s.status.is_repo);
  const branch = useGit((s) => s.status.branch);
  const dirty = useGit((s) => s.status.dirty_count);
  const ahead = useGit((s) => s.status.ahead ?? 0);
  const behind = useGit((s) => s.status.behind ?? 0);
  if (!isRepo) return null;
  const title = [
    branch ?? "(detached)",
    dirty > 0 ? `${dirty} file${dirty === 1 ? "" : "s"} changed` : "clean",
    ahead > 0 ? `${ahead} ahead` : null,
    behind > 0 ? `${behind} behind` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className="hidden md:inline-flex items-center gap-1 px-1.5 py-[1px] rounded border border-noir-line/70 bg-noir-canvas/40 text-[11px] font-mono text-noir-subtext shrink-0 min-w-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]"
      title={title}
      role="status"
      aria-label={`Git: ${title}`}
    >
      <GitBranchIcon size={10} className="shrink-0 opacity-70" aria-hidden="true" />
      <span className="truncate max-w-[140px]">{branch ?? "detached"}</span>
      {dirty > 0 && (
        <span className="text-noir-warn font-medium shrink-0" aria-hidden="true">●</span>
      )}
      {(ahead > 0 || behind > 0) && (
        <span className="text-noir-mute shrink-0" aria-hidden="true">
          {ahead > 0 ? `↑${ahead}` : ""}
          {behind > 0 ? `↓${behind}` : ""}
        </span>
      )}
    </span>
  );
}
