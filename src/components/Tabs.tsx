import { useMemo, useState } from "react";
import { Pin, X } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import { confirm } from "@/components/Confirm";
import { FileIconFor } from "@/lib/fileIcon";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { dispatchAction } from "@/lib/actions";
import { useGit, gitStatusColor, gitStatusLetter } from "@/store/git";

/**
 * Tab strip with the full IDE-grade interactions:
 *   • Click to activate
 *   • Middle-click to close
 *   • Right-click → context menu (Close / Close Others / Close To Right
 *     / Close All / Copy Path / Reveal in Finder / Pin)
 *   • Drag a tab onto another to reorder
 *   • Pinned tabs sort to the left and survive "Close Others"
 *
 * The store is the source of truth for ordering; drag handlers call
 * `reorderTab(from, to, position)` which mutates `tabs[]` in place.
 */
export function Tabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const activePath = useEditorStore((s) => s.activePath);
  const pinned = useEditorStore((s) => s.pinned);
  const setActive = useEditorStore((s) => s.setActive);
  const closeTab = useEditorStore((s) => s.closeTab);
  const reorderTab = useEditorStore((s) => s.reorderTab);
  const togglePinned = useEditorStore((s) => s.togglePinned);

  const [ctx, setCtx] = useState<null | { x: number; y: number; path: string }>(
    null,
  );
  const [dragPath, setDragPath] = useState<string | null>(null);

  // Pinned-first visual order. We don't mutate the underlying tabs[]
  // here because drag-reorder semantics inside each group still
  // rely on the original sequence.
  const ordered = useMemo(() => {
    const pinSet = new Set(pinned);
    const pinnedTabs = tabs.filter((t) => pinSet.has(t.path));
    const rest = tabs.filter((t) => !pinSet.has(t.path));
    return [...pinnedTabs, ...rest];
  }, [tabs, pinned]);

  /** Same Save / Discard / Cancel flow as ⌘W and File → Close Tab. */
  const closeWithGuard = async (path: string) => {
    const tab = useEditorStore.getState().tabs.find((t) => t.path === path);
    if (!tab) return;
    if (tab.dirty) {
      setActive(path);
      const save = await confirm({
        title: `Save changes to ${tab.name}?`,
        body: "This file has unsaved edits. Closing without saving will lose them.",
        confirmLabel: "Save & close",
        cancelLabel: "Discard",
      });
      if (save) await useEditorStore.getState().saveActive();
    }
    closeTab(path);
  };

  const closeOthers = async (keepPath: string) => {
    const others = useEditorStore
      .getState()
      .tabs.filter((t) => t.path !== keepPath && !pinned.includes(t.path));
    for (const t of others) await closeWithGuard(t.path);
  };

  const closeToRight = async (path: string) => {
    const all = useEditorStore.getState().tabs;
    const i = all.findIndex((t) => t.path === path);
    if (i < 0) return;
    const after = all.slice(i + 1).filter((t) => !pinned.includes(t.path));
    for (const t of after) await closeWithGuard(t.path);
  };

  const closeAll = async () => {
    const all = useEditorStore.getState().tabs.filter((t) => !pinned.includes(t.path));
    for (const t of all) await closeWithGuard(t.path);
  };

  const copyPath = (path: string, relative = false) => {
    let toCopy = path;
    if (relative) {
      // Best effort — strip the workspace root if it's a prefix.
      const root = (window as unknown as { __pointerWorkspaceRoot?: string })
        .__pointerWorkspaceRoot;
      if (root && path.startsWith(root)) {
        toCopy = path.slice(root.length).replace(/^[\\/]+/, "");
      }
    }
    navigator.clipboard?.writeText(toCopy).catch(() => {});
  };

  const buildMenu = (path: string): MenuItem[] => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return [];
    const isPinned = pinned.includes(path);
    const untitled = path.startsWith("untitled:");
    const items: MenuItem[] = [
      { kind: "item", label: "Close", shortcut: "⌘W", onSelect: () => closeWithGuard(path) },
      { kind: "item", label: "Close Others", onSelect: () => closeOthers(path) },
      { kind: "item", label: "Close To The Right", onSelect: () => closeToRight(path) },
      { kind: "item", label: "Close All", onSelect: () => closeAll() },
      { kind: "separator" },
      {
        kind: "item",
        label: isPinned ? "Unpin Tab" : "Pin Tab",
        icon: <Pin size={11} />,
        onSelect: () => togglePinned(path),
      },
    ];
    if (!untitled) {
      items.push(
        { kind: "separator" },
        { kind: "item", label: "Copy Path", onSelect: () => copyPath(path) },
        { kind: "item", label: "Copy Relative Path", onSelect: () => copyPath(path, true) },
        {
          kind: "item",
          label: "Reveal in File Tree",
          onSelect: () => {
            window.dispatchEvent(
              new CustomEvent("pointer:reveal_in_tree", { detail: { path } }),
            );
          },
        },
        {
          kind: "item",
          label: "Reveal in Finder",
          onSelect: () => {
            import("@/lib/reveal").then((m) => m.revealInFiler(path)).catch(() => {});
          },
        },
      );
    }
    return items;
  };

  if (tabs.length === 0) return null;

  return (
    <>
      <div
        className="h-9 flex items-end border-b border-noir-line bg-noir-chrome/60 overflow-x-auto"
        role="tablist"
        aria-label="Open editors"
      >
        {ordered.map((t) => {
          const active = t.path === activePath;
          const isPinned = pinned.includes(t.path);
          const isDragSource = dragPath === t.path;
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={active}
              aria-label={`${t.name}${t.dirty ? " (unsaved)" : ""}${isPinned ? ", pinned" : ""}`}
              tabIndex={active ? 0 : -1}
              draggable
              onDragStart={(e) => {
                setDragPath(t.path);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/pointer-tab", t.path);
              }}
              onDragEnd={() => setDragPath(null)}
              onDragOver={(e) => {
                if (dragPath && dragPath !== t.path) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = e.dataTransfer.getData("text/pointer-tab") || dragPath;
                if (from && from !== t.path) {
                  // Decide insert side from the mouse x within the tab.
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const after = e.clientX > rect.left + rect.width / 2;
                  reorderTab(from, t.path, after ? "after" : "before");
                }
                setDragPath(null);
              }}
              onClick={() => setActive(t.path)}
              onKeyDown={(e) => {
                // Arrow-key navigation between tabs — common assistive
                // tech expectation for a role=tablist.
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const idx = ordered.findIndex((x) => x.path === t.path);
                  const next =
                    e.key === "ArrowRight"
                      ? (idx + 1) % ordered.length
                      : (idx - 1 + ordered.length) % ordered.length;
                  setActive(ordered[next].path);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActive(t.path);
                } else if (e.key === "Delete" || (e.metaKey && e.key === "w")) {
                  e.preventDefault();
                  closeWithGuard(t.path);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeWithGuard(t.path);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setActive(t.path);
                setCtx({ x: e.clientX, y: e.clientY, path: t.path });
              }}
              title={t.path}
              className={`group relative flex items-center gap-2 h-full px-3 cursor-pointer border-r border-noir-line/60 ${
                active
                  ? "bg-noir-canvas text-noir-text"
                  : "text-noir-subtext hover:text-noir-text hover:bg-noir-panel/60"
              } ${isDragSource ? "opacity-50" : ""}`}
            >
              {/* Pinned indicator takes the leftmost icon slot when set —
                  it always wins over file icon and dirty dot so users see
                  pin status at a glance. */}
              {isPinned ? (
                <Pin
                  size={11}
                  aria-label="Pinned"
                  className="shrink-0 text-noir-accent rotate-45"
                />
              ) : t.dirty ? (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-noir-accent shrink-0"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              ) : (
                <FileIconFor
                  name={t.name}
                  size={11}
                  className="shrink-0"
                  aria-hidden="true"
                />
              )}
              <span className="font-mono text-[12px] truncate max-w-[160px]">
                {t.name}
              </span>
              <GitTabBadge path={t.path} />
              
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeWithGuard(t.path);
                }}
                className={`p-0.5 rounded ${t.dirty ? "opacity-70" : "opacity-0"} group-hover:opacity-70 hover:opacity-100 hover:bg-noir-ridge`}
                aria-label={`Close ${t.name}`}
                title={`Close ${t.name} (⌘W)`}
              >
                <X size={11} aria-hidden="true" />
              </button>
              {active && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-px pointer-events-none"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, #FF2D7E99, transparent)",
                  }}
                />
              )}
            </div>
          );
        })}
        {/* Tail trailing buttons: switch the action surface for "Close
            All" / "Reopen Closed" inside the strip if the user prefers
            mouse to keyboard. Inline icons keep the surface tiny. */}
        <button
          onClick={() => dispatchAction("tabs:reopen_closed")}
          className="ml-auto px-3 h-full text-[10px] text-noir-mute hover:text-noir-text shrink-0"
          title="Reopen Closed Tab (⌘⇧T)"
          aria-label="Reopen closed tab"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildMenu(ctx.path)}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  );
}

/** Compact M/A/U/?? badge next to the tab name when git tracks the
 *  file. Reuses the same color palette as the SCM panel rows so
 *  the user's mental model is consistent — a yellow "M" means the
 *  same thing everywhere. Untracked files in the workspace don't
 *  get a badge; only files git knows about. */
function GitTabBadge({ path }: { path: string }) {
  const status = useGit((s) => s.statusFor(path));
  if (!status) return null;
  // The store returns the raw `GitFileStatus` enum value as a
  // string ("modified" | "added" | "untracked" | "deleted" | "renamed").
  return (
    <span
      className={`text-[9px] font-mono shrink-0 ${gitStatusColor(status)}`}
      title={`git: ${status}`}
      aria-label={`Git status: ${status}`}
    >
      {gitStatusLetter(status)}
    </span>
  );
}
