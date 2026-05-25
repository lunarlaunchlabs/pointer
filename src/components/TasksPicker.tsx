import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { createPortal } from "react-dom";
import { Play, Pencil, FilePlus2, Hammer } from "lucide-react";
import {
  ensureWorkspaceTasksFile,
  loadWorkspaceTasks,
  type WorkspaceTask,
} from "@/lib/tasks";
import { useWorkspace } from "@/store/workspace";
import { useEditorStore } from "@/store/editor";
import { useTerminals, nextTerminalTitle } from "@/store/terminal";
import { ipc } from "@/lib/ipc";
import { toast } from "@/components/Toast";

/**
 * Quick task picker, opened via the palette / ⌘⇧B (build).
 * Lists every entry from `.pointer/tasks.json` plus an "Edit
 * tasks.json" affordance that opens (and seeds) the file. Selecting
 * a task spawns a fresh terminal tab and types the command in.
 *
 * Why a fresh terminal per run? It keeps each task's output
 * self-contained — interleaving a `npm test` and `cargo build`
 * stream in the same tab is the kind of thing that bites once and
 * then never gets fixed. The user can always close stale tabs.
 */
export function TasksPicker({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const [items, setItems] = useState<WorkspaceTask[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceTasks(root).then((list) => {
      if (!cancelled) setItems(list);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  // Esc dismisses — every other picker in the app honours this, so
  // muscle memory says the task picker should too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (task: WorkspaceTask) => {
    if (!root) {
      toast.error("Open a folder first");
      return;
    }
    onClose();
    try {
      const { id, title } = nextTerminalTitle();
      const cwd = task.cwd
        ? task.cwd.startsWith("/")
          ? task.cwd
          : `${root}/${task.cwd}`
        : root;
      const result = await ipc.terminalOpen(id, cwd, 100, 30);
      useTerminals.getState().add({
        id,
        title: `${task.label} · ${title}`,
        shell: result.shell,
        cwd,
        exited: false,
        exitCode: null,
      });
      useTerminals.getState().setOpen(true);
      useTerminals.getState().setActive(id);
      // Give the shell a beat to print its prompt before we send the
      // command — typing into a shell that hasn't drawn its prompt
      // yet leads to confusing-looking output for the user.
      window.setTimeout(() => {
        ipc.terminalWrite(id, task.command + "\n").catch(() => {});
      }, 120);
    } catch (e) {
      toast.error("Couldn't run task", {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const editTasks = async () => {
    if (!root) return;
    try {
      const file = await ensureWorkspaceTasksFile(root);
      await useEditorStore.getState().openFile(file);
      onClose();
    } catch (e) {
      toast.error("Couldn't open tasks.json", {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-pn-modal flex items-start justify-center pt-24 bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Run task"
        className="w-[520px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter className="font-sans" label="Run task">
          <div className="px-3 py-2 border-b border-noir-line/60 flex items-center gap-2">
            <Hammer size={12} className="text-noir-accent" aria-hidden="true" />
            <Command.Input
              value={filter}
              onValueChange={setFilter}
              placeholder={
                items === null
                  ? "Loading tasks…"
                  : items.length === 0
                  ? "No tasks defined. Press ↵ to create tasks.json"
                  : "Run task…"
              }
              autoFocus
              aria-label="Run task"
              className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-noir-mute"
            />
            <kbd className="pn-kbd text-[10px] shrink-0">Esc</kbd>
          </div>
          <Command.List className="max-h-[360px] overflow-y-auto py-1">
            <Command.Empty className="px-3 py-3 text-[12px] text-noir-mute text-center">
              {items === null
                ? "Reading .pointer/tasks.json…"
                : "No matching tasks."}
            </Command.Empty>
            {items?.map((t) => (
              <Command.Item
                key={`${t.label}-${t.command}`}
                value={`${t.label} ${t.command} ${t.group ?? ""}`}
                onSelect={() => run(t)}
                className="px-3 py-1.5 mx-1 rounded-md flex items-center gap-2 cursor-pointer text-[12px] data-[selected=true]:bg-noir-accent/15"
              >
                <Play size={11} className="text-noir-accent shrink-0" />
                <span className="text-noir-text shrink-0">{t.label}</span>
                <span className="text-noir-mute truncate font-mono text-[11px]">
                  {t.command}
                </span>
                {t.group && (
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-noir-mute shrink-0">
                    {t.group}
                  </span>
                )}
              </Command.Item>
            ))}
            <Command.Item
              value="edit tasks json configure"
              onSelect={editTasks}
              className="px-3 py-1.5 mx-1 rounded-md flex items-center gap-2 cursor-pointer text-[12px] text-noir-subtext border-t border-noir-line/60 mt-1 pt-2 data-[selected=true]:bg-noir-accent/15"
            >
              {items && items.length > 0 ? (
                <Pencil size={11} className="text-noir-subtext shrink-0" />
              ) : (
                <FilePlus2 size={11} className="text-noir-subtext shrink-0" />
              )}
              <span>
                {items && items.length > 0
                  ? "Edit tasks.json…"
                  : "Create .pointer/tasks.json"}
              </span>
            </Command.Item>
          </Command.List>
        </Command>
      </div>
    </div>,
    document.body,
  );
}
