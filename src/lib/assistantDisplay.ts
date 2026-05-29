import type { AgentEvent } from "@/store/agentSessions";

export type EventOutput = {
  key: string;
  tone: "final" | "clarify" | "error";
  title: string;
  text: string;
};

export type ActivityItem = {
  key: string;
  tone: "neutral" | "ok" | "warn" | "error";
  label: string;
  detail?: string;
};

export function visibleEventOutputs(
  events: AgentEvent[],
  visibleAssistantMessages: string[],
): EventOutput[] {
  const visible = new Set(visibleAssistantMessages.map(normalizeText));
  const out: EventOutput[] = [];
  events.forEach((event, index) => {
    if (
      event.kind !== "final" &&
      event.kind !== "clarify" &&
      event.kind !== "error"
    ) {
      return;
    }
    const text = ("text" in event ? event.text : "").trim();
    if (!text || visible.has(normalizeText(text))) return;
    out.push({
      key: `${event.kind}:${event.step ?? index}:${index}`,
      tone: event.kind === "error" ? "error" : event.kind,
      title:
        event.kind === "final"
          ? "Pointer"
          : event.kind === "clarify"
            ? "Question"
            : "Run error",
      text,
    });
  });
  return out;
}

export function agentActivityItems(events: AgentEvent[], limit = 10): ActivityItem[] {
  const items: ActivityItem[] = [];
  events.forEach((event, index) => {
    const key = `${event.kind}:${"step" in event ? event.step : index}:${index}`;
    if (event.kind === "tool_call") {
      items.push({
        key,
        tone: mutatingTool(event.tool) ? "warn" : "neutral",
        label: describeToolCall(event.tool, event.attrs, event.args),
      });
    } else if (event.kind === "tool_result") {
      if (event.status === "ok" && quietSuccessfulResult(event.tool)) return;
      items.push({
        key,
        tone: event.status === "ok" ? "ok" : event.status === "rejected" ? "warn" : "error",
        label:
          event.status === "ok"
            ? `${friendlyToolName(event.tool)} completed`
            : `${friendlyToolName(event.tool)} ${event.status}`,
        detail: firstLine(event.result),
      });
    } else if (event.kind === "approval_request") {
      items.push({
        key,
        tone: "warn",
        label: `Waiting for approval to ${friendlyToolName(event.tool).toLowerCase()}`,
      });
    } else if (event.kind === "verifier") {
      items.push({
        key,
        tone: "ok",
        label: "Verified change",
        detail: firstLine(event.text),
      });
    } else if (event.kind === "started") {
      items.push({
        key,
        tone: "neutral",
        label: event.mode === "plan" ? "Started plan" : "Started agent run",
      });
    } else if (event.kind === "done") {
      items.push({
        key,
        tone: "ok",
        label: "Run finished",
        detail: event.termination,
      });
    } else if (event.kind === "cancelled") {
      items.push({ key, tone: "warn", label: "Run cancelled" });
    }
  });
  return items.slice(-limit);
}

function describeToolCall(
  tool: string,
  attrs: Record<string, string>,
  args: string,
): string {
  const path = attrs.path || attrs.from || attrs.to;
  if (tool === "read_file") return path ? `Read ${path}` : "Read file";
  if (tool === "list_dir") return path ? `Listed ${path}` : "Listed files";
  if (tool === "glob") return `Found files matching ${firstLine(args)}`;
  if (tool === "grep") return `Searched text${attrs.glob ? ` in ${attrs.glob}` : ""}`;
  if (tool === "search_codebase") return `Searched codebase for ${quote(firstLine(args))}`;
  if (tool === "list_code_definition_names") {
    return path ? `Outlined definitions in ${path}` : "Outlined code definitions";
  }
  if (tool === "apply_diff" || tool === "edit_file") {
    return path ? `Edited ${path}` : "Edited file";
  }
  if (tool === "write_file") return path ? `Wrote ${path}` : "Wrote file";
  if (tool === "delete_path") return path ? `Deleted ${path}` : "Deleted path";
  if (tool === "rename_path") {
    return attrs.from && attrs.to
      ? `Renamed ${attrs.from} to ${attrs.to}`
      : "Renamed path";
  }
  if (tool === "rename_symbol") return "Renamed symbol";
  if (tool === "run_check") return "Ran project check";
  if (tool === "run_shell") return `Ran ${quote(firstLine(args))}`;
  return friendlyToolName(tool);
}

function friendlyToolName(tool: string): string {
  return tool
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function quietSuccessfulResult(tool: string): boolean {
  return (
    tool === "read_file" ||
    tool === "list_dir" ||
    tool === "glob" ||
    tool === "grep" ||
    tool === "search_codebase" ||
    tool === "list_code_definition_names" ||
    tool === "agent_change"
  );
}

function mutatingTool(tool: string): boolean {
  return (
    tool === "apply_diff" ||
    tool === "edit_file" ||
    tool === "write_file" ||
    tool === "delete_path" ||
    tool === "rename_path" ||
    tool === "rename_symbol" ||
    tool === "run_shell" ||
    tool === "run_check"
  );
}

function firstLine(text: string): string {
  return text.trim().split(/\n/, 1)[0]?.trim().slice(0, 160) ?? "";
}

function quote(text: string): string {
  return text ? `“${text.slice(0, 80)}”` : "query";
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
