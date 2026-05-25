/**
 * Plan card — surfaces the model's accumulated `<plan>` blocks
 * with an "Execute as Agent" call-to-action.
 *
 * The promotion path calls `useAssistant.executePlan`, which
 * carries forward the session's transcript + ledger so the new
 * Agent run starts already knowing what the plan turn looked at
 * (no re-exploration).
 *
 * Rendered ONLY when the session is in plan mode AND there's at
 * least one `<plan>` event on the session. In agent/ask mode the
 * card is hidden — the same blocks would still be visible inline
 * with the streamed reasoning, but the Execute button only makes
 * sense for plan output.
 */
import { useMemo } from "react";
import { Play, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssistantSession } from "@/store/assistant";
import { useAssistant } from "@/store/assistant";

export function PlanCard({ session }: { session: AssistantSession }) {
  const executePlan = useAssistant((s) => s.executePlan);
  const planText = useMemo(() => {
    return session.events
      .filter((e) => e.kind === "plan")
      .map((e) => (e.kind === "plan" ? e.text : ""))
      .join("\n\n")
      .trim();
  }, [session.events]);

  if (session.mode !== "plan") return null;
  if (!planText) return null;

  const busy = session.status === "running";

  return (
    <div className="mx-3 my-3 rounded-md border border-noir-accent/30 bg-noir-accent/5">
      <div className="px-3 py-2 border-b border-noir-accent/20 flex items-center gap-2">
        <Sparkles size={12} className="text-noir-accent" aria-hidden="true" />
        <span className="text-[11px] font-sans font-medium text-noir-text">
          Plan ready
        </span>
        <span className="text-[10px] font-sans text-noir-mute ml-auto">
          {planText.split(/\n+/).filter((l) => l.trim()).length} step
          {planText.split(/\n+/).filter((l) => l.trim()).length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="px-3 py-2 max-h-64 overflow-y-auto text-[11.5px] text-noir-text font-sans prose-pn">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{planText}</ReactMarkdown>
      </div>
      <div className="px-3 py-2 border-t border-noir-accent/20 flex items-center gap-2">
        <button
          onClick={() => executePlan(session.id)}
          disabled={busy}
          className={[
            "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-sans",
            "bg-noir-accent text-noir-bg hover:bg-noir-accent/90",
            busy ? "opacity-50 cursor-not-allowed" : "",
          ].join(" ")}
          title="Run this plan with the full Agent loop. Pointer will reuse what it already explored — no re-reads."
        >
          <Play size={10} aria-hidden="true" />
          Execute as Agent
        </button>
        <span className="text-[10px] font-sans text-noir-mute">
          Carries forward the plan's transcript + ledger.
        </span>
      </div>
    </div>
  );
}
