/**
 * Floating "rename across the workspace?" suggestion card.
 *
 * Surfaces an offer to apply a detected rename to every other
 * occurrence in the workspace. The detection is driven by the
 * rename observer + refactor watcher; this component is purely the
 * presentation + accept/dismiss controls.
 *
 * Why a floating card (and not e.g. a code lens or a peek)?
 *
 *   • Code lenses live above their target line, but a rename
 *     suggestion concerns OTHER files — we don't have a single
 *     target line to anchor to.
 *   • Peeks steal focus, which is hostile for a "by the way" hint.
 *   • A small, dismissible card pinned above the status bar is the
 *     standard "ambient suggestion" UX in modern IDEs.
 *
 * Z-index discipline: we use the `panel-popover` layer (above
 * editor content, below modals / context menus). The status bar
 * sits at `status-bar`, which is BELOW us, so the card never gets
 * occluded.
 */

import { useState } from "@/lib/preactSignalCompat";
import { useRefactorSuggestions } from "@/store/refactorSuggestions";
import { applyRenameAcrossWorkspace } from "@/lib/applyRename";

export function RefactorSuggestion() {
  const active = useRefactorSuggestions((s) => s.active);
  const dismiss = useRefactorSuggestions((s) => s.dismiss);
  const markApplied = useRefactorSuggestions((s) => s.markApplied);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!active) return null;

  const fileCount = new Set(active.hits.map((h) => h.path)).size;
  const hitCount = active.hits.length;

  async function onApply() {
    if (!active) return;
    setApplying(true);
    setError(null);
    try {
      await applyRenameAcrossWorkspace(active);
      markApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="refactor-suggestion"
      className="fixed bottom-12 right-4 z-pn-panel-popover w-[360px] rounded-md border border-pn-border bg-pn-surface-2/95 p-3 text-sm text-pn-text shadow-lg backdrop-blur"
    >
      <div className="mb-1 font-medium">
        Renamed{" "}
        <code className="rounded bg-pn-surface px-1 font-mono">
          {active.oldName}
        </code>{" "}
        →{" "}
        <code className="rounded bg-pn-surface px-1 font-mono">
          {active.newName}
        </code>
      </div>
      <div className="mb-3 text-xs text-pn-text-muted">
        {hitCount} more occurrence{hitCount === 1 ? "" : "s"} across{" "}
        {fileCount} file{fileCount === 1 ? "" : "s"} still use{" "}
        <code className="font-mono">{active.oldName}</code>. Apply the
        rename everywhere?
      </div>
      {error && (
        <div
          className="mb-2 text-xs text-pn-danger"
          data-testid="refactor-error"
          role="alert"
        >
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          disabled={applying}
          className="rounded border border-pn-border bg-pn-surface px-2 py-1 text-xs hover:bg-pn-surface-3 disabled:opacity-50"
          title="Dismiss workspace rename suggestion"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={applying}
          className="rounded bg-pn-accent px-2 py-1 text-xs font-medium text-pn-accent-foreground hover:bg-pn-accent/90 disabled:opacity-50"
          title={
            applying
              ? "Applying rename, please wait"
              : `Apply rename from ${active.oldName} to ${active.newName} across ${fileCount} file${fileCount === 1 ? "" : "s"}`
          }
        >
          {applying ? "Applying…" : `Apply to ${fileCount} file${fileCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
