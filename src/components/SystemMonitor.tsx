import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Box,
  Cpu,
  HardDrive,
  MemoryStick,
  Power,
  Skull,
  X,
} from "lucide-react";
import {
  ipc,
  type HardwareProfile,
  type LoadedModel,
  type ProcInfo,
  type SystemSnapshot,
} from "@/lib/ipc";
import { confirm } from "@/components/Confirm";
import { toast } from "@/components/Toast";

type Series = { t: number; cpu: number; mem: number }[];
const MAX_POINTS = 60;

export function SystemMonitor({ onClose }: { onClose: () => void }) {
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [series, setSeries] = useState<Series>([]);
  const [err, setErr] = useState<string | null>(null);
  const [killing, setKilling] = useState<number | null>(null);
  const [unloading, setUnloading] = useState<string | null>(null);

  // Hardware is read once — it doesn't change while the app is running.
  useEffect(() => {
    ipc.hardwareProfile().then(setHardware).catch(() => setHardware(null));
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await ipc.systemSnapshot();
        if (!alive) return;
        setSnap(s);
        setErr(null);
        setSeries((prev) => {
          const next = [
            ...prev,
            {
              t: Date.now(),
              cpu: s.pointer_cpu_percent,
              mem: s.pointer_mem_bytes,
            },
          ];
          if (next.length > MAX_POINTS) next.shift();
          return next;
        });
      } catch (e) {
        if (alive) setErr(String(e));
      }
      try {
        const ps = await ipc.ollamaPs();
        if (alive) setLoaded(ps);
      } catch {
        if (alive) setLoaded([]);
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const unloadModel = async (name: string) => {
    setUnloading(name);
    try {
      await ipc.ollamaUnloadModel(name);
      toast.success(`Unloaded ${name}`);
      // Eagerly refresh — the next 1.5s tick would also catch it.
      const ps = await ipc.ollamaPs().catch(() => []);
      setLoaded(ps);
    } catch (e) {
      toast.error("Couldn't unload model", {
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUnloading(null);
    }
  };

  const kill = async (pid: number) => {
    const ok = await confirm({
      title: `Stop process ${pid}?`,
      body: "Pointer can only stop subprocesses it started itself (currently: the Ollama daemon).",
      confirmLabel: "Stop process",
      danger: true,
    });
    if (!ok) return;
    setKilling(pid);
    try {
      await ipc.killOwnedProcess(pid);
      const s = await ipc.systemSnapshot();
      setSnap(s);
    } catch (e) {
      setErr(String(e));
    } finally {
      setKilling(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-pn-modal flex items-center justify-center bg-black/55 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="w-[820px] max-w-[94vw] max-h-[92vh] h-[88vh] sm:h-auto rounded-2xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-monitor-title"
      >
        <header className="px-5 py-4 border-b border-noir-line flex items-center gap-3">
          <Activity size={16} className="text-noir-accent" aria-hidden="true" />
          <h2 id="system-monitor-title" className="font-sans text-[14px] text-noir-text">
            System monitor
          </h2>
          {snap && (
            <span className="font-sans text-[10.5px] text-noir-mute">
              {snap.os_name ?? ""}
              {snap.host_name ? ` · ${snap.host_name}` : ""}
              {` · ${snap.cpu_count} cores`}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="p-1.5 text-noir-mute hover:text-noir-text"
            aria-label="Close system monitor"
            title="Close (Esc)"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 font-sans text-[12.5px]">
          {err && (
            <div
              className="rounded-md border border-noir-err/40 bg-noir-err/5 px-3 py-2 text-[12px] text-noir-err"
              role="alert"
            >
              {err}
            </div>
          )}

          {snap && (
            <>
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[160px] basis-[160px]">
                  <Stat
                    icon={<Cpu size={12} />}
                    label="Pointer CPU"
                    value={`${snap.pointer_cpu_percent.toFixed(1)}%`}
                    sub={`system ${snap.cpu_percent.toFixed(1)}%`}
                  />
                </div>
                <div className="flex-1 min-w-[160px] basis-[160px]">
                  <Stat
                    icon={<MemoryStick size={12} />}
                    label="Pointer memory"
                    value={fmtBytes(snap.pointer_mem_bytes)}
                    sub={`system ${fmtBytes(snap.mem_used)} / ${fmtBytes(snap.mem_total)}`}
                  />
                </div>
                <div className="flex-1 min-w-[160px] basis-[160px]">
                  <Stat
                    icon={<HardDrive size={12} />}
                    label="Swap"
                    value={`${fmtBytes(snap.swap_used)}`}
                    sub={`of ${fmtBytes(snap.swap_total)}`}
                  />
                </div>
              </div>

              <Sparkline series={series} />

              {hardware && <HardwareStrip hardware={hardware} />}

              <LoadedModels
                models={loaded}
                onUnload={unloadModel}
                unloading={unloading}
              />

              <ProcessTable
                processes={snap.processes}
                onKill={kill}
                killing={killing}
              />
            </>
          )}

          {!snap && (
            <div className="text-[11.5px] text-noir-mute" role="status" aria-live="polite">Sampling…</div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-noir-line bg-noir-chrome/60 flex items-center justify-between">
          <span className="text-[10.5px] text-noir-mute">
            Updates every 1.5s. We only show processes Pointer started or that
            it depends on.
          </span>
          <button onClick={onClose} className="pn-button-accent font-sans" aria-label="Close system monitor">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      className="rounded-lg border border-noir-line bg-noir-canvas/40 px-3 py-2.5"
      role="group"
      aria-label={`${label}: ${value}${sub ? `, ${sub}` : ""}`}
    >
      <div className="text-[10.5px] text-noir-mute flex items-center gap-1">
        <span aria-hidden="true">{icon}</span> {label}
      </div>
      <div className="text-noir-text font-mono text-[15px] mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-noir-mute font-mono">{sub}</div>}
    </div>
  );
}

function Sparkline({ series }: { series: Series }) {
  const w = 760;
  const h = 90;
  const pad = 6;

  const { cpuPath, memPath, cpuMax, memMax } = useMemo(() => {
    if (series.length < 2) {
      return { cpuPath: "", memPath: "", cpuMax: 100, memMax: 0 };
    }
    const cpuMax = Math.max(100, ...series.map((p) => p.cpu));
    const memMax = Math.max(1, ...series.map((p) => p.mem));
    const dx = (w - pad * 2) / (MAX_POINTS - 1);
    const toX = (i: number) => pad + i * dx;
    const toY = (v: number, max: number) =>
      h - pad - ((v / max) * (h - pad * 2));
    const cpuPath = series
      .map((p, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toY(p.cpu, cpuMax)}`)
      .join(" ");
    const memPath = series
      .map((p, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toY(p.mem, memMax)}`)
      .join(" ");
    return { cpuPath, memPath, cpuMax, memMax };
  }, [series]);

  return (
    <div className="rounded-lg border border-noir-line bg-noir-canvas/40 px-3 py-2.5">
      <div className="flex items-center justify-between text-[10.5px] text-noir-mute mb-1">
        <span>Last {MAX_POINTS} samples</span>
        <span className="flex items-center gap-3 font-mono">
          <span className="text-noir-accent">CPU {cpuMax.toFixed(0)}%</span>
          <span className="text-noir-warn">MEM {fmtBytes(memMax)}</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-[90px]"
      >
        {cpuPath && (
          <path
            d={cpuPath}
            stroke="rgb(255,45,126)"
            strokeWidth="1.4"
            fill="none"
          />
        )}
        {memPath && (
          <path
            d={memPath}
            stroke="rgb(255,180,120)"
            strokeWidth="1.4"
            fill="none"
            opacity="0.75"
          />
        )}
      </svg>
    </div>
  );
}

function ProcessTable({
  processes,
  onKill,
  killing,
}: {
  processes: ProcInfo[];
  onKill: (pid: number) => void;
  killing: number | null;
}) {
  // Same approach as LoadedModels — horizontally scrollable wrapper so the
  // grid keeps its rigorous alignment without ever forcing a viewport
  // overflow on the modal.
  const cols = "grid-cols-[minmax(180px,1fr)_70px_60px_80px_80px]";
  return (
    <div className="rounded-lg border border-noir-line overflow-hidden">
      <div className="overflow-x-auto">
        <div className={`grid ${cols} gap-2 px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-noir-mute bg-noir-chrome/40 min-w-[480px]`}>
          <span>Process</span>
          <span>Kind</span>
          <span className="text-right">CPU</span>
          <span className="text-right">Memory</span>
          <span className="text-right">PID</span>
        </div>
        <ul className="divide-y divide-noir-line/40 max-h-[280px] overflow-y-auto min-w-[480px]">
          {processes.length === 0 && (
            <li className="px-3 py-3 text-[11px] text-noir-mute">
              No tracked processes yet.
            </li>
          )}
          {processes.map((p) => (
            <li
              key={p.pid}
              className={`grid ${cols} gap-2 px-3 py-1.5 items-center`}
            >
              <div className="min-w-0">
                <div className="font-mono text-[12px] text-noir-text truncate" title={p.name}>
                  {p.name}
                </div>
                {p.cmd && (
                  <div
                    className="font-mono text-[10px] text-noir-mute truncate"
                    title={p.cmd}
                  >
                    {p.cmd}
                  </div>
                )}
              </div>
              <KindBadge kind={p.kind} />
              <div className="font-mono text-[11px] text-noir-text text-right">
                {p.cpu_percent.toFixed(1)}%
              </div>
              <div className="font-mono text-[11px] text-noir-text text-right">
                {fmtBytes(p.mem_bytes)}
              </div>
              <div className="font-mono text-[11px] text-noir-mute text-right flex items-center justify-end gap-1">
                {p.pid}
                {p.owned_by_pointer && p.kind !== "pointer" && (
                  <button
                    onClick={() => onKill(p.pid)}
                    disabled={killing === p.pid}
                    className="p-0.5 text-noir-mute hover:text-noir-err"
                    title="Stop this process"
                    aria-label={`Stop process ${p.name} (PID ${p.pid})`}
                  >
                    <Skull size={11} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, { color: string; label: string }> = {
    pointer: { color: "bg-noir-accent/15 text-noir-accent", label: "pointer" },
    renderer: { color: "bg-noir-accent/10 text-noir-accent", label: "renderer" },
    ollama: { color: "bg-noir-ok/15 text-noir-ok", label: "ollama" },
    ollama_runner: { color: "bg-noir-ok/10 text-noir-ok", label: "runner" },
    other: { color: "bg-noir-line text-noir-mute", label: "other" },
  };
  const m = map[kind] ?? map.other;
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-sans ${m.color}`}
    >
      {m.label}
    </span>
  );
}

function HardwareStrip({ hardware }: { hardware: HardwareProfile }) {
  const ramGb = hardware.total_ram_bytes / (1024 ** 3);
  const cpuLabel =
    hardware.cpu_brand || hardware.cpu_name || `${hardware.cpu_count} cores`;
  return (
    <div className="rounded-lg border border-noir-line bg-noir-canvas/40 px-3 py-2.5 flex flex-wrap gap-3 text-[11px] text-noir-mute">
      <div className="flex-1 min-w-[140px] basis-[140px]">
        <Tile label="CPU" value={cpuLabel} />
      </div>
      <div className="flex-1 min-w-[80px] basis-[80px]">
        <Tile label="Cores" value={`${hardware.cpu_count}`} />
      </div>
      <div className="flex-1 min-w-[100px] basis-[100px]">
        <Tile label="RAM" value={`${ramGb.toFixed(0)} GB`} />
      </div>
      <div className="flex-1 min-w-[140px] basis-[140px]">
        <Tile label="GPU" value={hardware.gpu_label ?? "CPU only"} />
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-noir-mute">
        {label}
      </div>
      <div className="text-[12px] text-noir-text truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

function LoadedModels({
  models,
  onUnload,
  unloading,
}: {
  models: LoadedModel[];
  onUnload: (name: string) => void;
  unloading: string | null;
}) {
  // Table wraps in a horizontally scrollable container so it never breaks
  // the modal at narrow widths. Inside, we keep the rigid grid so columns
  // stay aligned across rows.
  const cols = "grid-cols-[minmax(160px,1fr)_70px_90px_90px_40px]";
  return (
    <div className="rounded-lg border border-noir-line overflow-hidden">
      <div className="overflow-x-auto">
        <div className={`grid ${cols} gap-2 px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-noir-mute bg-noir-chrome/40 min-w-[480px]`} role="row">
          <span className="flex items-center gap-1">
            <Box size={10} aria-hidden="true" /> Loaded model
          </span>
          <span>Where</span>
          <span className="text-right">RAM</span>
          <span className="text-right">Expires</span>
          <span aria-hidden="true"></span>
        </div>
        {models.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-noir-mute">
            Nothing in Ollama memory right now.
          </div>
        ) : (
          <ul className="divide-y divide-noir-line/40 min-w-[480px]">
            {models.map((m) => (
              <li
                key={m.name}
                className={`grid ${cols} gap-2 px-3 py-1.5 items-center`}
              >
                <div className="font-mono text-[12px] text-noir-text truncate" title={m.name}>
                  {m.name}
                </div>
                <ProcessorBadge processor={m.processor} />
                <div className="font-mono text-[11px] text-noir-text text-right">
                  {fmtBytes(m.size_bytes)}
                </div>
                <div className="font-mono text-[10.5px] text-noir-mute text-right truncate">
                  {m.expires_at ? relativeFromNow(m.expires_at) : "—"}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => onUnload(m.name)}
                    disabled={unloading === m.name}
                    title="Unload from memory now"
                    aria-label={`Unload ${m.name} from memory`}
                    className="p-1 text-noir-mute hover:text-noir-accent disabled:opacity-40"
                  >
                    <Power size={11} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProcessorBadge({ processor }: { processor: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    gpu: { label: "GPU", cls: "bg-noir-accent/15 text-noir-accent" },
    cpu: { label: "CPU", cls: "bg-noir-warn/15 text-noir-warn" },
    mixed: { label: "Mixed", cls: "bg-noir-ok/15 text-noir-ok" },
  };
  const m = map[processor] ?? { label: processor, cls: "bg-noir-line text-noir-mute" };
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-sans ${m.cls}`}
    >
      {m.label}
    </span>
  );
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
