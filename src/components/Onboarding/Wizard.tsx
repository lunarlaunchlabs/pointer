import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  Download,
  Loader2,
  Server,
  Sparkles,
  Key,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { ipc, type HfTokenStatus } from "@/lib/ipc";
import { useSettings } from "@/store/settings";
import { usePulls } from "@/store/pulls";
import { confirm } from "@/components/Confirm";

type Step = "intro" | "ollama" | "hf" | "models" | "done";
const ORDER: Step[] = ["intro", "ollama", "hf", "models", "done"];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("intro");
  // Mirrors live state from substeps so the footer can lock Skip while
  // something important (an install, a pull) is happening.
  const [busy, setBusy] = useState(false);
  const setOllamaReady = useSettings((s) => s.setOllamaReady);
  const setHasHfToken = useSettings((s) => s.setHasHfToken);

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
        className="w-[640px] max-w-[92vw] rounded-2xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
      >
        <header className="px-5 py-4 border-b border-noir-line flex items-center gap-3">
          <span className="text-noir-accent text-xl leading-none" aria-hidden="true">
            ▸
          </span>
          <h2
            id="onboarding-title"
            className="font-sans text-[14px] text-noir-text"
          >
            Welcome to Pointer
          </h2>
          <div className="flex-1" />
          <Stepper step={step} />
        </header>

        <div className="p-6 min-h-[280px]">
          {step === "intro" && <Intro onNext={() => setStep("ollama")} />}
          {step === "ollama" && (
            <OllamaStep
              onBusyChange={setBusy}
              onNext={() => {
                setOllamaReady(true);
                setStep("hf");
              }}
            />
          )}
          {step === "hf" && (
            <HfStep
              onBusyChange={setBusy}
              onNext={(has) => {
                setHasHfToken(has);
                setStep("models");
              }}
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

        <footer className="px-5 py-3 bg-noir-chrome/60 border-t border-noir-line flex items-center justify-between gap-3">
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
  const order: Step[] = ["intro", "ollama", "hf", "models", "done"];
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

function Intro({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-4">
      <div
        className="text-5xl"
        style={{
          background: "linear-gradient(135deg, #FF2D7E 0%, #FFD480 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          display: "inline-block",
        }}
      >
        ▸
      </div>
      <h1 className="font-sans text-[20px] tracking-tight text-noir-text">
        A code editor that thinks with you.
      </h1>
      <p className="font-sans text-[13px] text-noir-subtext leading-relaxed">
        Pointer is AI-first: chat, inline edit, tab completion, and an agent all
        run locally via open-source models from Hugging Face. Nothing leaves
        your machine. Let&apos;s set up your local model in three quick steps.
      </p>
      <div className="flex justify-end">
        <button onClick={onNext} className="pn-button-accent font-sans flex items-center gap-1.5">
          Get started <ChevronRight size={12} />
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

  const check = async () => {
    try {
      const s = await ipc.ollamaStatus();
      setStatus(s);
    } catch (e) {
      console.warn(e);
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

function HfStep({
  onNext,
  onBusyChange,
}: {
  onNext: (has: boolean) => void;
  onBusyChange: (b: boolean) => void;
}) {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<HfTokenStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ipc
      .hfTokenStatus()
      .then(setStatus)
      .catch(() =>
        setStatus({
          present: false,
          location: null,
          preview: null,
          file_path: null,
          in_keychain: false,
          in_file: false,
        }),
      );
  }, []);

  useEffect(() => {
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);

  const save = async () => {
    if (!token.trim()) {
      onNext(status?.present ?? false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await ipc.setHfToken(token.trim());
      const verify = await ipc.hfTokenStatus();
      setStatus(verify);
      if (!verify.present) {
        throw new Error(
          "Token didn't persist. Re-enter and allow keychain access when prompted.",
        );
      }
      onNext(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Key size={20} className="text-noir-accent" />
        <h3 className="font-sans text-[16px] text-noir-text">Hugging Face token (optional)</h3>
      </div>
      <p className="font-sans text-[12.5px] text-noir-subtext leading-relaxed">
        Most coder models are public and don&apos;t need a token. Provide one if
        you want to pull gated GGUFs straight from Hugging Face (e.g., Llama or
        Gemma). Stored in your OS keychain when available, otherwise a 0600 file
        in the app data dir.
      </p>
      {status?.present && (
        <div className="rounded-md border border-noir-ok/30 bg-noir-ok/5 px-3 py-2 text-[12px] font-sans text-noir-ok flex items-center gap-2">
          <Check size={12} />
          A token is already saved
          {status.preview && (
            <code className="font-mono text-[11px] text-noir-subtext bg-noir-canvas/40 border border-noir-line/60 rounded px-1.5 py-[1px]">
              {status.preview}
            </code>
          )}
          <span className="text-noir-mute">· {status.location}</span>
        </div>
      )}
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={status?.present ? "Update token (leave empty to keep)" : "hf_..."}
        className="pn-input w-full font-mono"
        aria-label="Hugging Face access token"
        autoComplete="off"
        spellCheck={false}
      />
      {err && (
        <div className="text-[11px] text-noir-err font-sans flex items-center gap-1">
          <AlertCircle size={11} />
          {err}
        </div>
      )}
      <div className="flex justify-between">
        <button onClick={() => onNext(status?.present ?? false)} className="pn-button font-sans">
          Skip
        </button>
        <button onClick={save} disabled={saving} className="pn-button-accent font-sans flex items-center gap-1.5">
          {saving && <Loader2 size={11} className="animate-spin" />}
          Save & continue
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
    { id: string; purpose: string; size_gb: number; min_ram_gb: number; description: string; recommended: boolean }[]
  >([]);
  const [ramGb, setRamGb] = useState<number | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
  const setChatModel = useSettings((s) => s.setChatModel);
  const setFimModel = useSettings((s) => s.setFimModel);
  const setEmbedModel = useSettings((s) => s.setEmbedModel);
  const setAgentModel = useSettings((s) => s.setAgentModel);
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
      if (!status.running) {
        setInstalled(new Set());
        return;
      }
      const m = await ipc.ollamaListModels();
      setInstalled(new Set(m.map((x) => x.name)));
    } catch (e) {
      setError(extractErrorMessage(e));
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

  const apply = () => {
    for (const r of recs) {
      if (!installed.has(r.id)) continue;
      if (r.purpose === "chat") {
        setChatModel(r.id);
        setAgentModel(r.id);
      }
      if (r.purpose === "fim") setFimModel(r.id);
      if (r.purpose === "embed") setEmbedModel(r.id);
    }
    onNext();
  };

  const anyInstalled = installed.size > 0;
  const canProceed = ollamaRunning === true && anyInstalled;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Download size={20} className="text-noir-accent" />
        <h3 className="font-sans text-[16px] text-noir-text">Choose your models</h3>
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
      <div className="space-y-2 max-h-[280px] overflow-y-auto">
        {recs.map((r) => {
          const isInstalled = installed.has(r.id);
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
            ? `${installed.size} model${installed.size === 1 ? "" : "s"} installed`
            : "Pull at least one model to continue, or skip for now."}
        </div>
        <button
          onClick={apply}
          disabled={!canProceed}
          className="pn-button-accent font-sans flex items-center gap-1.5 disabled:opacity-40"
        >
          Use selected <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function Done({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4 text-center pt-8">
      <div className="text-4xl" style={{
        background: "linear-gradient(135deg, #FF2D7E, #FFD480)",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
        display: "inline-block",
      }}>▸</div>
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
