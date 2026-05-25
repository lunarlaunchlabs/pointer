/**
 * The horizontal row of "this is what I'm sending" chips above the
 * composer textarea. One source of truth (the `references` prop) shared
 * by chat + agent so they look identical.
 *
 * Each chip is keyed by *intent* (the kind of attachment), styled with
 * a category-specific colour, and removable via the inline ×.
 */

import {
  AlertCircle,
  AlertTriangle,
  FileText,
  Folder,
  Image as ImageIcon,
  Info,
  ScrollText,
  Search,
  Table,
  X,
} from "lucide-react";
import type { Reference } from "@/store/chat";
import { FileIconFor } from "@/lib/fileIcon";

export function ReferenceChips({
  references,
  onRemove,
}: {
  references: Reference[];
  /** Omit to render read-only chips (e.g. inside a turn divider in
   *  the agent transcript history). When present, each chip gets an
   *  X button that calls onRemove with its index. */
  onRemove?: (index: number) => void;
}) {
  if (references.length === 0) return null;
  return (
    <ul
      className="flex flex-wrap gap-1.5 list-none p-0 m-0"
      aria-label={`${references.length} attached reference${references.length === 1 ? "" : "s"}`}
    >
      {references.map((r, i) => (
        <li key={i}>
          <Chip
            reference={r}
            onRemove={onRemove ? () => onRemove(i) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

function Chip({
  reference,
  onRemove,
}: {
  reference: Reference;
  onRemove?: () => void;
}) {
  const meta = chipMeta(reference);
  return (
    <span
      className={`group inline-flex items-center gap-1 text-[11px] font-sans rounded-md border pl-1.5 pr-1 py-0.5 max-w-[260px] ${meta.cls}`}
      title={meta.tooltip}
      aria-label={meta.tooltip}
    >
      <span className="shrink-0" aria-hidden="true">{meta.icon}</span>
      <span className="truncate font-mono text-[11px]">{meta.label}</span>
      {meta.detail && (
        <span className="text-noir-mute text-[10px] shrink-0">
          {meta.detail}
        </span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-0.5 text-noir-mute hover:text-noir-err shrink-0"
          title="Remove"
          aria-label={`Remove ${meta.label}`}
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function chipMeta(r: Reference): {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  tooltip: string;
  cls: string;
} {
  if (r.kind === "file") {
    const name = r.path.split(/[\\/]/).pop() ?? r.path;
    return {
      icon: <FileIconFor name={name} size={11} />,
      label: shorten(r.path),
      tooltip: r.path,
      cls: "bg-noir-ridge/60 text-noir-text border-noir-line",
    };
  }
  if (r.kind === "folder") {
    return {
      icon: <Folder size={11} className="text-noir-accent" />,
      label: `${shorten(r.path)}/`,
      tooltip: r.path,
      cls: "bg-noir-ridge/60 text-noir-text border-noir-line",
    };
  }
  if (r.kind === "selection") {
    return {
      icon: <ScrollText size={11} className="text-noir-accent" />,
      label: shorten(r.path),
      detail: `L${r.startLine}–${r.endLine}`,
      tooltip: `${r.path} (lines ${r.startLine}–${r.endLine})`,
      cls: "bg-noir-accent/10 text-noir-text border-noir-accent/30",
    };
  }
  if (r.kind === "codebase") {
    return {
      icon: <Search size={11} className="text-noir-accent" />,
      label: "@codebase",
      detail: r.query || undefined,
      tooltip: r.query
        ? `Semantic search: ${r.query}`
        : "Semantic search over indexed chunks",
      cls: "bg-noir-accent/10 text-noir-text border-noir-accent/30",
    };
  }
  if (r.kind === "symbol") {
    return {
      icon: <FileText size={11} className="text-noir-subtext" />,
      label: r.name,
      detail: shorten(r.path),
      tooltip: `${r.name} in ${r.path}`,
      cls: "bg-noir-ridge/60 text-noir-text border-noir-line",
    };
  }
  if (r.kind === "diagnostic") {
    const icon =
      r.severity === "error" ? (
        <AlertCircle size={11} className="text-noir-err" />
      ) : r.severity === "warning" ? (
        <AlertTriangle size={11} className="text-noir-warn" />
      ) : (
        <Info size={11} className="text-noir-subtext" />
      );
    return {
      icon,
      label: shorten(r.path),
      detail: `L${r.startLine}${r.code ? ` · ${r.code}` : ""}`,
      tooltip:
        `${r.severity.toUpperCase()} in ${r.path}:${r.startLine}\n` +
        (r.code ? `${r.source} ${r.code}\n` : "") +
        r.message,
      cls:
        r.severity === "error"
          ? "bg-noir-err/10 text-noir-text border-noir-err/30"
          : r.severity === "warning"
          ? "bg-noir-warn/10 text-noir-text border-noir-warn/30"
          : "bg-noir-ridge/60 text-noir-text border-noir-line",
    };
  }
  if (r.kind === "processed") {
    const Icon =
      r.fileKind === "image"
        ? ImageIcon
        : r.fileKind === "spreadsheet"
        ? Table
        : FileText;
    return {
      icon: <Icon size={11} className="text-noir-accent" />,
      label: shorten(r.path),
      detail: r.model ? r.model.split(":")[0] : r.label,
      tooltip: `${r.label} (${r.raw_bytes} bytes)${r.model ? ` · ${r.model}` : ""}`,
      cls: "bg-noir-accent/10 text-noir-text border-noir-accent/30",
    };
  }
  return {
    icon: null,
    label: "(unknown)",
    tooltip: "",
    cls: "bg-noir-ridge/60 text-noir-text border-noir-line",
  };
}

function shorten(p: string): string {
  return p.split(/[\\/]/).slice(-2).join("/");
}
