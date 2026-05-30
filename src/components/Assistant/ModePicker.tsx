/**
 * Mode picker for the unified Assistant.
 *
 * Segmented control surfacing Ask | Plan | Agent. Disabled while
 * a turn is running so a mid-stream switch can't orphan the
 * active request. Selecting Plan or Agent while the session
 * already has plan/agent history preserves the transcript so the
 * user can pivot mid-conversation.
 *
 * Tooltips spell out what each mode actually does so the user
 * doesn't have to guess (the difference between Plan and Agent
 * is non-obvious otherwise).
 */
import { Bot, ClipboardList, MessageSquare } from "@/lib/lucide";
import type { AssistantMode } from "@/store/assistant";

const OPTIONS: Array<{
  id: AssistantMode;
  label: string;
  icon: typeof Bot;
  description: string;
}> = [
  {
    id: "ask",
    label: "Ask",
    icon: MessageSquare,
    description:
      "Conversational mode. No tools, no edits — fastest path for explanations and questions.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    description:
      "Read-only loop. Pointer explores the workspace and produces a plan you can then promote to Agent.",
  },
  {
    id: "agent",
    label: "Agent",
    icon: Bot,
    description:
      "Full mutation loop. Pointer can read, search, edit, and run shell commands to complete the task.",
  },
];

export function ModePicker({
  value,
  onChange,
  disabled,
}: {
  value: AssistantMode;
  onChange: (m: AssistantMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Assistant mode"
      className="inline-flex items-stretch gap-0.5 rounded-md border border-noir-line bg-noir-panel p-0.5"
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            role="radio"
            aria-checked={active}
            aria-label={`${opt.label} mode — ${opt.description}`}
            title={opt.description}
            disabled={disabled}
            onClick={() => !disabled && opt.id !== value && onChange(opt.id)}
            className={[
              "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-sans",
              "transition-colors",
              active
                ? "bg-noir-accent/15 text-noir-accent"
                : "text-noir-mute hover:text-noir-text hover:bg-noir-ridge/40",
              disabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
          >
            <Icon size={11} aria-hidden="true" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
