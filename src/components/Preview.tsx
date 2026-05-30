import { useEffect, useState } from "@/lib/preactSignalCompat";
import { ExternalLink, Maximize2, Minus, Plus } from "@/lib/lucide";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealInFiler } from "@/lib/reveal";

/**
 * Lightweight image viewer rendered in place of Monaco for image
 * tabs. Uses Tauri's `convertFileSrc` to translate the on-disk
 * absolute path into a `tauri://localhost/…` URL the webview can
 * load directly (no base64 / IPC round-trip needed for big images).
 *
 * Controls:
 *   • Zoom in / out / reset (also wired to ⌘+ / ⌘- / ⌘0 via the
 *     same global zoom actions used by the editor — feels natural)
 *   • Show meta: dimensions (read from the loaded image), file size
 *     (best-effort via metadata IPC), and path.
 *   • Open in OS viewer
 */
export function ImagePreview({ path }: { path: string }) {
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  const src = convertFileSrc(path);

  useEffect(() => {
    setZoom(1);
    setSize(null);
    setFileSize(null);
  }, [path]);

  // Best-effort file size — we don't have a dedicated IPC, but the
  // metadata read in `read_text_file` errs on binary files, so we
  // just leave it null when unknown.
  useEffect(() => {
    let canceled = false;
    void import("@/lib/ipc").then(async ({ ipc }) => {
      try {
        const meta = await (
          ipc as unknown as { fsStat?: (p: string) => Promise<{ size: number }> }
        ).fsStat?.(path);
        if (!canceled && meta) setFileSize(meta.size);
      } catch {
        /* not available — fine */
      }
    });
    return () => {
      canceled = true;
    };
  }, [path]);

  return (
    <div className="absolute inset-0 flex flex-col bg-noir-canvas overflow-hidden">
      <div
        className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-noir-line bg-noir-chrome/60 text-[11px] font-mono text-noir-subtext"
        role="toolbar"
        aria-label="Image viewer controls"
      >
        <span className="truncate flex-1" title={path}>
          {path}
        </span>
        {size && (
          <span title="Pixel dimensions" aria-label={`${size.w} by ${size.h} pixels`}>
            {size.w} × {size.h}
          </span>
        )}
        {fileSize !== null && (
          <span aria-label={`File size ${formatBytes(fileSize)}`}>
            {formatBytes(fileSize)}
          </span>
        )}
        <button
          onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}
          title="Zoom out"
          aria-label="Zoom out"
          className="p-1 rounded hover:text-noir-text hover:bg-noir-ridge/60"
        >
          <Minus size={11} aria-hidden="true" />
        </button>
        <button
          onClick={() => setZoom(1)}
          title="Reset zoom (100%)"
          aria-label={`Reset zoom. Currently ${Math.round(zoom * 100)} percent.`}
          className="px-1.5 rounded hover:text-noir-text hover:bg-noir-ridge/60"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => setZoom((z) => Math.min(20, z * 1.25))}
          title="Zoom in"
          aria-label="Zoom in"
          className="p-1 rounded hover:text-noir-text hover:bg-noir-ridge/60"
        >
          <Plus size={11} aria-hidden="true" />
        </button>
        <button
          onClick={() => setZoom(1)}
          title="Fit"
          aria-label="Fit image to view"
          className="p-1 rounded hover:text-noir-text hover:bg-noir-ridge/60"
        >
          <Maximize2 size={11} aria-hidden="true" />
        </button>
        <button
          onClick={() => revealInFiler(path)}
          title="Open in OS image viewer"
          aria-label="Open in OS image viewer"
          className="p-1 rounded hover:text-noir-text hover:bg-noir-ridge/60"
        >
          <ExternalLink size={11} aria-hidden="true" />
        </button>
      </div>
      <div
        className="flex-1 min-h-0 grid place-items-center overflow-auto pn-checker"
        onWheel={(e) => {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            setZoom((z) => {
              const next = z * (e.deltaY < 0 ? 1.1 : 0.9);
              return Math.max(0.05, Math.min(40, next));
            });
          }
        }}
      >
        <img
          src={src}
          alt={`Preview of ${path.split(/[\\/]/).pop() ?? path}`}
          onLoad={(e) => {
            const img = e.currentTarget;
            setSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "center",
            imageRendering: zoom >= 2 ? "pixelated" : "auto",
            maxWidth: "100%",
            maxHeight: "100%",
          }}
        />
      </div>
    </div>
  );
}

/** Inline placeholder for binary files the editor can't preview. */
export function BinaryPreview({ path }: { path: string }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 bg-noir-canvas"
      role="status"
      aria-label={`Binary file ${path} — preview unavailable`}
    >
      <div className="text-[12px] uppercase tracking-wider text-noir-mute mb-2">
        Binary file
      </div>
      <div className="text-[13px] text-noir-text mb-4 break-all max-w-md font-mono">
        {path}
      </div>
      <div className="text-[11.5px] text-noir-subtext max-w-md leading-relaxed">
        Pointer can't preview this file type. Use the OS file manager
        to open it, or change the language to force a text view.
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => revealInFiler(path)}
          className="px-3 py-1.5 rounded bg-noir-accent/20 text-noir-accent text-[12px] hover:bg-noir-accent/30 inline-flex items-center gap-1.5"
          aria-label={`Reveal ${path.split(/[\\/]/).pop() ?? path} in Finder`}
        >
          <ExternalLink size={12} aria-hidden="true" /> Reveal in Finder
        </button>
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
