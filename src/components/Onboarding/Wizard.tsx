import { useEffect, useState } from "@/lib/preactSignalCompat";
import {
  Check,
  ChevronLeft,
  Download,
  Loader2,
  Palette,
  Server,
  Sparkles,
  ChevronRight,
  AlertCircle,
} from "@/lib/lucide";
import { ipc, type ModelRecommendation } from "@/lib/ipc";
import {
  isModelInInstalledList,
  resolveInstalledModelName,
  useSettings,
} from "@/store/settings";
import { usePulls } from "@/store/pulls";
import { confirm } from "@/components/Confirm";
import { PointerMarkSvg, PointerWordmarkSvg } from "@/components/BrandLogo";
import { POINTER_THEMES, type AppThemeId } from "@/theme/themes";

type Step = "intro" | "theme" | "ollama" | "models" | "done";
const ORDER: Step[] = ["intro", "theme", "ollama", "models", "done"];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("intro");
  // Mirrors live state from substeps so the footer can lock Skip while
  // something important (an install, a pull) is happening.
  const [busy, setBusy] = useState(false);
  const onboarded = useSettings((s) => s.onboarded);

  const idx = ORDER.indexOf(step);
  const canBack = idx > 0 && step !== "done";
  const goBack = () => {
    if (canBack) setStep(ORDER[idx - 1]);
  };

  const handleSkip = async () => {
    if (busy) {
      const ok = await confirm({
        title: "Skip setup while a task is running?",
        body: "An install or download is in progress. Skipping won't cancel it, but you won't see its progress in the wizard anymore.",
        confirmLabel: "Skip anyway",
        cancelLabel: "Keep going",
      });
      if (!ok) return;
    }
    onDone();
  };

  return (
    <div className="fixed inset-0 z-pn-modal bg-black/60 backdrop-blur-md flex items-center justify-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="pn-premium-panel w-[640px] max-w-[92vw] rounded-lg shadow-soft overflow-hidden"
      >
        <header className="px-5 py-4 border-b border-noir-line/70 flex items-center gap-3">
          <PointerMarkSvg
            decorative
            className="pn-brand-mark h-5 w-5 rounded-md"
          />
          <h2
            id="onboarding-title"
            className="font-sans text-[14px] text-noir-text"
          >
            {onboarded ? "Review Pointer setup" : "Welcome to Pointer"}
          </h2>
          <div className="flex-1" />
          <Stepper step={step} />
        </header>

        <div className="p-6 min-h-[280px]">
          {step === "intro" && (
            <Intro rerun={onboarded} onNext={() => setStep("theme")} />
          )}
          {step === "theme" && (
            <ThemeStep onNext={() => setStep("ollama")} />
          )}
          {step === "ollama" && (
            <OllamaStep
              onBusyChange={setBusy}
              onNext={() => setStep("models")}
            />
          )}
          {step === "models" && (
            <ModelsStep
              onBusyChange={setBusy}
              onNext={() => setStep("done")}
            />
          )}
          {step === "done" && <Done onClose={onDone} />}
        </div>

        <footer className="px-5 py-3 bg-noir-chrome/70 border-t border-noir-line/70 flex items-center justify-between gap-3">
          {canBack ? (
            <button
              onClick={goBack}
              className="text-[11px] font-sans text-noir-subtext hover:text-noir-text flex items-center gap-1"
            >
              <ChevronLeft size={11} /> Back
            </button>
          ) : (
            <span />
          )}
          {step !== "done" && (
            <button
              onClick={handleSkip}
              className="text-[11px] font-sans text-noir-mute hover:text-noir-text"
            >
              Skip setup
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const order: Step[] = ORDER;
  const idx = order.indexOf(step);
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={order.length}
      aria-valuenow={idx + 1}
      aria-valuetext={`Step ${idx + 1} of ${order.length}: ${step}`}
      aria-label="Onboarding progress"
    >
      {order.map((s, i) => (
        <span
          key={s}
          aria-hidden="true"
          className={`h-1.5 w-4 rounded-full transition-colors ${
            i <= idx ? "bg-noir-accent" : "bg-noir-ridge"
          }`}
        />
      ))}
    </div>
  );
}

function Intro({ rerun, onNext }: { rerun: boolean; onNext: () => void }) {
  return (
    <div className="space-y-4">
      <PointerWordmarkSvg
        decorative
        className="pn-brand-logo h-auto w-[min(330px,100%)] select-none"
      />
      <h1 className="font-sans text-[20px] tracking-tight text-noir-text">
        A code editor that thinks with you.
      </h1>
      <p className="font-sans text-[13px] text-noir-subtext leading-relaxed">
        {rerun
          ? "Review your local runtime and model assignments. Pointer will preserve working choices and only fill missing or uninstalled slots."
          : "Pointer is AI-first: chat, inline edit, tab completion, and an agent all run locally through Ollama models. Nothing leaves your machine. Let's set up your workspace in a few quick steps."}
      </p>
      <div className="flex justify-end">
        <button onClick={onNext} className="pn-button-accent font-sans flex items-center gap-1.5">
          {rerun ? "Review setup" : "Get started"} <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function ThemeStep({ onNext }: { onNext: () => void }) {
  const appTheme = useSettings((s) => s.appTheme);
  const setAppTheme = useSettings((s) => s.setAppTheme);
  const selectTheme = (themeId: AppThemeId) => {
    setAppTheme(themeId);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Palette size={20} className="text-noir-accent" />
        <div>
          <h3 className="font-sans text-[16px] text-noir-text">
            Choose your theme
          </h3>
          <p className="mt-1 font-sans text-[12px] text-noir-subtext">
            This sets Pointer&apos;s chrome and editor syntax palette. You can
            change it later from Settings or the Themes menu.
          </p>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label="Pointer theme"
        className="grid max-h-[330px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2"
      >
        {POINTER_THEMES.map((theme) => {
          const selected = theme.id === appTheme;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={theme.menuLabel}
              onClick={() => selectTheme(theme.id)}
              className={`group rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? "border-noir-accent bg-noir-accent/10"
                  : "border-noir-line bg-noir-canvas/35 hover:border-noir-accent/50 hover:bg-noir-ridge/35"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-sans text-[12px] text-noir-text">
                    {theme.menuLabel}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5" aria-hidden="true">
                    {[
                      "--pn-canvas",
                      "--pn-panel",
                      "--pn-accent",
                      "--pn-code-keyword",
                      "--pn-code-string",
                      "--pn-code-function",
                    ].map((token) => (
                      <span
                        key={token}
                        className="h-3 w-5 rounded-sm border border-noir-line/50"
                        style={{
                          backgroundColor:
                            theme.css[token as keyof typeof theme.css],
                        }}
                      />
                    ))}
                  </div>
                </div>
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    selected
                      ? "border-noir-accent bg-noir-accent text-white"
                      : "border-noir-line text-transparent group-hover:border-noir-accent/60"
                  }`}
                  aria-hidden="true"
                >
                  <Check size={12} />
                </span>
              </div>
              <div
                className="mt-3 overflow-hidden rounded-md border border-noir-line/50"
                style={{
                  backgroundColor: theme.css["--pn-code-bg"],
                  color: theme.css["--pn-code-fg"],
                }}
                aria-hidden="true"
              >
                <div
                  className="flex items-center gap-1 border-b px-2 py-1"
                  style={{
                    borderColor: theme.css["--pn-line"],
                    backgroundColor: theme.css["--pn-chrome"],
                  }}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: theme.css["--pn-accent"] }}
                  />
                  <span className="font-mono text-[9px] opacity-80">
                    App.tsx
                  </span>
                </div>
                <div className="space-y-1 px-2 py-2 font-mono text-[10px] leading-tight">
                  <div>
                    <span style={{ color: theme.css["--pn-code-keyword"] }}>
                      export
                    </span>{" "}
                    <span style={{ color: theme.css["--pn-code-function"] }}>
                      default
                    </span>{" "}
                    <span style={{ color: theme.css["--pn-code-type"] }}>
                      function
                    </span>
                  </div>
                  <div>
                    <span style={{ color: theme.css["--pn-code-tag"] }}>
                      &lt;main
                    </span>{" "}
                    <span style={{ color: theme.css["--pn-code-attribute"] }}>
                      className
                    </span>
                    =
                    <span style={{ color: theme.css["--pn-code-string"] }}>
                      &quot;pointer&quot;
                    </span>
                    <span style={{ color: theme.css["--pn-code-tag"] }}>
                      /&gt;
                    </span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button
          onClick={onNext}
          className="pn-button-accent font-sans flex items-center gap-1.5"
        >
          Continue <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function OllamaStep({
  onNext,
  onBusyChange,
}: {
  onNext: () => void;
  onBusyChange: (b: boolean) => void;
}) {
  const [status, setStatus] = useState<{ installed: boolean; running: boolean; version: string | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setOllamaReady = useSettings((s) => s.setOllamaReady);
  const setInstalledModels = useSettings((s) => s.setInstalledModels);

  const check = async () => {
    try {
      const s = await ipc.ollamaStatus();
      setStatus(s);
      setOllamaReady(s.running);
      if (!s.running) {
        setInstalledModels([]);
        return;
      }
      try {
        const models = await ipc.ollamaListModels();
        setInstalledModels(models.map((m) => m.name));
      } catch (e) {
        console.warn(e);
        setInstalledModels([]);
      }
      setErr(null);
    } catch (e) {
      console.warn(e);
      setOllamaReady(false);
      setInstalledModels([]);
    }
  };

  useEffect(() => {
    check();
    const id = setInterval(check, 2500);
    return () => clearInterval(id);
  }, []);

  // Bubble in-progress state to the wizard footer so Skip can warn the user.
  useEffect(() => {
    onBusyChange(installing || starting);
    return () => onBusyChange(false);
  }, [installing, starting, onBusyChange]);

  const install = async () => {
    setInstalling(true);
    setErr(null);
    try {
      await ipc.ollamaInstall();
      // Give the installer a moment, then re-check so the status flips
      // to "installed" without the user clicking Refresh.
      await new Promise((r) => setTimeout(r, 1500));
      await check();
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setInstalling(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setErr(null);
    try {
      await ipc.ollamaStart();
      await new Promise((r) => setTimeout(r, 1200));
      await check();
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Server size={20} className="text-noir-accent" />
        <h3 className="font-sans text-[16px] text-noir-text">Local inference runtime</h3>
      </div>
      <p className="font-sans text-[12.5px] text-noir-subtext leading-relaxed">
        Pointer uses{" "}
        <a
          href="https://ollama.com"
          target="_blank"
          rel="noreferrer"
          className="text-noir-accent underline-offset-2 hover:underline"
        >
          Ollama
        </a>{" "}
        to run open-source models on your machine. It exposes an
        OpenAI-compatible API on <span className="font-mono">localhost:11434</span>.
      </p>
      <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot ok={!!status?.running} pending={!status?.running && !!status?.installed} />
          <div>
            <div className="font-sans text-[12px] text-noir-text">
              {!status
                ? "Checking…"
                : status.running
                ? `Ollama is running (v${status.version ?? "?"})`
                : status.installed
                ? "Ollama is installed but not running"
                : "Ollama is not installed"}
            </div>
            <div className="font-sans text-[10.5px] text-noir-mute">
              {status?.installed
                ? "Found in PATH or default install location."
                : "We can run the official installer for you."}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!status?.installed && (
            <button
              onClick={install}
              disabled={installing}
              className="pn-button-accent font-sans flex items-center gap-1.5"
            >
              {installing ? (
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
              disabled={starting}
              className="pn-button-accent font-sans flex items-center gap-1.5"
            >
              {starting ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              Start
            </button>
          )}
        </div>
      </div>
      {err && (
        <div className="rounded-md border border-noir-err/40 bg-noir-err/5 px-3 py-2 text-[11px] text-noir-err font-sans flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}
      <div className="flex justify-end">
        <button
          onClick={onNext}
          disabled={!status?.running}
          className="pn-button-accent font-sans flex items-center gap-1.5 disabled:opacity-40"
        >
          Next <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function ModelsStep({
  onNext,
  onBusyChange,
}: {
  onNext: () => void;
  onBusyChange: (b: boolean) => void;
}) {
  const [recs, setRecs] = useState<
    ModelRecommendation[]
  >([]);
  const [ramGb, setRamGb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
  const installedModels = useSettings((s) => s.installedModels);
  const chatModel = useSettings((s) => s.chatModel);
  const agentModel = useSettings((s) => s.agentModel);
  const fimModel = useSettings((s) => s.fimModel);
  const embedModel = useSettings((s) => s.embedModel);
  const setChatModel = useSettings((s) => s.setChatModel);
  const setFimModel = useSettings((s) => s.setFimModel);
  const setEmbedModel = useSettings((s) => s.setEmbedModel);
  const setAgentModel = useSettings((s) => s.setAgentModel);
  const setOllamaReady = useSettings((s) => s.setOllamaReady);
  const setInstalledModels = useSettings((s) => s.setInstalledModels);
  // Share the global pull state so a download started here keeps streaming if
  // the user navigates away (and the AI panel can pick it up later).
  const activePulls = usePulls((s) => s.active);
  const startPull = usePulls((s) => s.start);

  // Lock Skip while a pull is active — losing track of an in-progress
  // download is worse than seeing the modal a few seconds longer.
  useEffect(() => {
    const busy = Object.keys(activePulls).length > 0;
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [activePulls, onBusyChange]);

  const refresh = async () => {
    try {
      const status = await ipc.ollamaStatus();
      setOllamaRunning(status.running);
      setOllamaReady(status.running);
      if (!status.running) {
        setInstalledModels([]);
        return;
      }
    } catch (e) {
      setError(extractErrorMessage(e));
      setOllamaReady(false);
      setOllamaRunning(false);
      setInstalledModels([]);
      return;
    }

    try {
      const m = await ipc.ollamaListModels();
      setInstalledModels(m.map((x) => x.name));
      setError(null);
    } catch (e) {
      setError(extractErrorMessage(e));
      setInstalledModels([]);
    }
  };

  useEffect(() => {
    Promise.all([ipc.recommendModels(), ipc.systemMemoryGb()])
      .then(([r, ram]) => {
        setRecs(r);
        setRamGb(ram);
      })
      .catch((e) => setError(extractErrorMessage(e)));
    refresh();
    // Re-check Ollama state periodically — the user may go back, start it,
    // and return without us knowing.
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  const pull = async (id: string) => {
    setError(null);
    await startPull(id);
    // Once the pull leaves the global active map, refresh the installed list.
    const unsub = usePulls.subscribe((s) => {
      const cur = s.active[id];
      if (!cur) {
        unsub();
        refresh();
      } else if (cur.error) {
        setError(cur.error);
      }
    });
  };

  const fallbackForPurpose = (purpose: ModelRecommendation["purpose"]) =>
    recs
      .filter((r) => r.purpose === purpose)
      .sort((a, b) => Number(b.recommended) - Number(a.recommended))
      .map((r) => resolveInstalledModelName(r.id, installedModels))
      .find(Boolean) ?? "";

  const firstInstalledChatModel = () =>
    installedModels.find((name) => !/embed/i.test(name)) ?? "";

  const apply = () => {
    const chatFallback = fallbackForPurpose("chat") || firstInstalledChatModel();
    if (!isModelInInstalledList(chatModel, installedModels) && chatFallback) {
      setChatModel(chatFallback);
    }
    if (!isModelInInstalledList(agentModel, installedModels) && chatFallback) {
      setAgentModel(chatFallback);
    }

    const fimFallback = fallbackForPurpose("fim");
    if (!isModelInInstalledList(fimModel, installedModels) && fimFallback) {
      setFimModel(fimFallback);
    }

    const embedFallback = fallbackForPurpose("embed");
    if (!isModelInInstalledList(embedModel, installedModels) && embedFallback) {
      setEmbedModel(embedFallback);
    }
    onNext();
  };

  const anyInstalled = installedModels.length > 0;
  const canProceed = ollamaRunning === true && anyInstalled;
  const assignments = [
    { label: "Chat", model: chatModel },
    { label: "Agent", model: agentModel },
    { label: "Tab completion", model: fimModel },
    { label: "Codebase indexing", model: embedModel },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Download size={20} className="text-noir-accent" />
        <h3 className="font-sans text-[16px] text-noir-text">Review your models</h3>
      </div>
      {ramGb !== null && (
        <p className="font-sans text-[12px] text-noir-subtext">
          Detected {ramGb.toFixed(1)} GB of RAM. Recommendations are tuned for
          your machine.
        </p>
      )}
      {ollamaRunning === false && (
        <div className="rounded-md border border-noir-warn/40 bg-noir-warn/5 px-3 py-2 text-[11px] text-noir-warn font-sans flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>
            Ollama isn't running, so models can't be pulled. Go back to the
            previous step to start it, or skip this step — you can install
            models any time from the AI Control Panel.
          </span>
        </div>
      )}
      {error && (
        <div className="text-[11px] text-noir-err font-sans flex items-start gap-1.5">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}
      <div className="rounded-lg border border-noir-line bg-noir-canvas/40 p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[11px] uppercase tracking-[0.16em] text-noir-mute">
            Current setup
          </span>
          <span className="font-sans text-[11px] text-noir-subtext">
            {installedModels.length === 0
              ? "No local models detected"
              : `${installedModels.length} local model${installedModels.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {assignments.map((a) => {
            const installedName = resolveInstalledModelName(a.model, installedModels);
            return (
              <div
                key={a.label}
                className="rounded-md bg-noir-chrome/55 px-2.5 py-2"
              >
                <div className="font-sans text-[10px] uppercase tracking-[0.12em] text-noir-mute">
                  {a.label}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-noir-text">
                  {a.model || "Not selected"}
                </div>
                <div
                  className={`mt-1 font-sans text-[10px] ${
                    installedName ? "text-noir-ok" : "text-noir-warn"
                  }`}
                >
                  {installedName
                    ? installedName === a.model
                      ? "Installed"
                      : `Installed as ${installedName}`
                    : a.model
                      ? "Not installed"
                      : "Needs a model"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="space-y-2 max-h-[280px] overflow-y-auto">
        {recs.map((r) => {
          const installedName = resolveInstalledModelName(r.id, installedModels);
          const isInstalled = !!installedName;
          const p = activePulls[r.id];
          return (
            <div
              key={r.id}
              className={`rounded-lg border ${r.recommended ? "border-noir-accent/40 bg-noir-accent/5" : "border-noir-line bg-noir-canvas/40"} p-3 flex items-center gap-3`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-[12px] text-noir-text truncate">
                    {r.id}
                  </span>
                  <span className="text-[10px] font-sans text-noir-mute uppercase">
                    {r.purpose}
                  </span>
                  {r.recommended && (
                    <span className="text-[10px] font-sans text-noir-accent">recommended</span>
                  )}
                </div>
                <div className="text-[11px] font-sans text-noir-subtext">
                  {r.description}
                </div>
                <div className="text-[10px] font-sans text-noir-mute mt-0.5">
                  ~{r.size_gb.toFixed(1)} GB · needs ≥{r.min_ram_gb.toFixed(0)} GB RAM
                </div>
                {p && (
                  <div className="mt-2">
                    <div className="h-1 w-full bg-noir-ridge rounded overflow-hidden">
                      <div
                        className="h-full bg-noir-accent transition-[width]"
                        style={{ width: `${p.pct}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-noir-mute font-sans mt-0.5">
                      {p.status} · {p.pct}%
                    </div>
                  </div>
                )}
              </div>
              {isInstalled ? (
                <span className="text-noir-ok flex items-center gap-1 text-[11px] font-sans">
                  <Check size={11} /> installed
                </span>
              ) : (
                <button
                  disabled={!!p || ollamaRunning !== true}
                  onClick={() => pull(r.id)}
                  className="pn-button font-sans flex items-center gap-1.5 disabled:opacity-40"
                  title={
                    ollamaRunning === true
                      ? undefined
                      : "Start Ollama in the previous step first."
                  }
                >
                  {p ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Download size={11} />
                  )}
                  Pull
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-sans text-noir-mute">
          {canProceed
            ? `${installedModels.length} model${installedModels.length === 1 ? "" : "s"} installed`
            : "Pull at least one model to continue, or skip for now."}
        </div>
        <button
          onClick={apply}
          disabled={!canProceed}
          className="pn-button-accent font-sans flex items-center gap-1.5 disabled:opacity-40"
        >
          Use current setup <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function Done({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4 text-center pt-8">
      <PointerMarkSvg
        decorative
        className="pn-brand-mark mx-auto h-12 w-12 rounded-lg"
      />
      <h2 className="font-sans text-[18px] text-noir-text">You&apos;re set.</h2>
      <p className="font-sans text-[12.5px] text-noir-subtext leading-relaxed max-w-md mx-auto">
        Open a folder with <span className="pn-kbd">⌘O</span>, ask in chat with{" "}
        <span className="pn-kbd">⌘L</span>, inline edit with <span className="pn-kbd">⌘K</span>,
        manage models any time with <span className="pn-kbd">⌘,</span>, and accept tab
        completions with <span className="pn-kbd">Tab</span>.
      </p>
      <button onClick={onClose} className="pn-button-accent font-sans">
        Start coding
      </button>
    </div>
  );
}

function extractErrorMessage(e: unknown): string {
  if (!e) return "Something went wrong.";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
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
