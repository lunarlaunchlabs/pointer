import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  Download,
  Flame,
  Key,
  Loader2,
  Power,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import {
  ipc,
  listenEvent,
  newRequestId,
  type HfTokenStatus,
  type HardwareProfile,
  type OllamaModel,
  type ResetReport,
  type UninstallReport,
} from "@/lib/ipc";
import {
  useSettings,
  featureBlockReason,
  featureCapability,
  type AiFeature,
} from "@/store/settings";
import { modelFitness } from "@/lib/modelFitness";
import { Marketplace } from "@/components/Marketplace";
import { MCPPanel } from "@/components/MCP/MCPPanel";
import { usePulls } from "@/store/pulls";
import { confirm } from "@/components/Confirm";
import { toast } from "@/components/Toast";
import { clearStore } from "@/lib/persist";
import { Switch } from "@/components/Switch";

/** Modal wrapper kept for back-compat; the body is the inline view. */
export function AIPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-pn-modal flex items-center justify-center bg-black/55 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-panel-title"
        className="w-[760px] max-w-[94vw] max-h-[88vh] rounded-2xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-noir-line flex items-center gap-3">
          <Bot size={16} className="text-noir-accent" aria-hidden="true" />
          <h2
            id="ai-panel-title"
            className="font-sans text-[14px] text-noir-text"
          >
            AI · Local model control
          </h2>
          <div className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close AI Control Panel"
            title="Close (Esc)"
            className="p-1.5 text-noir-mute hover:text-noir-text"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-hidden">
          <AIPanelView />
        </div>
        <footer className="px-5 py-3 border-t border-noir-line bg-noir-chrome/60 flex items-center justify-between">
          <span className="text-[10.5px] text-noir-mute font-sans">
            Or use the dock — this view is always one click away in the right rail.
          </span>
          <button onClick={onClose} className="pn-button-accent font-sans">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Block reason for a feature, but suppress the "off" capability — when the
 * user is staring at the toggle inside the AI Control Panel, telling them
 * "Turned off in AI Control Panel" is just noise. Every other reason
 * (missing model, no runtime, etc.) is surfaced.
 */
function reasonExceptOff(
  s: ReturnType<typeof useSettings.getState>,
  feature: AiFeature,
): string {
  if (featureCapability(feature, s) === "off") return "";
  return featureBlockReason(feature, s);
}

/** The actual AI control surface. Renders inline (right dock) and inside the modal. */
export function AIPanelView() {
  const [status, setStatus] = useState<{
    installed: boolean;
    running: boolean;
    version: string | null;
  } | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const activePulls = usePulls((s) => s.active);
  const startPull = usePulls((s) => s.start);
  const cancelPull = usePulls((s) => s.cancel);
  const clearPullError = usePulls((s) => s.clearError);
  const [pullInput, setPullInput] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [hfStatus, setHfStatus] = useState<HfTokenStatus>({
    present: false,
    location: null,
    preview: null,
    file_path: null,
    in_keychain: false,
    in_file: false,
  });
  const [hfSaving, setHfSaving] = useState(false);
  const [busy, setBusy] = useState<"start" | "stop" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [dangerBusy, setDangerBusy] = useState<
    null | "remove_models" | "uninstall_ollama" | "reset"
  >(null);
  const [dangerReport, setDangerReport] = useState<
    null
    | { kind: "uninstall"; report: UninstallReport }
    | { kind: "reset"; report: ResetReport }
  >(null);

  const setOllamaReady = useSettings((s) => s.setOllamaReady);
  const setHasHfToken = useSettings((s) => s.setHasHfToken);
  const chatModel = useSettings((s) => s.chatModel);
  const fimModel = useSettings((s) => s.fimModel);
  const agentModel = useSettings((s) => s.agentModel);
  const embedModel = useSettings((s) => s.embedModel);
  const fimEnabled = useSettings((s) => s.fimEnabled);
  const fimDebounceMs = useSettings((s) => s.fimDebounceMs);
  const setChatModel = useSettings((s) => s.setChatModel);
  const setFimModel = useSettings((s) => s.setFimModel);
  const setAgentModel = useSettings((s) => s.setAgentModel);
  const setEmbedModel = useSettings((s) => s.setEmbedModel);
  const setFimEnabled = useSettings((s) => s.setFimEnabled);
  const setFimDebounceMs = useSettings((s) => s.setFimDebounceMs);

  // Feature gates + daemon control.
  const chatEnabled = useSettings((s) => s.chatEnabled);
  const agentEnabled = useSettings((s) => s.agentEnabled);
  const inlineEditEnabled = useSettings((s) => s.inlineEditEnabled);
  const indexingEnabled = useSettings((s) => s.indexingEnabled);
  const ollamaAutostart = useSettings((s) => s.ollamaAutostart);
  const setChatEnabled = useSettings((s) => s.setChatEnabled);
  const setAgentEnabled = useSettings((s) => s.setAgentEnabled);
  const setInlineEditEnabled = useSettings((s) => s.setInlineEditEnabled);
  const setIndexingEnabled = useSettings((s) => s.setIndexingEnabled);
  const setOllamaAutostart = useSettings((s) => s.setOllamaAutostart);
  const unsetMissingModels = useSettings((s) => s.unsetMissingModels);

  // Live block reasons per feature. These derive from (chatEnabled,
  // chatModel, installedModels, ollamaReady) etc., so each selector returns
  // an empty string when the feature is healthy and a human-readable
  // explanation otherwise. The selector form means React only re-renders
  // when the reason changes, not on every settings tick.
  //
  // We intentionally ignore the `off` reason here — when the user has
  // *explicitly* turned a toggle off we shouldn't show "Turned off in AI
  // Control Panel" inside the AI Control Panel itself; that's circular.
  const chatBlock = useSettings((s) => reasonExceptOff(s, "chat"));
  const agentBlock = useSettings((s) => reasonExceptOff(s, "agent"));
  const inlineEditBlock = useSettings((s) => reasonExceptOff(s, "inlineEdit"));
  const fimBlock = useSettings((s) => reasonExceptOff(s, "fim"));
  const indexingBlock = useSettings((s) => reasonExceptOff(s, "indexing"));

  // Editor preferences.
  const editorFontSize = useSettings((s) => s.editorFontSize);
  const editorTabSize = useSettings((s) => s.editorTabSize);
  const editorWordWrap = useSettings((s) => s.editorWordWrap);
  const editorRenderWhitespace = useSettings((s) => s.editorRenderWhitespace);
  const editorFormatOnSave = useSettings((s) => s.editorFormatOnSave);
  const setEditorFontSize = useSettings((s) => s.setEditorFontSize);
  const setEditorTabSize = useSettings((s) => s.setEditorTabSize);
  const setEditorWordWrap = useSettings((s) => s.setEditorWordWrap);
  const setEditorRenderWhitespace = useSettings((s) => s.setEditorRenderWhitespace);
  const setEditorFormatOnSave = useSettings((s) => s.setEditorFormatOnSave);

  // Hardware profile is read once at mount — it changes only when the user
  // physically reseats RAM, so polling is wasteful.
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  useEffect(() => {
    ipc.hardwareProfile().then(setHardware).catch(() => setHardware(null));
  }, []);

  const visionModel = useSettings((s) => s.visionModel);
  const documentModel = useSettings((s) => s.documentModel);
  const setVisionModel = useSettings((s) => s.setVisionModel);
  const setDocumentModel = useSettings((s) => s.setDocumentModel);

  const installedNames = useMemo(() => models.map((m) => m.name), [models]);

  const refresh = async () => {
    try {
      const s = await ipc.ollamaStatus();
      setStatus(s);
      setOllamaReady(s.running);
      if (s.running) {
        const m = await ipc.ollamaListModels();
        setModels(m);
        // Mirror into the settings store so every other component / call
        // site shares the same installed-models view.
        useSettings.getState().setInstalledModels(m.map((x) => x.name));
      } else {
        setModels([]);
        useSettings.getState().setInstalledModels([]);
      }
    } catch (e) {
      console.warn(e);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    ipc.hfTokenStatus().then((s) => {
      setHfStatus(s);
      setHasHfToken(s.present);
    });
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NOTE: we intentionally do NOT auto-heal assignments when the install
  // list changes. The user explicitly asked for missing-model slots to read
  // as "unset" instead of being silently rewritten. `unsetMissingModels` is
  // called below from explicit destructive paths (delete one, delete all,
  // uninstall) — never from the background poll.

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      await ipc.ollamaStart();
      await new Promise((r) => setTimeout(r, 800));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy("stop");
    setError(null);
    try {
      const result = await ipc.ollamaStop();
      await refresh();
      // Explain exactly what happened. The Rust side now scans the process
      // table and kills foreign `ollama serve` processes too, so the result
      // tells us whether we needed to escalate.
      if (result.still_running) {
        toast.warn("Couldn't stop Ollama", {
          body:
            "The daemon is being respawned by another process — usually launchd or the Ollama menu-bar app. Quit it from there, or use the system monitor to kill the PID.",
          sticky: true,
        });
      } else if (result.killed_foreign_pids.length > 0) {
        toast.success(
          `Ollama stopped (killed PID${
            result.killed_foreign_pids.length === 1 ? "" : "s"
          } ${result.killed_foreign_pids.join(", ")})`,
        );
      } else if (result.killed_owned) {
        toast.success("Ollama stopped");
      } else {
        // Nothing to kill, API not answering — already stopped before we tried.
        toast.info("Ollama was already stopped");
      }
    } catch (e) {
      const msg = extractErrorMessage(e);
      setError(msg);
      toast.error("Stop failed", { body: msg });
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    setBusy("install");
    setError(null);
    try {
      await ipc.ollamaInstall();
      // Allow the installer to run, then poll.
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        await refresh();
        if (status?.installed) break;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pull = async (name: string) => {
    if (!name.trim()) return;
    setError(null);
    await startPull(name);
    // After the pull resolves (done or error), refresh the installed list.
    // Subscribe transiently — once the model leaves `active`, we know it's
    // settled and we can pull a fresh `ollama list`.
    const unsub = usePulls.subscribe((s) => {
      if (!s.active[name]) {
        unsub();
        refresh();
      }
    });
  };

  const saveToken = async () => {
    const trimmed = hfToken.trim();
    if (!trimmed) return;
    setHfSaving(true);
    setError(null);
    try {
      const status = await ipc.setHfToken(trimmed);
      // Confirm with a second read so we never claim success on a phantom save.
      const verify = await ipc.hfTokenStatus();
      if (!verify.present) {
        throw new Error(
          "Token didn't persist. The OS likely blocked keychain access — try again and choose 'Always allow' on the prompt.",
        );
      }
      setHfStatus(status.present ? status : verify);
      setHasHfToken(true);
      setHfToken("");
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setHfSaving(false);
    }
  };

  const clearToken = async () => {
    setError(null);
    try {
      await ipc.clearHfToken();
      const s = await ipc.hfTokenStatus();
      setHfStatus(s);
      setHasHfToken(s.present);
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  };

  const deleteModel = async (name: string) => {
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: "This removes the model from disk. You can pull it again later.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setDeletingModel(name);
    try {
      await ipc.ollamaDeleteModel(name);
      await refresh();
      // After the delete lands, unset any assignment that referenced the
      // model. We can use the freshly-loaded `models` next render, but to
      // avoid a flash of stale state we also fetch the list explicitly.
      const fresh = await ipc.ollamaListModels().catch(() => []);
      const cleared = unsetMissingModels(fresh.map((m) => m.name));
      if (cleared.length > 0) {
        toast.warn(`${cleared.length} model assignment${cleared.length === 1 ? "" : "s"} now unset`, {
          body: `${cleared.join(", ")} — pick a replacement from the Models pill.`,
        });
      } else {
        toast.success(`Removed ${name}`);
      }
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setDeletingModel(null);
    }
  };

  const removeAllModels = async () => {
    if (models.length === 0) return;
    const ok = await confirm({
      title: `Delete all ${models.length} installed model${models.length === 1 ? "" : "s"}?`,
      body: "This frees disk space. You can re-pull any of them later from this panel.",
      confirmLabel: "Delete all",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setDangerBusy("remove_models");
    try {
      for (const m of models) {
        try {
          await ipc.ollamaDeleteModel(m.name);
        } catch (e) {
          console.warn("delete model failed", m.name, e);
        }
      }
      await refresh();
      const cleared = unsetMissingModels([]);
      if (cleared.length > 0) {
        toast.warn(`${cleared.length} model assignment${cleared.length === 1 ? "" : "s"} now unset`, {
          body: cleared.join(", "),
        });
      }
    } finally {
      setDangerBusy(null);
    }
  };

  const uninstallOllama = async () => {
    const ok = await confirm({
      title: "Uninstall Ollama?",
      body: (
        <div className="space-y-2">
          <p>
            This stops the Ollama daemon, removes all locally-pulled models, and
            attempts to uninstall the Ollama binary itself.
          </p>
          <p className="text-noir-mute">
            Pointer remains installed; you can re-install Ollama from this panel
            at any time.
          </p>
        </div>
      ),
      confirmLabel: "Uninstall",
      cancelLabel: "Keep installed",
      confirmKeyword: "uninstall",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setDangerBusy("uninstall_ollama");
    try {
      const report = await ipc.ollamaUninstall(true);
      setDangerReport({ kind: "uninstall", report });
      await refresh();
      // Ollama just went away, so every assignment now points at a model
      // that physically can't exist. Reflect that as unset.
      unsetMissingModels([]);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setDangerBusy(null);
    }
  };

  const factoryReset = async () => {
    const ok = await confirm({
      title: "Reset Pointer to first launch?",
      body: (
        <div className="space-y-2">
          <p>
            Clears saved settings, recents, open tabs, and the Hugging Face
            token. The app reloads to the welcome screen.
          </p>
          <p className="text-noir-mute">
            This does <strong>not</strong> uninstall Ollama or remove your
            models.
          </p>
        </div>
      ),
      confirmLabel: "Reset",
      cancelLabel: "Keep my setup",
      confirmKeyword: "reset",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setDangerBusy("reset");
    try {
      // Step 1: wipe the JS-side store through the plugin API. This is the
      // step the old reset was missing — `tauri-plugin-store` keeps an
      // in-memory copy keyed by file path, so deleting the file from Rust
      // without telling the plugin meant the same values got rewritten on
      // the next save. Doing this first guarantees the plugin's view is
      // empty before anything else touches disk.
      try {
        await clearStore();
      } catch (e) {
        console.warn("clearStore failed (continuing with Rust-side reset)", e);
      }

      // Step 2: run the Rust-side reset for everything that lives outside
      // the plugin store (HF token, indexer cache, owned Ollama child) and
      // also delete the now-empty store file as a belt-and-suspenders.
      const report = await ipc.resetAppState({
        clear_settings: true,
        clear_hf_token: true,
        clear_index: true,
        stop_ollama: true,
      });
      setDangerReport({ kind: "reset", report });

      const failed = report.steps.filter((s) => !s.ok);
      if (failed.length > 0) {
        toast.warn("Reset finished with errors", {
          body: failed.map((s) => s.label).join(", "),
          sticky: true,
        });
      } else {
        toast.success("Pointer reset — reloading…");
      }

      // Give the user a beat to see the report, then reload.
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      const msg = extractErrorMessage(e);
      setError(msg);
      toast.error("Reset failed", { body: msg });
    } finally {
      setDangerBusy(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-noir-canvas/40">
      <header className="px-4 py-3 border-b border-noir-line bg-noir-chrome/40 flex items-center gap-3">
        <Bot size={14} className="text-noir-accent" />
        <h2 className="font-sans text-[12.5px] text-noir-text">AI control</h2>
        <div className="flex-1" />
        <button
          onClick={refresh}
          className="p-1 text-noir-mute hover:text-noir-text"
          title="Refresh runtime status"
          aria-label="Refresh runtime status"
        >
          <RefreshCw size={11} aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5 font-sans text-[12.5px]">
          {error && (
            <div className="rounded-md border border-noir-err/40 bg-noir-err/5 px-3 py-2 text-[12px] text-noir-err flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <Section title="Inference runtime" hint="Ollama daemon on 127.0.0.1:11434">
            <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <StatusDot ok={!!status?.running} pending={!!status?.installed && !status?.running} />
                <div className="min-w-0">
                  <div className="text-noir-text">
                    {!status
                      ? "Checking…"
                      : status.running
                      ? `Running · v${status.version ?? "?"}`
                      : status.installed
                      ? "Installed, not running"
                      : "Not installed"}
                  </div>
                  <div className="text-[11px] text-noir-mute">
                    Pointer will gracefully stop the daemon when it started it.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!status?.installed && (
                  <button
                    onClick={install}
                    disabled={busy !== null}
                    className="pn-button-accent font-sans flex items-center gap-1.5"
                  >
                    {busy === "install" ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Download size={11} />
                    )}
                    Install
                  </button>
                )}
                {status?.installed && !status.running && (
                  <button
                    onClick={start}
                    disabled={busy !== null}
                    className="pn-button-accent font-sans flex items-center gap-1.5"
                  >
                    {busy === "start" ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Power size={11} />
                    )}
                    Start
                  </button>
                )}
                {status?.running && (
                  <button
                    onClick={stop}
                    disabled={busy !== null}
                    className="pn-button font-sans flex items-center gap-1.5"
                    title="Stop the Ollama daemon (Pointer-owned and foreign processes)"
                  >
                    {busy === "stop" ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Power size={11} />
                    )}
                    Stop
                  </button>
                )}
              </div>
            </div>
            <ToggleRow
              label="Auto-start on app launch"
              hint="Start the daemon when Pointer opens. Disable to keep AI features off until you start it manually."
              value={ollamaAutostart}
              onChange={setOllamaAutostart}
            />
          </Section>

          <Section
            title="AI features"
            hint="Toggle individual features off — each one stops making model calls when disabled"
          >
            <div className="rounded-lg border border-noir-line divide-y divide-noir-line/60 overflow-hidden">
              <ToggleRow
                label="Chat"
                hint="The ⌘L conversational panel."
                value={chatEnabled}
                onChange={setChatEnabled}
                blockedReason={chatBlock}
              />
              <ToggleRow
                label="Agent"
                hint="Autonomous multi-step tool use."
                value={agentEnabled}
                onChange={setAgentEnabled}
                blockedReason={agentBlock}
              />
              <ToggleRow
                label="Inline edit (⌘K)"
                hint="Rewrite the current selection with a prompt."
                value={inlineEditEnabled}
                onChange={setInlineEditEnabled}
                blockedReason={inlineEditBlock}
              />
              <ToggleRow
                label="Tab completion"
                hint="Inline fill-in-the-middle suggestions while you type."
                value={fimEnabled}
                onChange={setFimEnabled}
                blockedReason={fimBlock}
              />
              <ToggleRow
                label="Codebase indexing"
                hint="Build local embeddings so @codebase can answer with context."
                value={indexingEnabled}
                onChange={setIndexingEnabled}
                blockedReason={indexingBlock}
              />
            </div>
          </Section>

          <Section
            title="Your machine"
            hint="Used to colour-code which models are realistic to run"
          >
            <HardwareCard hardware={hardware} />
          </Section>

          <Section
            title="Marketplace"
            hint="Browse, search, and install models flagged against your hardware"
          >
            <Marketplace
              hardware={hardware}
              installedModelIds={installedNames}
              ollamaRunning={!!status?.running}
              activePulls={activePulls}
              onPull={pull}
            />
          </Section>

          <Section
            title="MCP servers"
            hint="Connect external tool providers (Model Context Protocol)"
          >
            <MCPPanel />
          </Section>

          <Section
            title="Installed models"
            hint={`${models.length} on disk`}
          >
            {models.length === 0 ? (
              <div className="text-[11px] text-noir-mute">No models pulled yet.</div>
            ) : (
              <ul className="rounded-md border border-noir-line divide-y divide-noir-line/60">
                {models.map((m) => (
                  <li
                    key={m.name}
                    className="flex items-center justify-between px-3 py-2 gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[12px] text-noir-text truncate">
                        {m.name}
                      </div>
                      <div className="text-[10.5px] text-noir-mute">
                        {m.size ? formatBytes(m.size) : "—"}
                        {m.modified_at
                          ? ` · updated ${new Date(m.modified_at).toLocaleDateString()}`
                          : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteModel(m.name)}
                      disabled={deletingModel === m.name}
                      className="shrink-0 inline-flex items-center gap-1 text-[10.5px] font-sans text-noir-mute hover:text-noir-err transition-colors p-1 rounded hover:bg-noir-err/10"
                      title={`Delete ${m.name}`}
                      aria-label={`Delete ${m.name}`}
                    >
                      {deletingModel === m.name ? (
                        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 size={11} aria-hidden="true" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center gap-2">
              <input
                value={pullInput}
                onChange={(e) => setPullInput(e.target.value)}
                placeholder="qwen2.5-coder:1.5b, deepseek-coder-v2:16b, …"
                className="pn-input flex-1 font-mono"
                aria-label="Model name to pull"
                onKeyDown={(e) => {
                  if (e.key === "Enter") pull(pullInput);
                }}
              />
              <button
                onClick={() => pull(pullInput)}
                disabled={
                  !pullInput.trim() ||
                  !!activePulls[pullInput.trim()] ||
                  !status?.running
                }
                className="pn-button-accent font-sans flex items-center gap-1.5"
                title={!status?.running ? "Start Ollama first" : "Pull model"}
              >
                {activePulls[pullInput.trim()] ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Download size={11} />
                )}
                Pull
              </button>
            </div>
            {Object.values(activePulls).map((p) => (
              <div
                key={p.model}
                className={`mt-2 rounded-md border ${p.error ? "border-noir-err/40 bg-noir-err/5" : "border-noir-line bg-noir-canvas/40"} p-2`}
              >
                <div className="flex items-center justify-between mb-1 gap-2">
                  <span className="font-mono text-[11px] text-noir-text truncate">
                    {p.model}
                  </span>
                  <span className="text-[10.5px] text-noir-mute shrink-0">
                    {p.error ? "error" : `${p.status} · ${p.pct}%`}
                  </span>
                  <button
                    onClick={() =>
                      p.error ? clearPullError(p.model) : cancelPull(p.model)
                    }
                    className="text-[10px] font-sans text-noir-mute hover:text-noir-text shrink-0"
                    aria-label={`${p.error ? "Dismiss error for" : "Cancel pull of"} ${p.model}`}
                  >
                    {p.error ? "Dismiss" : "Cancel"}
                  </button>
                </div>
                {p.error ? (
                  <div className="text-[10.5px] text-noir-err font-sans break-words">
                    {p.error}
                  </div>
                ) : (
                  <div className="h-1 bg-noir-ridge rounded overflow-hidden">
                    <div
                      className="h-full bg-noir-accent transition-[width]"
                      style={{ width: `${p.pct}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </Section>

          <Section
            title="Model assignments"
            hint="Per-purpose · only installed models shown"
          >
            {/* Flex-wrap with a min-width on each card gives us a 2-up grid
                in the modal and a single column in narrow right-dock widths
                without paying for container-query support. */}
            <div className="flex flex-wrap gap-3 -m-0">
              <AssignmentCell>
                <Assignment
                  label="Chat"
                  description="Sidebar chat and ⌘K inline edits"
                  value={chatModel}
                  models={installedNames}
                  onChange={setChatModel}
                  feature="chat"
                />
              </AssignmentCell>
              <AssignmentCell>
                <Assignment
                  label="Agent"
                  description="Multi-step autonomous engineering"
                  value={agentModel}
                  models={installedNames}
                  onChange={setAgentModel}
                  feature="agent"
                />
              </AssignmentCell>
              <AssignmentCell>
                <Assignment
                  label="Tab completion (FIM)"
                  description="Ghost-text suggestions while you type"
                  value={fimModel}
                  models={installedNames}
                  onChange={setFimModel}
                  feature="fim"
                />
              </AssignmentCell>
              <AssignmentCell>
                <Assignment
                  label="Embeddings"
                  description="@codebase search indexer"
                  value={embedModel}
                  models={installedNames}
                  onChange={setEmbedModel}
                  feature="indexing"
                />
              </AssignmentCell>
              <AssignmentCell>
                <Assignment
                  label="Vision"
                  description="Required for image / scanned PDF attachments"
                  value={visionModel}
                  models={installedNames}
                  onChange={setVisionModel}
                  feature="vision"
                />
              </AssignmentCell>
              <AssignmentCell>
                <Assignment
                  label="Document"
                  description="Summarises spreadsheets, CSVs and text PDFs"
                  value={documentModel}
                  models={installedNames}
                  onChange={setDocumentModel}
                  feature="document"
                />
              </AssignmentCell>
            </div>
            <p className="mt-2 text-[10.5px] font-sans text-noir-mute leading-relaxed">
              Vision and Document models are spun up on demand when you attach
              a matching file and immediately unloaded (
              <code className="font-mono">keep_alive: 0</code>) once the file
              has been processed. Pointer never reuses your chat or agent
              model for these jobs without permission.
            </p>
          </Section>

          <Section title="Tab completion" hint="Inline suggestions powered by FIM">
            <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-noir-text flex items-center gap-1.5">
                    <Sparkles size={12} className="text-noir-accent" />
                    Tab completion
                  </div>
                  <div className="text-[11px] text-noir-mute leading-snug">
                    Ghost text from your FIM model. Press <span className="pn-kbd">Tab</span> to accept.
                  </div>
                </div>
                <Switch
                  checked={fimEnabled}
                  onChange={setFimEnabled}
                  size="md"
                  label="Tab completion"
                />
              </div>
              <div>
                <label
                  htmlFor="fim-debounce-slider"
                  className="flex items-center justify-between text-[11px] text-noir-mute mb-1"
                >
                  <span className="flex items-center gap-1">
                    <Zap size={10} aria-hidden="true" /> Debounce
                  </span>
                  <span className="font-mono">{fimDebounceMs}ms</span>
                </label>
                <input
                  id="fim-debounce-slider"
                  type="range"
                  min={40}
                  max={400}
                  step={10}
                  value={fimDebounceMs}
                  onChange={(e) => setFimDebounceMs(parseInt(e.target.value))}
                  className="w-full accent-noir-accent"
                  aria-label="Tab completion debounce in milliseconds"
                  aria-valuetext={`${fimDebounceMs} milliseconds`}
                />
                <p className="text-[10px] text-noir-mute mt-1 leading-snug">
                  Lower values feel snappier but trigger more model calls;
                  raise this on slower machines.
                </p>
              </div>
            </div>
          </Section>

          <Section title="Editor" hint="Live-applied — no restart needed">
            <div className="rounded-lg border border-noir-line divide-y divide-noir-line/60 overflow-hidden">
              <NumberRow
                label="Font size"
                hint="Monaco editor font size in pixels."
                value={editorFontSize}
                onChange={setEditorFontSize}
                min={10}
                max={28}
              />
              <NumberRow
                label="Tab size"
                hint="Spaces per tab inside the editor."
                value={editorTabSize}
                onChange={setEditorTabSize}
                min={1}
                max={8}
              />
              <ToggleRow
                label="Word wrap"
                hint="Break long lines at the editor's right edge."
                value={editorWordWrap}
                onChange={setEditorWordWrap}
              />
              <ToggleRow
                label="Show whitespace"
                hint="Render dots and arrows for spaces and tabs."
                value={editorRenderWhitespace}
                onChange={setEditorRenderWhitespace}
              />
              <ToggleRow
                label="Format on save"
                hint="Run the active language's formatter when you press ⌘S. Falls back to a built-in trim when no formatter is registered."
                value={editorFormatOnSave}
                onChange={setEditorFormatOnSave}
              />
            </div>
          </Section>

          <Section title="Hugging Face token" hint="For gated GGUF imports">
            <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <Key size={14} className="text-noir-accent shrink-0 mt-0.5" />
                <div className="min-w-0 space-y-1">
                  <div className="text-noir-text flex items-center gap-2">
                    {hfStatus.present
                      ? "Token configured"
                      : "No token configured"}
                    {hfStatus.present && hfStatus.preview && (
                      <code className="font-mono text-[11px] text-noir-subtext bg-noir-panel border border-noir-line/60 rounded px-1.5 py-[1px]">
                        {hfStatus.preview}
                      </code>
                    )}
                  </div>
                  {hfStatus.present ? (
                    <div className="text-[11px] text-noir-mute space-y-0.5">
                      <div className="flex items-center gap-2">
                        <StoreBadge label="file" on={hfStatus.in_file} />
                        <StoreBadge label="keychain" on={hfStatus.in_keychain} />
                        <span className="text-[10px]">
                          · reads from <strong>{hfStatus.location}</strong>
                        </span>
                      </div>
                      {hfStatus.file_path && (
                        <div
                          className="font-mono text-[10px] text-noir-mute truncate max-w-[420px]"
                          title={hfStatus.file_path}
                        >
                          {hfStatus.file_path}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-noir-mute">
                      Only needed to pull gated repos (e.g. Llama, Gemma).
                      {hfStatus.file_path && (
                        <span className="block font-mono text-[10px] mt-0.5 truncate max-w-[420px]">
                          Would save to: {hfStatus.file_path}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {hfStatus.present && (
                <button
                  onClick={clearToken}
                  className="pn-button font-sans flex items-center gap-1.5 shrink-0"
                >
                  <Trash2 size={11} />
                  Clear
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                value={hfToken}
                onChange={(e) => setHfToken(e.target.value)}
                placeholder={hfStatus.present ? "Replace token (hf_…)" : "hf_…"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveToken();
                }}
                className="pn-input flex-1 font-mono"
                aria-label="Hugging Face access token"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                onClick={saveToken}
                disabled={!hfToken.trim() || hfSaving}
                className="pn-button-accent font-sans inline-flex items-center gap-1.5"
              >
                {hfSaving && <Loader2 size={11} className="animate-spin" />}
                {hfSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </Section>

          <Section title="Danger zone" hint="Destructive actions">
            <div className="rounded-lg border border-noir-err/30 bg-noir-err/[0.04] divide-y divide-noir-err/20">
              <DangerRow
                icon={<Trash2 size={13} className="text-noir-err" />}
                title="Remove all models"
                body={`Frees ${models.length === 0 ? "no" : models.length} model${models.length === 1 ? "" : "s"} on disk. Re-pull anytime.`}
                action="Remove all"
                onClick={removeAllModels}
                disabled={models.length === 0 || dangerBusy !== null}
                busy={dangerBusy === "remove_models"}
              />
              <DangerRow
                icon={<Flame size={13} className="text-noir-err" />}
                title="Uninstall Ollama"
                body="Stops the daemon, removes ~/.ollama (all models), the ollama binary, and the macOS app bundle. Type 'uninstall' to confirm."
                action="Uninstall"
                onClick={uninstallOllama}
                disabled={!status?.installed || dangerBusy !== null}
                busy={dangerBusy === "uninstall_ollama"}
              />
              <DangerRow
                icon={<RotateCcw size={13} className="text-noir-err" />}
                title="Reset Pointer to first launch"
                body="Wipes saved settings, recents, open tabs, HF token, and index. Pointer reloads to the welcome wizard. Does not uninstall Ollama or your models."
                action="Reset"
                onClick={factoryReset}
                disabled={dangerBusy !== null}
                busy={dangerBusy === "reset"}
              />
            </div>
            {dangerReport && (
              <DangerReport
                report={dangerReport}
                onDismiss={() => setDangerReport(null)}
              />
            )}
          </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[11px] uppercase tracking-wider text-noir-mute shrink-0">
          {title}
        </h3>
        {hint && (
          <span className="text-[10.5px] text-noir-mute min-w-0 text-right">
            {hint}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  blockedReason,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /**
   * When non-empty, the row renders as "effectively off" even if the user's
   * stored preference is on. The Switch visually shows off, the row gets a
   * warning swatch explaining *why*, and the user can still flip the
   * underlying preference. The moment the block clears (e.g. they pick a
   * model), the toggle pops back to its persisted value automatically.
   */
  blockedReason?: string;
}) {
  const blocked = !!blockedReason;
  const effective = value && !blocked;
  return (
    <div className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-noir-ridge/30 transition-colors select-none">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="min-w-0 pr-3 text-left flex-1 cursor-pointer"
      >
        <div className="font-sans text-[12px] text-noir-text flex items-center gap-1.5">
          {label}
          {blocked && (
            <span className="text-[9.5px] uppercase tracking-wider text-noir-warn font-medium">
              · off
            </span>
          )}
        </div>
        {blocked ? (
          <div className="font-sans text-[10.5px] text-noir-warn leading-snug mt-0.5">
            {blockedReason}
          </div>
        ) : (
          hint && (
            <div className="font-sans text-[10.5px] text-noir-mute leading-snug mt-0.5">
              {hint}
            </div>
          )
        )}
      </button>
      <Switch checked={effective} onChange={onChange} label={label} />
    </div>
  );
}

function HardwareCard({ hardware }: { hardware: HardwareProfile | null }) {
  if (!hardware) {
    return (
      <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 text-[11.5px] text-noir-mute">
        Reading machine specs…
      </div>
    );
  }
  const totalGb = hardware.total_ram_bytes / (1024 ** 3);
  const availGb = hardware.available_ram_bytes / (1024 ** 3);
  const usedPct = Math.max(
    0,
    Math.min(100, ((totalGb - availGb) / totalGb) * 100),
  );
  // Conservative ceilings: assume Q4-quant models, leave 4GB headroom for the
  // OS + Pointer itself. These numbers map to what we actually ship in
  // recommend_models, so the messaging stays internally consistent.
  const safeHeadGb = Math.max(0, totalGb - 4);
  const safe7b = safeHeadGb >= 6;
  const safe14b = safeHeadGb >= 12;
  const safe32b = safeHeadGb >= 24;
  const cpuLabel = hardware.cpu_brand || hardware.cpu_name || "CPU";
  return (
    <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 space-y-2 font-sans">
      {/* flex-wrap reflows from 3-up → 2-up → 1-up as the panel narrows. */}
      <div className="flex flex-wrap gap-2">
        <SpecCell>
          <Spec label="RAM" value={`${totalGb.toFixed(0)} GB`} sub={`${availGb.toFixed(1)} GB free`} />
        </SpecCell>
        <SpecCell>
          <Spec label="CPU" value={`${hardware.cpu_count} cores`} sub={truncateLabel(cpuLabel, 28)} />
        </SpecCell>
        <SpecCell>
          <Spec
            label="GPU"
            value={hardware.gpu_label ?? "CPU only"}
            sub={hardware.arch}
          />
        </SpecCell>
      </div>
      <div className="h-1.5 bg-noir-ridge rounded-full overflow-hidden">
        <div
          className={`h-full ${
            usedPct > 85
              ? "bg-noir-err"
              : usedPct > 65
              ? "bg-noir-warn"
              : "bg-noir-accent"
          } transition-[width]`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <div className="text-[10.5px] text-noir-mute">
        Headroom suggests up to{" "}
        <strong className="text-noir-text">
          {safe32b ? "32B" : safe14b ? "14B" : safe7b ? "7B" : "3B"}
        </strong>{" "}
        Q4-quant models at comfortable speed.{" "}
        {hardware.gpu_label
          ? "Ollama will use your GPU automatically when supported."
          : "No discrete GPU detected — inference will run on CPU; smaller models will feel best."}
      </div>
    </div>
  );
}

function SpecCell({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 min-w-[120px] basis-[120px]">{children}</div>;
}

function Spec({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-noir-line/60 bg-noir-panel/60 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-noir-mute">{label}</div>
      <div className="text-[12px] text-noir-text truncate" title={value}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-noir-mute truncate">{sub}</div>}
    </div>
  );
}

function truncateLabel(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function NumberRow({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  // Stable id so the label correctly associates with the input even when
  // the same NumberRow is rendered multiple times in a page.
  const id = `num-row-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="w-full flex items-center justify-between gap-3 px-3 py-2">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <div className="font-sans text-[12px] text-noir-text">{label}</div>
        {hint && (
          <div className="font-sans text-[10.5px] text-noir-mute">{hint}</div>
        )}
      </label>
      <input
        id={id}
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="pn-input w-16 font-mono text-right"
      />
    </div>
  );
}

/** A single cell in the responsive assignments wrap layout. min-w gives each
 *  card enough room for the dropdown trigger; flex-1 lets pairs fill to 50%
 *  when there's room. */
function AssignmentCell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-[200px] basis-[200px]">{children}</div>
  );
}

function Assignment({
  label,
  description,
  value,
  models,
  onChange,
  feature,
}: {
  label: string;
  description?: string;
  value: string;
  models: string[];
  onChange: (v: string) => void;
  /** Which AI capability this slot powers — used for fitness scoring. */
  feature: AiFeature;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const unset = !value;
  const missing = !unset && models.length > 0 && !models.includes(value);
  const flag = unset || missing;
  // Score the current pick. We hide the chip entirely for "good" — silence
  // is the reward for picking well. For "ok" and "warn" we show the
  // small chip with the reason as a tooltip and an expanded line below.
  const fit = value ? modelFitness(value, feature) : null;
  const showFitness = fit && fit.level !== "good" && !flag;

  // The AIPanel modal uses `backdrop-blur-md` *and* its body is scrollable
  // (`overflow-y-auto`). Either alone is enough to wreck an in-flow
  // dropdown — the blur establishes a stacking context that bounds any
  // z-index, and the scrollable parent clips absolute descendants at its
  // edge. Together they make a dropdown opened on the bottom row of the
  // assignments grid disappear behind / under the rest of the modal.
  //
  // The fix is the same one we used for the titlebar Models popover:
  // portal the popover out to `document.body` and position it with
  // `fixed` coordinates relative to the trigger. That breaks free of both
  // the blur context and the scroll clip, while letting it stack at the
  // dedicated `z-pn-modal-popover` layer (= 80) — above the modal at 70
  // but below context menus and toasts.
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords({
        left: r.left,
        // 4px gap so the popover doesn't kiss the trigger border.
        top: r.bottom + 4,
        // Match the trigger width so the popover doesn't look like a
        // detached island when the assignments wrap into a narrow column.
        width: r.width,
      });
    };
    recompute();
    window.addEventListener("resize", recompute);
    // Scroll events come from the modal's scrollable body, not the
    // window. We listen with capture so we catch them as they bubble up
    // through *any* ancestor.
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

  const popover =
    open && coords ? (
      <div
        ref={popoverRef}
        style={{
          position: "fixed",
          left: coords.left,
          top: coords.top,
          width: coords.width,
          // Hard upper bound on width keeps very wide trigger cells
          // (full-width assignment row on small viewports) from
          // creating a comically wide menu.
          maxWidth: "min(420px, calc(100vw - 1rem))",
        }}
        className="max-h-56 overflow-y-auto bg-noir-panel border border-noir-line rounded-md shadow-soft z-pn-modal-popover"
      >
        {models.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-noir-mute">
            Pull a model above to choose it here.
          </div>
        ) : (
          models.map((m) => {
            const optFit = modelFitness(m, feature);
            return (
              <button
                key={m}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-[12px] font-mono hover:bg-noir-ridge flex items-center gap-2 ${
                  m === value ? "text-noir-accent" : "text-noir-text"
                }`}
                title={optFit.reason || `Use ${m} for ${label.toLowerCase()}`}
              >
                <span className="truncate flex-1">{m}</span>
                {optFit.level === "warn" && (
                  <span className="text-[9px] uppercase tracking-wider text-noir-warn shrink-0">
                    mismatch
                  </span>
                )}
                {optFit.level === "ok" && (
                  <span className="text-[9px] uppercase tracking-wider text-noir-mute shrink-0">
                    workable
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    ) : null;

  return (
    <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-2.5">
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <div className="text-[10.5px] text-noir-text font-medium">{label}</div>
        {unset && <span className="text-[9.5px] text-noir-warn">not set</span>}
        {missing && (
          <span className="text-[9.5px] text-noir-warn">missing</span>
        )}
        {showFitness && fit && (
          <span
            className={`text-[9.5px] font-medium uppercase tracking-wider ${
              fit.level === "warn" ? "text-noir-warn" : "text-noir-subtext"
            }`}
            title={fit.reason}
          >
            {fit.level === "warn" ? "mismatch" : "workable"}
          </span>
        )}
      </div>
      {description && (
        <div className="text-[10px] text-noir-mute mb-1.5">{description}</div>
      )}
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between px-2 py-1.5 rounded border ${
          flag
            ? "border-noir-warn/40 bg-noir-warn/5 text-noir-warn"
            : showFitness && fit?.level === "warn"
            ? "border-noir-warn/30 bg-noir-warn/[0.03] text-noir-text hover:border-noir-warn/60"
            : "border-noir-line bg-noir-panel text-noir-text hover:border-noir-accent/40"
        }`}
        title={
          unset
            ? `Pick a ${label.toLowerCase()} model`
            : missing
            ? `${value} isn't installed — pick another or pull it from above`
            : fit && fit.level !== "good"
            ? fit.reason
            : "Change model"
        }
      >
        <span className="font-mono text-[12px] truncate">
          {unset ? "— not set —" : value}
        </span>
        <ChevronDown size={11} className="shrink-0 opacity-70" />
      </button>
      {/* Fitness explainer — expanded form for the worst cases. */}
      {showFitness && fit && fit.level === "warn" && (
        <div className="mt-1.5 text-[10px] text-noir-warn/90 leading-snug">
          {fit.reason}
        </div>
      )}
      {popover && createPortal(popover, document.body)}
    </div>
  );
}

function StoreBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[9.5px] font-sans uppercase tracking-wider ${
        on
          ? "border-noir-ok/40 bg-noir-ok/10 text-noir-ok"
          : "border-noir-line bg-noir-canvas/40 text-noir-mute"
      }`}
      title={on ? `Token is present in ${label}` : `Token is NOT in ${label}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          on ? "bg-noir-ok" : "bg-noir-mute"
        }`}
      />
      {label}
    </span>
  );
}

function StatusDot({ ok, pending }: { ok: boolean; pending?: boolean }) {
  return (
    <div
      className={`h-2.5 w-2.5 rounded-full ${
        ok ? "bg-noir-ok" : pending ? "bg-noir-warn animate-pulse" : "bg-noir-mute"
      }`}
    />
  );
}

function DangerRow({
  icon,
  title,
  body,
  action,
  onClick,
  disabled,
  busy,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="px-3 py-2.5 flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-noir-text text-[12.5px]">{title}</div>
        <div className="text-[10.5px] text-noir-mute">{body}</div>
      </div>
      <button
        onClick={onClick}
        disabled={disabled || busy}
        className="pn-button font-sans inline-flex items-center gap-1.5 border-noir-err/40 text-noir-err hover:bg-noir-err/10"
      >
        {busy && <Loader2 size={11} className="animate-spin" />}
        <TriangleAlert size={11} />
        {action}
      </button>
    </div>
  );
}

function DangerReport({
  report,
  onDismiss,
}: {
  report:
    | { kind: "uninstall"; report: UninstallReport }
    | { kind: "reset"; report: ResetReport };
  onDismiss: () => void;
}) {
  const steps = report.report.steps;
  const allOk = steps.every((s) => s.ok);
  return (
    <div
      className={`mt-2 rounded-md border px-3 py-2 ${
        allOk ? "border-noir-ok/40 bg-noir-ok/5" : "border-noir-warn/40 bg-noir-warn/5"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-sans text-noir-text">
          {report.kind === "uninstall" ? "Uninstall report" : "Reset report"}
        </span>
        <button
          onClick={onDismiss}
          className="text-noir-mute hover:text-noir-text"
          aria-label="Dismiss"
        >
          <X size={11} />
        </button>
      </div>
      <ul className="space-y-0.5">
        {steps.map((s, i) => (
          <li key={i} className="text-[11px] font-mono text-noir-subtext flex items-start gap-1.5">
            {s.ok ? (
              <Check size={11} className="text-noir-ok mt-0.5 shrink-0" />
            ) : (
              <X size={11} className="text-noir-err mt-0.5 shrink-0" />
            )}
            <span className="text-noir-text">{s.label}</span>
            {s.message && <span className="text-noir-mute">— {s.message}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function extractErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  // Tauri command errors come through as { Msg: "..." } / { Keyring: "..." } /
  // raw strings — surface the first usable string.
  try {
    const s = JSON.stringify(e);
    return s.length > 280 ? s.slice(0, 280) + "…" : s;
  } catch {
    return String(e);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
