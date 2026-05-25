import { useMemo, useState } from "react";
import {
  Bot,
  ChevronRight,
  History,
  ScrollText,
  Search,
  Trash2,
} from "lucide-react";
import { useChat, type ChatSession } from "@/store/chat";
import { useAgent, type AgentSession } from "@/store/agentSessions";
import { useSettings } from "@/store/settings";
import type { DockView } from "@/store/session";

/** Hook returning a predicate that says whether a per-session model name
 *  references something the user no longer has installed. We deliberately
 *  treat "Ollama offline" or "install list empty" as "we don't know" — in
 *  those cases we don't paint the row warn yellow, because the user can't
 *  act on it from the history view anyway. */
function useStaleSessionModelPredicate() {
  const ollamaReady = useSettings((s) => s.ollamaReady);
  const installedModels = useSettings((s) => s.installedModels);
  return (m: string) =>
    !!m &&
    ollamaReady &&
    installedModels.length > 0 &&
    !installedModels.includes(m);
}

/** Combined chat + agent history. Picking a session also routes the dock
 *  to the appropriate view so the user lands inside the conversation. */
export function HistoryView({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const chatSessions = useChat((s) => s.sessions);
  const selectChat = useChat((s) => s.selectSession);
  const deleteChat = useChat((s) => s.deleteSession);

  const agentSessions = useAgent((s) => s.sessions);
  const selectAgent = useAgent((s) => s.selectSession);
  const deleteAgent = useAgent((s) => s.deleteSession);

  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"chat" | "agent">("chat");

  const filteredChat = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return chatSessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(
        (s) =>
          !needle ||
          s.title.toLowerCase().includes(needle) ||
          s.model.toLowerCase().includes(needle),
      );
  }, [chatSessions, q]);

  const filteredAgent = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agentSessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(
        (s) =>
          !needle ||
          s.title.toLowerCase().includes(needle) ||
          s.model.toLowerCase().includes(needle) ||
          s.goal.toLowerCase().includes(needle),
      );
  }, [agentSessions, q]);

  return (
    <div className="h-full flex flex-col">
      <header className="px-3 py-2 border-b border-noir-line bg-noir-chrome/40 flex items-center gap-2">
        <History size={12} className="text-noir-accent" />
        <span className="font-sans text-[12px] text-noir-text">History</span>
        <span className="text-[10px] text-noir-mute font-sans">
          {chatSessions.length + agentSessions.length} sessions
        </span>
      </header>
      <div className="px-3 py-2 border-b border-noir-line space-y-2 bg-noir-chrome/20">
        <div className="relative" role="search">
          <Search
            size={11}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-noir-mute pointer-events-none"
            aria-hidden="true"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter sessions…"
            className="pn-input w-full pl-7 font-mono text-[11.5px]"
            aria-label="Filter chat and agent sessions"
            type="search"
          />
        </div>
        <div
          className="flex items-center bg-noir-panel border border-noir-line rounded-md p-0.5 text-[10.5px] font-sans"
          role="tablist"
          aria-label="Session history type"
        >
          <TabButton current={tab} value="chat" onClick={setTab}>
            <Bot size={10} aria-hidden="true" /> Chat ({chatSessions.length})
          </TabButton>
          <TabButton current={tab} value="agent" onClick={setTab}>
            <ScrollText size={10} aria-hidden="true" /> Agent ({agentSessions.length})
          </TabButton>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "chat" ? (
          <ChatList
            list={filteredChat}
            onOpen={(id) => {
              selectChat(id);
              onNavigate("assistant");
            }}
            onDelete={deleteChat}
          />
        ) : (
          <AgentList
            list={filteredAgent}
            onOpen={(id) => {
              selectAgent(id);
              onNavigate("assistant");
            }}
            onDelete={deleteAgent}
          />
        )}
      </div>
    </div>
  );
}

function TabButton<T extends string>({
  current,
  value,
  onClick,
  children,
}: {
  current: T;
  value: T;
  onClick: (v: T) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      role="tab"
      aria-selected={active}
      className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded transition-colors ${
        active
          ? "bg-noir-accent/20 text-noir-accent"
          : "text-noir-mute hover:text-noir-text"
      }`}
    >
      {children}
    </button>
  );
}

function ChatList({
  list,
  onOpen,
  onDelete,
}: {
  list: ChatSession[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isStale = useStaleSessionModelPredicate();
  if (list.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-noir-mute">
        No chats yet. Start one from the chat view.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-noir-line/40">
      {list.map((s) => {
        const stale = isStale(s.model);
        return (
          <li key={s.id} className="group flex items-center hover:bg-noir-ridge/30">
            <button
              onClick={() => onOpen(s.id)}
              className="flex-1 text-left px-3 py-2 min-w-0"
              aria-label={`Open chat session ${s.title}${stale ? ` (model ${s.model} not installed)` : ""}`}
            >
              <div className="font-sans text-[11.5px] text-noir-text truncate flex items-center gap-1.5">
                {s.title}
                <ChevronRight size={10} className="text-noir-mute opacity-60" aria-hidden="true" />
              </div>
              <div
                className={`font-mono text-[10px] truncate ${
                  stale ? "text-noir-warn" : "text-noir-mute"
                }`}
                title={stale ? `${s.model} isn't installed` : undefined}
              >
                {s.model}
                {stale && (
                  <span className="ml-1 text-[9px] uppercase tracking-wider">
                    · not installed
                  </span>
                )}
                <span className="text-noir-mute">
                  {" "}· {s.messages.length} msg · {formatWhen(s.updatedAt)}
                </span>
              </div>
            </button>
            <DeleteButton onClick={() => onDelete(s.id)} />
          </li>
        );
      })}
    </ul>
  );
}

function AgentList({
  list,
  onOpen,
  onDelete,
}: {
  list: AgentSession[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isStale = useStaleSessionModelPredicate();
  if (list.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-noir-mute">
        No agent runs yet. Start one from the agent view.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-noir-line/40">
      {list.map((s) => {
        const stale = isStale(s.model);
        return (
          <li key={s.id} className="group flex items-center hover:bg-noir-ridge/30">
            <button
              onClick={() => onOpen(s.id)}
              className="flex-1 text-left px-3 py-2 min-w-0"
            >
              <div className="font-sans text-[11.5px] text-noir-text truncate flex items-center gap-1.5">
                {s.title}
                <ChevronRight size={10} className="text-noir-mute opacity-60" />
              </div>
              <div
                className={`font-mono text-[10px] truncate ${
                  stale ? "text-noir-warn" : "text-noir-mute"
                }`}
                title={stale ? `${s.model} isn't installed` : undefined}
              >
                <span className="text-noir-mute">{s.mode} · </span>
                {s.model}
                {stale && (
                  <span className="ml-1 text-[9px] uppercase tracking-wider">
                    · not installed
                  </span>
                )}
                <span className="text-noir-mute">
                  {" "}· {s.events.length} events · {s.status} · {formatWhen(s.updatedAt)}
                </span>
              </div>
            </button>
            <DeleteButton onClick={() => onDelete(s.id)} />
          </li>
        );
      })}
    </ul>
  );
}

function DeleteButton({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="opacity-0 group-hover:opacity-100 p-2 text-noir-mute hover:text-noir-err transition-opacity"
      title="Delete"
      aria-label={label ?? "Delete session"}
    >
      <Trash2 size={11} aria-hidden="true" />
    </button>
  );
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const sameDay =
    new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (now - ts < 7 * dayMs) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString();
}
