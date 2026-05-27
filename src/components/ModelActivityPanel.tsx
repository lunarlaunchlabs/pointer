import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Box,
  Cpu,
  MemoryStick,
  Square,
  Zap,
} from "lucide-react";
import {
  ipc,
  listenEvent,
  type InferenceJob,
  type InferenceSnapshot,
  type LoadedModel,
  type SystemSnapshot,
} from "@/lib/ipc";
import { toast } from "@/components/Toast";

type Sample = { t: number; cpu: number; mem: number };

export function ModelActivityPanel() {
  const [snapshot, setSnapshot] = useState<InferenceSnapshot | null>(null);
  const [system, setSystem] = useState<SystemSnapshot | null>(null);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    listenEvent<InferenceSnapshot>("inference:changed", (next) => {
      if (alive) setSnapshot(next);
    }).then((u) => (off = u));

    const tick = async () => {
      try {
        const [next, sys, ps] = await Promise.all([
          ipc.inferenceStatus(),
          ipc.systemSnapshot(),
          ipc.ollamaPs().catch(() => []),
        ]);
        if (!alive) return;
        setSnapshot(next);
        setSystem(sys);
        setLoaded(ps);
        setSamples((prev) => {
          const sample = {
            t: Date.now(),
            cpu: sys.cpu_percent,
            mem: sys.mem_total > 0 ? (sys.mem_used / sys.mem_total) * 100 : 0,
          };
          return [...prev.slice(-47), sample];
        });
      } catch {
        if (alive) {
          setSnapshot({ active: [], active_count: 0, updated_at_ms: Date.now() });
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      off?.();
      window.clearInterval(id);
    };
  }, []);

  const jobs = snapshot?.active ?? [];
  const modelCount = new Set(jobs.map((j) => j.model)).size;

  const cancel = async (job: InferenceJob) => {
    setCancelling(job.request_id);
    try {
      const ok = await ipc.inferenceCancel(job.request_id);
      if (ok) toast.info(`Cancelling ${job.title}`);
      else toast.warn("Nothing to cancel");
    } catch (e) {
      toast.error("Cancel failed", {
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-noir-canvas/40">
      <header className="px-4 py-3 border-b border-noir-line bg-noir-chrome/40 flex items-center gap-3">
        <Activity size={14} className="text-noir-accent" aria-hidden="true" />
        <h2 className="font-sans text-[12.5px] text-noir-text">Model activity</h2>
        <div className="flex-1" />
        <span
          className="font-mono text-[10.5px] text-noir-mute"
          role="status"
          aria-live="polite"
        >
          {jobs.length === 0 ? "idle" : `${jobs.length} active`}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 font-sans text-[12px]">
        <div className="grid grid-cols-3 gap-2">
          <Metric
            icon={<Zap size={11} />}
            label="Slots"
            value={`${modelCount}/${Math.max(loaded.length, modelCount, 1)}`}
          />
          <Metric
            icon={<Cpu size={11} />}
            label="CPU"
            value={system ? `${system.cpu_percent.toFixed(0)}%` : "—"}
          />
          <Metric
            icon={<MemoryStick size={11} />}
            label="RAM"
            value={
              system
                ? `${((system.mem_used / Math.max(1, system.mem_total)) * 100).toFixed(0)}%`
                : "—"
            }
          />
        </div>

        <LoadGraph samples={samples} />

        <Section title="Active inference">
          {jobs.length === 0 ? (
            <div className="rounded-md border border-noir-line bg-noir-panel/35 px-3 py-5 text-center text-noir-mute">
              Idle
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <JobRow
                  key={job.request_id}
                  job={job}
                  onCancel={() => cancel(job)}
                  cancelling={cancelling === job.request_id || job.cancelling}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="Loaded models">
          {loaded.length === 0 ? (
            <div className="rounded-md border border-noir-line bg-noir-panel/35 px-3 py-3 text-noir-mute">
              None loaded
            </div>
          ) : (
            <div className="rounded-md border border-noir-line overflow-hidden">
              {loaded.map((model) => (
                <div
                  key={model.name}
                  className="grid grid-cols-[1fr_54px_76px] gap-2 items-center px-3 py-2 border-b last:border-b-0 border-noir-line/45"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[11.5px] text-noir-text truncate" title={model.name}>
                      {model.name}
                    </div>
                    <div className="text-[10px] text-noir-mute">
                      expires {model.expires_at ? relativeFromNow(model.expires_at) : "—"}
                    </div>
                  </div>
                  <Processor processor={model.processor} />
                  <div className="font-mono text-[10.5px] text-noir-subtext text-right">
                    {fmtBytes(model.size_bytes)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-noir-mute">
        {title}
      </div>
      {children}
    </section>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-noir-line bg-noir-panel/40 px-2.5 py-2 min-w-0">
      <div className="flex items-center gap-1 text-[10px] text-noir-mute">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="font-mono text-[13px] text-noir-text truncate">{value}</div>
    </div>
  );
}

function JobRow({
  job,
  onCancel,
  cancelling,
}: {
  job: InferenceJob;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const elapsed = Math.max(0, Date.now() - job.started_at_ms);
  return (
    <div className="rounded-md border border-noir-line bg-noir-panel/45 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <KindIcon kind={job.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <KindBadge kind={job.kind} />
            <div className="font-mono text-[11.5px] text-noir-text truncate" title={job.model}>
              {job.model}
            </div>
          </div>
          <div className="mt-1 text-[11px] text-noir-subtext truncate" title={job.title}>
            {job.title}
          </div>
          <div className="mt-2 flex items-center gap-3 font-mono text-[10px] text-noir-mute">
            <span>{duration(elapsed)}</span>
            <span>{job.token_count} tok</span>
            {job.interruptible && <span>replaceable</span>}
          </div>
        </div>
        <button
          onClick={onCancel}
          disabled={!job.cancellable || cancelling}
          className="h-7 w-7 rounded-md inline-flex items-center justify-center text-noir-mute hover:text-noir-err hover:bg-noir-err/10 disabled:opacity-35 disabled:hover:text-noir-mute disabled:hover:bg-transparent"
          title={job.cancellable ? "Cancel" : "Not cancellable"}
          aria-label={`Cancel ${job.title}`}
        >
          <Square size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 h-1 rounded-full bg-noir-line/70 overflow-hidden">
        <div
          className="h-full bg-noir-accent"
          style={{ width: `${Math.min(100, Math.max(8, elapsed / 600))}%` }}
        />
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const cls =
    kind === "inline_suggestion"
      ? "text-noir-ok"
      : kind === "agent" || kind === "plan"
      ? "text-noir-accent"
      : "text-noir-warn";
  return <Activity size={13} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden="true" />;
}

function KindBadge({ kind }: { kind: string }) {
  const { label, cls } = kindMeta(kind);
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-sans ${cls}`}>
      {label}
    </span>
  );
}

function kindMeta(kind: string): { label: string; cls: string } {
  switch (kind) {
    case "agent":
      return { label: "agent", cls: "bg-noir-accent/15 text-noir-accent" };
    case "plan":
    case "planner":
      return { label: "plan", cls: "bg-noir-accent/10 text-noir-accent" };
    case "inline_suggestion":
      return { label: "tab", cls: "bg-noir-ok/15 text-noir-ok" };
    case "embedding":
    case "indexing":
      return { label: "index", cls: "bg-noir-warn/15 text-noir-warn" };
    case "vision":
    case "document":
      return { label: kind, cls: "bg-noir-warn/15 text-noir-warn" };
    case "fast_apply":
      return { label: "apply", cls: "bg-noir-accent/15 text-noir-accent" };
    default:
      return { label: kind.replace(/_/g, " "), cls: "bg-noir-line text-noir-subtext" };
  }
}

function Processor({ processor }: { processor: string }) {
  const cls =
    processor === "gpu"
      ? "bg-noir-accent/15 text-noir-accent"
      : processor === "mixed"
      ? "bg-noir-ok/15 text-noir-ok"
      : "bg-noir-warn/15 text-noir-warn";
  return (
    <span className={`inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${cls}`}>
      <Box size={9} aria-hidden="true" />
      {processor.toUpperCase()}
    </span>
  );
}

function LoadGraph({ samples }: { samples: Sample[] }) {
  const w = 360;
  const h = 58;
  const paths = useMemo(() => {
    if (samples.length < 2) return { cpu: "", mem: "" };
    const dx = w / Math.max(1, samples.length - 1);
    const y = (n: number) => h - (Math.max(0, Math.min(100, n)) / 100) * h;
    return {
      cpu: samples.map((s, i) => `${i === 0 ? "M" : "L"}${i * dx},${y(s.cpu)}`).join(" "),
      mem: samples.map((s, i) => `${i === 0 ? "M" : "L"}${i * dx},${y(s.mem)}`).join(" "),
    };
  }, [samples]);
  return (
    <div className="rounded-md border border-noir-line bg-noir-panel/35 px-2 py-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-noir-mute">
        <span>Host load</span>
        <span className="inline-flex items-center gap-3 font-mono">
          <span className="text-noir-accent">CPU</span>
          <span className="text-noir-warn">RAM</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[58px] w-full">
        {paths.cpu && <path d={paths.cpu} fill="none" stroke="rgb(255,45,126)" strokeWidth="1.4" />}
        {paths.mem && (
          <path d={paths.mem} fill="none" stroke="rgb(255,180,120)" strokeWidth="1.4" opacity="0.78" />
        )}
      </svg>
    </div>
  );
}

function duration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function relativeFromNow(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const deltaSec = (t - Date.now()) / 1000;
  if (deltaSec <= 0) return "expired";
  if (deltaSec < 60) return `${deltaSec.toFixed(0)}s`;
  if (deltaSec < 3600) return `${(deltaSec / 60).toFixed(0)}m`;
  return `${(deltaSec / 3600).toFixed(1)}h`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
