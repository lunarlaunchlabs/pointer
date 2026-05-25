/**
 * Unified Assistant right-dock view.
 *
 * One panel replaces the two old right-dock surfaces (Chat and
 * Agent). Mode picker at the top toggles between Ask | Plan |
 * Agent without losing the session's transcript or action ledger,
 * so the user can pivot from "explain this code" to "now make the
 * change" without restarting.
 */
import { useEffect, useRef } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAssistant, type AssistantSession } from "@/store/assistant";
import {
  featureBlockReason,
  isFeatureUsable,
  useSettings,
} from "@/store/settings";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import { buildContext } from "@/lib/buildContext";
import { Composer } from "@/components/Chat/Composer";
import { ModePicker } from "./ModePicker";
import { PlanCard } from "./PlanCard";

export function AssistantView() {
  const sessions = useAssistant((s) => s.sessions);
  const active = useAssistant((s) => s.getActive());
  const activeId = useAssistant((s) => s.activeSessionId);
  const ensureActive = useAssistant((s) => s.ensureActive);
  const newSession = useAssistant((s) => s.newSession);
  const setSessionMode = useAssistant((s) => s.setSessionMode);
  const deleteSession = useAssistant((s) => s.deleteSession);
  const selectSession = useAssistant((s) => s.selectSession);
  const send = useAssistant((s) => s.send);
  const cancel = useAssistant((s) => s.cancel);
  const pendingRefs = useAssistant((s) => s.pendingRefs);
  const addRef = useAssistant((s) => s.addRef);
  const removeRef = useAssistant((s) => s.removeRef);

  const chatModel = useSettings((s) => s.chatModel);
  const chatUsable = useSettings((s) => isFeatureUsable("chat", s));
  const chatBlock = useSettings((s) => featureBlockReason("chat", s));
  const indexUsable = useSettings((s) => isFeatureUsable("indexing", s));
  const embedModel = useSettings((s) => s.embedModel);
  const editor = useEditorStore((s) => s.getActive());
  const root = useWorkspace((s) => s.root);

  // Eagerly materialize a session when the user opens the panel and
  // chat is usable. New sessions default to Ask mode — the picker
  // is one click away if the user wants Plan/Agent.
  useEffect(() => {
    if (!activeId && chatUsable) {
      ensureActive(chatModel, "ask");
    }
  }, [activeId, chatUsable, chatModel, ensureActive]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [active?.messages.length, active?.status]);

  const buildAssistantContext = (refs: Parameters<typeof buildContext>[0]) =>
    buildContext(refs, {
      budgetTokens: 6000,
      embedModel,
      codebaseUsable: indexUsable,
      currentFile: editor
        ? { path: editor.path, content: editor.content }
        : null,
    });

  const onSend = (text: string) => {
    void send(text, {
      defaultModel: chatModel,
      buildContext: buildAssistantContext,
    });
  };

  const running = active?.status === "running";

  return (
    <div className="flex flex-col h-full bg-noir-bg">
      <SessionBar
        sessions={sessions}
        active={active}
        activeId={activeId}
        onNew={() => newSession({ mode: "ask", model: chatModel })}
        onSelect={(id) => selectSession(id)}
        onDelete={(id) => deleteSession(id)}
      />
      <div className="px-3 py-2 border-b border-noir-line bg-noir-chrome/30 flex items-center gap-2">
        <ModePicker
          value={active?.mode ?? "ask"}
          onChange={(m) => active && setSessionMode(active.id, m)}
          disabled={running || !active}
        />
        {running && (
          <span className="text-[10px] font-sans text-noir-mute ml-auto animate-pulse">
            running…
          </span>
        )}
      </div>
      {!chatUsable && chatBlock && (
        <div className="mx-3 mt-3 rounded-md border border-noir-warn/40 bg-noir-warn/5 px-3 py-2 text-[11px] font-sans text-noir-warn">
          <div className="font-medium">Assistant isn't ready</div>
          <div className="text-[10.5px] opacity-80 mt-0.5">{chatBlock}</div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {active ? (
          <>
            {active.messages.length === 0 && active.events.length === 0 && (
              <Empty mode={active.mode} />
            )}
            {active.messages.map((m) => (
              <MessageRow key={m.id} role={m.role} content={m.content} />
            ))}
            <PlanCard session={active} />
            {active.ledger.length > 0 && <LedgerTrace session={active} />}
          </>
        ) : (
          <Empty mode="ask" />
        )}
      </div>
      <Composer
        disabled={!chatUsable || !active}
        streaming={running}
        onSend={onSend}
        onCancel={() => void cancel()}
        references={pendingRefs}
        onAddReference={addRef}
        onRemoveReference={removeRef}
        placeholder={placeholderFor(active?.mode ?? "ask")}
        submitHint={`${active?.mode ?? "ask"} mode · ⌘↩ to send`}
      />
    </div>
  );
}

function placeholderFor(mode: "ask" | "plan" | "agent"): string {
  switch (mode) {
    case "ask":
      return "Ask anything about this codebase…";
    case "plan":
      return "Describe what you want planned — Pointer will read but not edit.";
    case "agent":
      return "Describe the task — Pointer will read, edit, and run commands as needed.";
  }
}

function Empty({ mode }: { mode: "ask" | "plan" | "agent" }) {
  return (
    <div className="px-6 py-10 text-center text-[11.5px] font-sans text-noir-mute">
      <Bot size={20} className="mx-auto mb-2 opacity-50" aria-hidden="true" />
      <div className="text-noir-text font-medium mb-1">
        {mode === "ask" ? "Ask Pointer anything" : mode === "plan" ? "Plan a change" : "Run an agent"}
      </div>
      <div className="text-[10.5px] leading-relaxed max-w-xs mx-auto">
        {placeholderFor(mode)}
      </div>
    </div>
  );
}

function MessageRow({ role, content }: { role: "user" | "assistant" | "system"; content: string }) {
  if (role === "system") return null;
  const isUser = role === "user";
  return (
    <div
      className={[
        "px-4 py-2 border-b border-noir-line/30",
        isUser ? "bg-noir-canvas/20" : "",
      ].join(" ")}
    >
      <div className="text-[9.5px] uppercase tracking-wider text-noir-mute font-sans mb-1">
        {isUser ? "you" : "pointer"}
      </div>
      <div className="text-[11.5px] text-noir-text font-sans prose-pn">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "…"}</ReactMarkdown>
      </div>
    </div>
  );
}

/** Compact "what's in the ledger" footer. Lets the user see the
 *  factual record Pointer is carrying into the next turn so the
 *  intelligent-history behaviour isn't a black box. */
function LedgerTrace({ session }: { session: AssistantSession }) {
  // Show the last 5 entries — enough for the user to see what
  // happened recently without dominating the panel.
  const recent = session.ledger.slice(-5);
  return (
    <div className="mx-3 my-3 rounded-md border border-noir-line bg-noir-canvas/20">
      <div className="px-3 py-1.5 border-b border-noir-line text-[10px] uppercase tracking-wider text-noir-mute font-sans">
        Ledger · last {recent.length} of {session.ledger.length}
      </div>
      <ul className="px-3 py-1.5 space-y-0.5 text-[10.5px] font-mono text-noir-mute">
        {recent.map((entry, i) => (
          <li key={i}>
            <span className="text-noir-accent">T{entry.turn}</span>{" "}
            {describeEntry(entry)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeEntry(entry: AssistantSession["ledger"][number]): string {
  switch (entry.kind.type) {
    case "wrote":
      return `wrote ${entry.kind.path} (${entry.kind.bytes}B, ${entry.kind.hunks} hunk${entry.kind.hunks === 1 ? "" : "s"})`;
    case "deleted":
      return `deleted ${entry.kind.path}`;
    case "renamed":
      return `renamed ${entry.kind.from} → ${entry.kind.to}`;
    case "symbol_renamed":
      return `renamed ${entry.kind.old} → ${entry.kind.new} (${entry.kind.references_replaced} refs)`;
    case "ran_shell":
      return `ran: ${entry.kind.command_summary} (exit ${entry.kind.exit_code})`;
    case "read":
      return `read: ${entry.kind.paths.slice(0, 3).join(", ")}${entry.kind.paths.length > 3 ? ` (+${entry.kind.paths.length - 3})` : ""}`;
    case "searched":
      return `searched: ${entry.kind.queries.slice(0, 2).join(", ")}`;
    case "answered_only":
      return `answered: ${entry.kind.summary}`;
  }
}

function SessionBar({
  sessions,
  active,
  activeId,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: AssistantSession[];
  active: AssistantSession | null;
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="px-3 py-2 border-b border-noir-line bg-noir-chrome/40 flex items-center gap-2">
      <button
        onClick={onNew}
        className="p-1 rounded text-noir-mute hover:text-noir-accent hover:bg-noir-accent/10"
        title="New session"
        aria-label="New assistant session"
      >
        <Plus size={11} aria-hidden="true" />
      </button>
      <select
        value={activeId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        className="flex-1 min-w-0 text-[11.5px] font-sans bg-noir-panel border border-noir-line rounded px-2 py-1 text-noir-text"
      >
        {sessions.length === 0 && <option value="">New assistant</option>}
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            [{s.mode}] {s.title}
          </option>
        ))}
      </select>
      {active && (
        <button
          onClick={() => onDelete(active.id)}
          className="p-1 rounded text-noir-mute hover:text-noir-err"
          title="Delete session"
          aria-label="Delete current assistant session"
        >
          <Trash2 size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
