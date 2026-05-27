import type { AgentEvent } from "@/store/agentSessions";

export function latestPlanText(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "plan" && event.text.trim()) {
      return event.text.trim();
    }
  }
  return "";
}

export function planStepCount(planText: string): number {
  const lines = planText.split(/\r?\n/);
  const visibleLines: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || /^#{1,6}\s+/.test(line)) continue;
    visibleLines.push(line);
  }
  const listItems = visibleLines.filter((line) =>
    /^(?:[-*+]|\d+[.)]|\[[ xX]\])\s+/.test(line),
  );
  if (listItems.length > 0) return listItems.length;
  return visibleLines.length;
}
