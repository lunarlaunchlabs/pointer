import { useMemo } from "@/lib/preactSignalCompat";
import { ChevronRight, Folder } from "@/lib/lucide";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { FileIconFor } from "@/lib/fileIcon";
import { scanByRegex, type OutlineItem } from "@/components/Outline";

/**
 * Path breadcrumbs above the editor — VS Code parity. Renders the
 * file's relative path as a sequence of clickable segments where
 * each segment opens the workspace file tree to that directory.
 * The last segment is the file itself with its language icon.
 *
 * Symbol breadcrumbs (function / class scope under cursor) are
 * deliberately deferred to the LSP integration milestone — they
 * require document symbol providers that we don't have for every
 * language yet. The path layer alone is a big readability win.
 */
export function Breadcrumbs() {
  const active = useEditorStore((s) => s.getActive());
  const cursor = useEditorStore((s) => s.cursor);
  const revealAt = useEditorStore((s) => s.revealAt);
  const root = useWorkspace((s) => s.root);
  const toggle = useWorkspace((s) => s.toggle);
  const enabled = useSettings((s) => s.editorBreadcrumbs);

  /** Best-effort enclosing symbol — we scan the file with the same
   *  regex outline the side panel uses and pick the last symbol
   *  starting before the cursor. Cheap (regex over the buffer) and
   *  re-runs whenever the cursor or buffer changes. */
  const enclosingSymbol: OutlineItem | null = useMemo(() => {
    if (!active || !cursor) return null;
    if (active.path.startsWith("untitled:")) return null;
    const symbols = scanByRegex(active.content, active.language);
    let best: OutlineItem | null = null;
    for (const s of symbols) {
      if (s.line <= cursor.line) {
        if (!best || s.line > best.line) best = s;
      }
    }
    return best;
  }, [active?.path, active?.content, active?.language, cursor?.line]);

  const segments = useMemo(() => {
    if (!active) return [];
    const path = active.path;
    let relative = path;
    if (root && path.startsWith(root)) {
      relative = path.slice(root.length).replace(/^[\\/]+/, "");
    }
    const parts = relative.split(/[\\/]+/).filter(Boolean);
    // Rebuild absolute paths for each prefix so clicks can navigate
    // back into the file tree.
    const out: { name: string; absPath: string; isFile: boolean }[] = [];
    let current = root ?? "";
    for (let i = 0; i < parts.length; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      out.push({
        name: parts[i],
        absPath: current,
        isFile: i === parts.length - 1,
      });
    }
    return out;
  }, [active, root]);

  if (!enabled || !active || segments.length === 0) return null;

  return (
    <nav
      className="h-7 px-3 flex items-center gap-1 text-[11px] font-sans border-b border-noir-line/50 bg-noir-chrome/40 text-noir-subtext shrink-0 overflow-x-auto"
      aria-label="File breadcrumbs"
    >
      <Folder size={11} className="text-noir-mute shrink-0" aria-hidden="true" />
      <button
        onClick={() => root && toggle(root)}
        className="hover:text-noir-text transition-colors truncate max-w-[140px]"
        title={root ?? ""}
        aria-label={`Workspace root ${root ? root.split(/[\\/]/).pop() : ""} — reveal in file tree`}
      >
        {root ? root.split(/[\\/]/).pop() : ""}
      </button>
      {segments.map((seg) => (
        <span key={seg.absPath} className="flex items-center gap-1 shrink-0">
          <ChevronRight size={9} className="text-noir-mute shrink-0" aria-hidden="true" />
          {seg.isFile ? (
            <>
              <button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("pointer:reveal_in_tree", {
                      detail: { path: seg.absPath },
                    }),
                  );
                }}
                className="flex items-center gap-1 text-noir-text hover:text-noir-accent transition-colors"
                title={`${seg.absPath}\nClick to reveal in tree`}
                aria-label={`File ${seg.name} — reveal in file tree`}
                aria-current="page"
              >
                <FileIconFor name={seg.name} size={10} className="shrink-0" />
                <span className="font-mono truncate max-w-[260px]">
                  {seg.name}
                </span>
              </button>
              {enclosingSymbol && (
                <>
                  <ChevronRight size={9} className="text-noir-mute shrink-0" aria-hidden="true" />
                  <button
                    onClick={() => {
                      if (active) {
                        revealAt(active.path, enclosingSymbol.line, enclosingSymbol.column).catch(() => {});
                      }
                    }}
                    className="flex items-center gap-1 text-noir-subtext hover:text-noir-accent transition-colors"
                    title={`${enclosingSymbol.kindLabel}: ${enclosingSymbol.name} · line ${enclosingSymbol.line}`}
                    aria-label={`Jump to ${enclosingSymbol.kindLabel} ${enclosingSymbol.name} at line ${enclosingSymbol.line}`}
                  >
                    <span className="text-[9px] uppercase tracking-wider text-noir-mute">
                      {enclosingSymbol.kindLabel}
                    </span>
                    <span className="font-mono truncate max-w-[180px]">
                      {enclosingSymbol.name}
                    </span>
                  </button>
                </>
              )}
            </>
          ) : (
            <button
              onClick={() => toggle(seg.absPath)}
              className="hover:text-noir-text transition-colors truncate max-w-[160px]"
              title={seg.absPath}
              aria-label={`Folder ${seg.name} — open in file tree`}
            >
              {seg.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
