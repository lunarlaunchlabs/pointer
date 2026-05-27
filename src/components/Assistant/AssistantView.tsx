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
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  CircleDashed,
  FileText,
  Plus,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAssistant, type AssistantSession } from "@/store/assistant";
import type { AssistantMode } from "@/store/assistant";
import {
  featureBlockReason,
  isFeatureUsable,
  type AiFeature,
  useSettings,
} from "@/store/settings";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import { buildContext } from "@/lib/buildContext";
import {
  agentActivityItems,
  visibleEventOutputs,
  type ActivityItem,
  type EventOutput,
} from "@/lib/assistantDisplay";
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
  const setSessionModel = useAssistant((s) => s.setSessionModel);
  const deleteSession = useAssistant((s) => s.deleteSession);
  const selectSession = useAssistant((s) => s.selectSession);
  const send = useAssistant((s) => s.send);
  const cancel = useAssistant((s) => s.cancel);
  const pendingRefs = useAssistant((s) => s.pendingRefs);
  const addRef = useAssistant((s) => s.addRef);
  const removeRef = useAssistant((s) => s.removeRef);

  const chatModel = useSettings((s) => s.chatModel);
  const agentModel = useSettings((s) => s.agentModel);
  const indexUsable = useSettings((s) => isFeatureUsable("indexing", s));
  const embedModel = useSettings((s) => s.embedModel);
  const editor = useEditorStore((s) => s.getActive());
  const root = useWorkspace((s) => s.root);

  // Eagerly materialize a session when the user opens the panel and
  // chat is usable. New sessions default to Ask mode — the picker
  // is one click away if the user wants Plan/Agent.
  useEffect(() => {
    if (!activeId && isFeatureUsable("chat")) {
      ensureActive(chatModel, "ask");
    }
  }, [activeId, chatModel, ensureActive]);

  useEffect(() => {
    if (!active || active.status === "running") return;
    const model = modelForMode(active.mode, chatModel, agentModel);
    if (model && active.model !== model) {
      setSessionModel(active.id, model);
    }
  }, [active, chatModel, agentModel, setSessionModel]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [active?.messages.length, active?.events.length, active?.status]);

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
      defaultModel: modelForMode(active?.mode ?? "ask", chatModel, agentModel),
      buildContext: buildAssistantContext,
    });
  };

  const running = active?.status === "running";
  const activeMode = active?.mode ?? "ask";
  const activeFeature = featureForMode(activeMode);
  const modeUsable = useSettings((s) => isFeatureUsable(activeFeature, s));
  const modeBlock = useSettings((s) => featureBlockReason(activeFeature, s));

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
          value={activeMode}
          onChange={(m) => {
            if (!active) return;
            setSessionMode(active.id, m);
            setSessionModel(active.id, modelForMode(m, chatModel, agentModel));
          }}
          disabled={running || !active}
        />
        {running && (
          <span className="text-[10px] font-sans text-noir-mute ml-auto animate-pulse">
            running…
          </span>
        )}
      </div>
      {!modeUsable && modeBlock && (
        <div className="mx-3 mt-3 rounded-md border border-noir-warn/40 bg-noir-warn/5 px-3 py-2 text-[11px] font-sans text-noir-warn">
          <div className="font-medium">Assistant isn't ready</div>
          <div className="text-[10.5px] opacity-80 mt-0.5">{modeBlock}</div>
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
            <EventOutputs session={active} />
            <ActivityTrace session={active} />
            {active.ledger.length > 0 && <LedgerTrace session={active} />}
          </>
        ) : (
          <Empty mode="ask" />
        )}
      </div>
      <Composer
        disabled={!modeUsable || !active}
        streaming={running}
        onSend={onSend}
        onCancel={() => void cancel()}
        references={pendingRefs}
        onAddReference={addRef}
        onRemoveReference={removeRef}
        placeholder={placeholderFor(active?.mode ?? "ask")}
        submitHint={`${active?.mode ?? "ask"} mode · send`}
      />
    </div>
  );
}

function featureForMode(mode: AssistantMode): AiFeature {
  return mode === "ask" ? "chat" : "agent";
}

function modelForMode(mode: AssistantMode, chatModel: string, agentModel: string): string {
  return mode === "ask" ? chatModel : agentModel;
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

function EventOutputs({ session }: { session: AssistantSession }) {
  const visibleMessages = session.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);
  const outputs = visibleEventOutputs(session.events, visibleMessages);
  if (outputs.length === 0) return null;
  return (
    <>
      {outputs.map((output) => (
        <OutputCard key={output.key} output={output} />
      ))}
    </>
  );
}

function OutputCard({ output }: { output: EventOutput }) {
  const error = output.tone === "error";
  const clarify = output.tone === "clarify";
  return (
    <div
      className={[
        "mx-3 my-3 rounded-md border px-3 py-2",
        error
          ? "border-noir-err/40 bg-noir-err/5"
          : clarify
            ? "border-noir-warn/40 bg-noir-warn/5"
            : "border-noir-line bg-noir-canvas/20",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-noir-mute font-sans mb-1.5">
        {error ? (
          <AlertCircle size={12} className="text-noir-err" aria-hidden="true" />
        ) : clarify ? (
          <CircleDashed size={12} className="text-noir-warn" aria-hidden="true" />
        ) : (
          <Bot size={12} className="text-noir-accent" aria-hidden="true" />
        )}
        <span>{output.title}</span>
      </div>
      <div className="text-[11.5px] leading-relaxed text-noir-text font-sans prose-pn">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{output.text}</ReactMarkdown>
      </div>
    </div>
  );
}

function ActivityTrace({ session }: { session: AssistantSession }) {
  const items = agentActivityItems(session.events);
  if (items.length === 0) return null;
  const running = session.status === "running";
  return (
    <details
      open={running}
      className="mx-3 my-3 rounded-md border border-noir-line bg-noir-canvas/15"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-[10px] uppercase tracking-wider text-noir-mute font-sans">
        Activity · {items.length} recent step{items.length === 1 ? "" : "s"}
      </summary>
      <ul className="border-t border-noir-line/70 px-3 py-2 space-y-1.5">
        {items.map((item) => (
          <ActivityRow key={item.key} item={item} />
        ))}
      </ul>
    </details>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon =
    item.tone === "ok"
      ? CheckCircle2
      : item.tone === "error"
        ? AlertCircle
        : item.label.startsWith("Searched")
          ? Search
          : item.label.startsWith("Read") || item.label.startsWith("Listed")
            ? FileText
            : Wrench;
  const color =
    item.tone === "ok"
      ? "text-noir-ok"
      : item.tone === "warn"
        ? "text-noir-warn"
        : item.tone === "error"
          ? "text-noir-err"
          : "text-noir-mute";
  return (
    <li className="flex gap-2 text-[10.5px] font-sans text-noir-mute leading-relaxed">
      <Icon size={12} className={`${color} mt-0.5 shrink-0`} aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-noir-text truncate">{item.label}</div>
        {item.detail && (
          <div className="font-mono text-[10px] text-noir-mute truncate">
            {item.detail}
          </div>
        )}
      </div>
    </li>
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
    <details className="mx-3 my-3 rounded-md border border-noir-line bg-noir-canvas/10">
      <summary className="cursor-pointer select-none px-3 py-2 text-[10px] uppercase tracking-wider text-noir-mute font-sans">
        Memory carried forward · {session.ledger.length}
      </summary>
      <ul className="px-3 py-1.5 space-y-0.5 text-[10.5px] font-mono text-noir-mute">
        {recent.map((entry, i) => (
          <li key={i}>
            <span className="text-noir-accent">Turn {entry.turn}</span>{" "}
            {describeEntry(entry)}
          </li>
        ))}
      </ul>
    </details>
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
