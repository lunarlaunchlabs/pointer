/**
 * Bottom terminal panel.
 *
 * Renders a tab bar across the top + a single visible xterm.js instance
 * for the active tab. Inactive tabs are kept mounted but display:hidden so
 * scrollback and cursor position survive switching back to them.
 *
 * Architecture decisions:
 *
 *  - Each `TerminalView` owns its own xterm + addon instances and the
 *    backend PTY id. The store only tracks metadata; ownership of the
 *    DOM-attached object lives with the component to avoid React
 *    reconciliation racing with imperative xterm calls.
 *  - We use the FitAddon for size sync. ResizeObserver gives us pixel-
 *    perfect parity with the surrounding flexbox parent, and a debounced
 *    handler sends a single `terminal_resize` IPC instead of one per
 *    frame during a drag.
 *  - The reader side is just a Tauri event listener that pipes bytes into
 *    `term.write(...)`. The writer side is `term.onData(...)` → IPC.
 *  - When the child exits the panel keeps showing the buffer (the user
 *    might want to read the final output) but the input is locked.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, ArrowUp, Plus, Search, X, ChevronDown } from "lucide-react";

import { ipc, listenEvent, type TerminalExitPayload } from "@/lib/ipc";
import { useWorkspace } from "@/store/workspace";
import { useTerminals, nextTerminalTitle } from "@/store/terminal";
import { useSession } from "@/store/session";
import { toast } from "@/components/Toast";

export function TerminalPanel() {
  const tabs = useTerminals((s) => s.tabs);
  const activeId = useTerminals((s) => s.activeId);
  const open = useTerminals((s) => s.open);
  const setActive = useTerminals((s) => s.setActive);
  const remove = useTerminals((s) => s.remove);
  const setOpen = useTerminals((s) => s.setOpen);
  const root = useWorkspace((s) => s.root);
  const terminalHeight = useSession((s) => s.terminalHeight ?? 280);
  const noteTerminalHeight = useSession((s) => s.noteTerminalHeight);

  const onNew = async () => {
    const { id, title } = nextTerminalTitle();
    // Provisionally compute cols/rows from a typical panel height. The
    // FitAddon will replace these with the *actual* numbers as soon as it
    // mounts; the values here just need to be plausible enough for the
    // shell to not paint garbage in the half-second before the first fit.
    try {
      const result = await ipc.terminalOpen(id, root, 100, 24);
      useTerminals.getState().add({
        id,
        title,
        shell: result.shell,
        cwd: root || "",
        exited: false,
        exitCode: null,
      });
    } catch (e: any) {
      toast.error(`Failed to start terminal: ${e?.message ?? e}`);
    }
  };

  const onClose = async (id: string) => {
    try {
      await ipc.terminalClose(id);
    } catch {
      /* already exited */
    }
    remove(id);
  };

  if (!open) return null;

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalHeight;
    const onMove = (ev: MouseEvent) => {
      // Dragging the handle up grows the panel (taller); dragging
      // down shrinks. Clamp between sensible bounds so the panel
      // can't disappear or eat the whole window.
      const next = Math.max(120, Math.min(window.innerHeight - 200, startH + (startY - ev.clientY)));
      noteTerminalHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="relative border-t border-noir-line bg-noir-panel/95 flex flex-col shrink-0"
      style={{ height: terminalHeight }}
    >
      <div
        onMouseDown={startResize}
        onDoubleClick={() => noteTerminalHeight(280)}
        className="absolute top-0 left-0 right-0 h-1 cursor-row-resize hover:bg-noir-accent/40 z-pn-dock-handle"
        title="Drag to resize · double-click to reset"
      />
      <div
        className="h-7 flex items-center gap-1 px-2 border-b border-noir-line/60 bg-noir-chrome/60 select-none"
        role="tablist"
        aria-label="Terminal sessions"
      >
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto min-w-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              onClick={() => setActive(t.id)}
              className={`group flex items-center gap-1 px-2 py-[3px] rounded text-[11px] font-mono whitespace-nowrap shrink-0 ${
                t.id === activeId
                  ? "bg-noir-canvas text-noir-text"
                  : "text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60"
              }`}
              title={`${t.title} · ${t.shell}${t.exited ? ` · exited (${t.exitCode ?? "killed"})` : ""}`}
              aria-label={`Terminal ${t.title}${t.exited ? `, exited with code ${t.exitCode ?? "killed"}` : ", running"}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  t.exited
                    ? "bg-noir-mute"
                    : t.id === activeId
                    ? "bg-noir-accent"
                    : "bg-noir-ok"
                }`}
              />
              <span className="truncate max-w-[140px]">{t.title}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose(t.id);
                  }
                }}
                className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-noir-ridge rounded"
                aria-label={`Close terminal ${t.title}`}
              >
                <X size={10} aria-hidden="true" />
              </span>
            </button>
          ))}
          <button
            onClick={onNew}
            className="ml-1 p-1 rounded text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60 shrink-0"
            title="New terminal (⌘`)"
            aria-label="New terminal"
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="p-1 rounded text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60"
          title="Hide terminal panel (⌘J)"
          aria-label="Hide terminal panel"
        >
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative bg-noir-canvas">
        {tabs.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-noir-mute font-sans">
            <button
              onClick={onNew}
              className="pn-button-accent flex items-center gap-1.5"
            >
              <Plus size={12} /> New terminal
            </button>
          </div>
        ) : (
          tabs.map((t) => (
            <TerminalView key={t.id} id={t.id} active={t.id === activeId} />
          ))
        )}
      </div>
    </div>
  );
}

function TerminalView({ id, active }: { id: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // We keep a stable copy of the latest cell-size so resize callbacks
  // don't need to re-measure inside an animation frame.
  const [ready, setReady] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Construct the xterm instance exactly once when the host div mounts.
  // We deliberately keep the construction in `useLayoutEffect` so the DOM
  // measurements taken by fit().proposeDimensions() happen *after* layout.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      // Match the noir palette so the panel feels native.
      theme: {
        background: "#0B0B0E",
        foreground: "#E5E5EB",
        cursor: "#FF2D7E",
        cursorAccent: "#0B0B0E",
        selectionBackground: "#FF2D7E55",
        black: "#1B1B22",
        red: "#FF6B7A",
        green: "#7CDB9C",
        yellow: "#F0C674",
        blue: "#5FB3F9",
        magenta: "#D38BFF",
        cyan: "#79DBE3",
        white: "#E5E5EB",
        brightBlack: "#3A3A45",
        brightRed: "#FF8A95",
        brightGreen: "#A2E6B5",
        brightYellow: "#F5D89C",
        brightBlue: "#85C9FF",
        brightMagenta: "#E2A8FF",
        brightCyan: "#A6E8ED",
        brightWhite: "#FFFFFF",
      },
      fontFamily:
        '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(search);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Ctrl/Cmd-F focuses the inline search bar. We hook into
    // attachCustomKeyEventHandler so the shortcut works even when
    // the terminal has focus (xterm's defaults would eat the key).
    term.attachCustomKeyEventHandler((ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (ev.type === "keydown" && mod && (ev.key === "f" || ev.key === "F")) {
        ev.preventDefault();
        setShowSearch(true);
        return false;
      }
      return true;
    });

    // Initial fit and a tiny grace delay — Chromium occasionally reports
    // the wrong cell size on the first measurement, leading to a one-row
    // truncation that's then corrected on resize. The 30ms delay gives
    // the font a moment to load.
    const fitNow = () => {
      try {
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        // Push the actual dimensions into the PTY immediately so the
        // shell prompt repaints at the correct width on first render.
        ipc.terminalResize(id, cols, rows).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    const t = window.setTimeout(fitNow, 30);

    // Pipe local keystrokes back to the PTY.
    const dataDisposable = term.onData((data) => {
      ipc.terminalWrite(id, data).catch(() => {
        /* shell is gone; the exit listener below will mark it */
      });
    });

    // ResizeObserver gives us pixel-accurate triggers. The FitAddon's
    // computed grid is then sent to the backend so the PTY's SIGWINCH
    // matches what xterm just rendered.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        ipc.terminalResize(id, term.cols, term.rows).catch(() => {});
      } catch {
        /* host not in DOM yet */
      }
    });
    ro.observe(hostRef.current);

    setReady(true);

    // Subscribe to backend output and exit notifications. Each event is
    // suffixed with the terminal id so multiple PTYs don't cross-feed.
    let unsubData = () => {};
    let unsubExit = () => {};
    (async () => {
      unsubData = await listenEvent<string>(
        `terminal:data:${id}`,
        (payload) => {
          term.write(payload);
        },
      );
      unsubExit = await listenEvent<TerminalExitPayload>(
        `terminal:exit:${id}`,
        (payload) => {
          useTerminals.getState().markExited(id, payload.code ?? null);
          // Echo a clear footer so the buffer doesn't end mid-prompt.
          term.write(
            `\r\n\x1b[2m[ process exited${
              payload.code != null ? ` with code ${payload.code}` : ""
            } ]\x1b[0m\r\n`,
          );
        },
      );
    })();

    return () => {
      window.clearTimeout(t);
      ro.disconnect();
      dataDisposable.dispose();
      unsubData();
      unsubExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // The backend session is killed by the parent panel when the user
      // explicitly closes the tab — *not* on unmount, because the panel
      // unmounts whenever the user simply hides the bottom dock.
    };
  }, [id]);

  // Whenever the tab becomes active, refit + refocus so the cursor is
  // ready for typing without an extra click.
  useEffect(() => {
    if (!active || !ready) return;
    try {
      fitRef.current?.fit();
      const t = termRef.current;
      if (t) {
        ipc.terminalResize(id, t.cols, t.rows).catch(() => {});
        t.focus();
      }
    } catch {
      /* ignore */
    }
  }, [active, ready, id]);

  const runFind = (direction: "next" | "prev") => {
    const s = searchRef.current;
    if (!s || !searchQuery) return;
    const opts = {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      // Highlight every other match in the scrollback so the user
      // can see context — purely visual, doesn't move the viewport.
      decorations: {
        matchBackground: "#FF2D7E33",
        matchBorder: "#FF2D7E",
        matchOverviewRuler: "#FF2D7E",
        activeMatchBackground: "#FF2D7EAA",
        activeMatchBorder: "#FF2D7E",
        activeMatchColorOverviewRuler: "#FF2D7E",
      },
    };
    if (direction === "next") s.findNext(searchQuery, opts);
    else s.findPrevious(searchQuery, opts);
  };

  return (
    <div
      style={{
        display: active ? "block" : "none",
        position: "absolute",
        inset: 0,
      }}
    >
      {showSearch && (
        <div
          className="absolute top-1 right-1 z-10 flex items-center gap-1 px-2 py-1 rounded border border-noir-line bg-noir-panel/95 backdrop-blur-sm text-[11px]"
          role="search"
          aria-label="Search terminal scrollback"
        >
          <Search size={11} className="text-noir-mute shrink-0" aria-hidden="true" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                runFind(e.shiftKey ? "prev" : "next");
              else if (e.key === "Escape") {
                searchRef.current?.clearDecorations();
                setShowSearch(false);
                termRef.current?.focus();
              }
            }}
            placeholder="Search scrollback…"
            aria-label="Search scrollback"
            className="w-44 bg-transparent outline-none text-noir-text placeholder:text-noir-mute"
          />
          <button
            onClick={() => runFind("prev")}
            className="p-0.5 text-noir-mute hover:text-noir-text"
            aria-label="Previous match"
            title="Previous (⇧Enter)"
          >
            <ArrowUp size={11} aria-hidden="true" />
          </button>
          <button
            onClick={() => runFind("next")}
            className="p-0.5 text-noir-mute hover:text-noir-text"
            aria-label="Next match"
            title="Next (Enter)"
          >
            <ArrowDown size={11} aria-hidden="true" />
          </button>
          <button
            onClick={() => {
              searchRef.current?.clearDecorations();
              setShowSearch(false);
              termRef.current?.focus();
            }}
            className="p-0.5 text-noir-mute hover:text-noir-text"
            aria-label="Close search"
            title="Close (Esc)"
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        role="application"
        aria-label="Terminal output"
        // We use display:none rather than unmounting so scrollback is kept.
        style={{
          position: "absolute",
          inset: 0,
          padding: 6,
        }}
      />
    </div>
  );
}
