import { useEffect, useState } from "@/lib/preactSignalCompat";
import { Command } from "cmdk";
import { createPortal } from "@/lib/preactSignalDomCompat";
import { Code2 } from "@/lib/lucide";
import { useEditorStore } from "@/store/editor";
import { toast } from "@/components/Toast";

/**
 * Monaco language picker — lets the user override the auto-detected
 * language for the active tab. Mirrors VS Code's status-bar dropdown:
 * the override is in-memory only (not persisted to disk), and clears
 * the moment the tab closes.
 *
 * Why not persist? VS Code doesn't either — language mode overrides
 * are quirky enough that "stickiness" tends to surprise users. The
 * file extension is the source of truth; an override is a "for the
 * rest of this view" affordance.
 */
export function LanguagePicker({ onClose }: { onClose: () => void }) {
  const active = useEditorStore((s) =>
    s.tabs.find((t) => t.path === s.activePath) ?? null,
  );
  const [filter, setFilter] = useState("");
  const [langs, setLangs] = useState<{ id: string; aliases?: string[] }[]>([]);

  useEffect(() => {
    // Dynamically import monaco so the picker code-splits cleanly
    // and we don't load monaco twice (the editor pulls its own).
    let cancelled = false;
    void import("monaco-editor").then((monaco) => {
      if (cancelled) return;
      const list = monaco.languages.getLanguages().map((l) => ({
        id: l.id,
        aliases: l.aliases,
      }));
      list.sort((a, b) => a.id.localeCompare(b.id));
      setLangs(list);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const choose = (id: string) => {
    if (!active) {
      onClose();
      return;
    }
    useEditorStore.getState().setLanguage(active.path, id);
    // Notify Monaco to retokenise — model.setLanguage is the
    // supported way to swap on the fly. We do it via a tiny custom
    // event so the Editor component can run it against the active
    // model without needing to plumb a setter through the tree.
    window.dispatchEvent(
      new CustomEvent("pointer:set_language", { detail: { id } }),
    );
    toast.info(`Language: ${id}`);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-pn-modal flex items-start justify-center pt-24 bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change language mode"
        className="w-[460px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter className="font-sans" label="Change language mode">
          <div className="px-3 py-2 border-b border-noir-line/60 flex items-center gap-2">
            <Code2 size={12} className="text-noir-accent" aria-hidden="true" />
            <Command.Input
              value={filter}
              onValueChange={setFilter}
              placeholder={
                active
                  ? `Set language for ${active.name} (current: ${active.language})`
                  : "No active file"
              }
              autoFocus
              aria-label="Filter languages"
              className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-noir-mute"
            />
            <kbd className="pn-kbd text-[10px] shrink-0">Esc</kbd>
          </div>
          <Command.List className="max-h-[420px] overflow-y-auto py-1">
            <Command.Empty className="px-3 py-3 text-[12px] text-noir-mute text-center">
              No matching language.
            </Command.Empty>
            {langs.map((l) => {
              const aliases = l.aliases?.filter((a) => a !== l.id).join(", ");
              return (
                <Command.Item
                  key={l.id}
                  value={`${l.id} ${l.aliases?.join(" ") ?? ""}`}
                  onSelect={() => choose(l.id)}
                  className="px-3 py-1.5 mx-1 rounded-md flex items-center gap-2 cursor-pointer text-[12px] data-[selected=true]:bg-noir-accent/15"
                >
                  <span className="text-noir-text shrink-0">{l.id}</span>
                  {aliases && (
                    <span className="text-noir-mute text-[10.5px] truncate">
                      {aliases}
                    </span>
                  )}
                  {active && active.language === l.id && (
                    <span className="ml-auto text-[10.5px] text-noir-accent shrink-0">
                      current
                    </span>
                  )}
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </div>
    </div>,
    document.body,
  );
}
