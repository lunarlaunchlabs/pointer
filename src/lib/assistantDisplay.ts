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
  const toolCalls = new Map<string, Extract<AgentEvent, { kind: "tool_call" }>>();
  events.forEach((event, index) => {
    const key = `${event.kind}:${"step" in event ? event.step : index}:${index}`;
    if (event.kind === "tool_call") {
      toolCalls.set(toolKey(event.step, event.tool), event);
      items.push({
        key,
        tone: mutatingTool(event.tool) ? "warn" : "neutral",
        label: describeToolCall(event.tool, event.attrs, event.args),
      });
    } else if (event.kind === "tool_result") {
      if (inFlightToolStatus(event.status)) return;
      if (event.status === "ok" && quietSuccessfulResult(event.tool)) return;
      const priorCall = toolCalls.get(toolKey(event.step, event.tool));
      const pathMiss = isPathMissResult(event);
      items.push({
        key,
        tone:
          event.status === "ok"
            ? "ok"
            : event.status === "rejected" || pathMiss
              ? "warn"
              : "error",
        label: describeToolResult(event, priorCall),
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
    } else if (event.kind === "error") {
      items.push({
        key,
        tone: "error",
        label: "Run error",
        detail: firstLine(event.text),
      });
    } else if (event.kind === "shell_progress") {
      items.push({
        key,
        tone: event.stream === "stderr" ? "warn" : "neutral",
        label: "OpenCode output",
        detail: firstLine(event.chunk),
      });
    }
  });
  return items.slice(-limit);
}

export function latestActivityPhase(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "tool_result") {
      const priorCall = previousToolCall(events, i, event.step, event.tool);
      if (inFlightToolStatus(event.status)) {
        return priorCall
          ? describeToolCall(priorCall.tool, priorCall.attrs, priorCall.args)
          : `Running ${friendlyToolName(event.tool)}`;
      }
      const subject = phaseSubject(event.tool, event.extra, priorCall);
      if (event.status === "ok") return `Thinking after ${subject}`;
      if (event.status === "rejected") return `${describeToolResult(event, priorCall)}; waiting`;
      if (isPathMissResult(event)) return `${describeToolResult(event, priorCall)}; trying another path`;
      return `${describeToolResult(event, priorCall)}; recovering`;
    }
    if (event.kind === "tool_call") {
      return describeToolCall(event.tool, event.attrs, event.args);
    }
    if (event.kind === "first_token") return `Writing step ${event.step}`;
    if (event.kind === "request_sent") return `Starting model for step ${event.step}`;
    if (event.kind === "started") {
      return event.mode === "plan" ? "Starting plan" : "Starting agent";
    }
  }
  return null;
}

function describeToolCall(
  tool: string,
  attrs: Record<string, string>,
  args: string,
): string {
  const path = attrPath(attrs) || firstLine(args);
  if (isReadTool(tool)) return path ? `Read ${path}` : "Read file";
  if (isListTool(tool)) return path ? `Listed ${path}` : "Listed files";
  if (isGlobTool(tool)) {
    return `Found files matching ${attrs.pattern || firstLine(args)}`;
  }
  if (isSearchTool(tool)) {
    const scope = attrs.glob || attrs.pattern;
    return `Searched text${scope ? ` in ${scope}` : ""}`;
  }
  if (tool === "search_codebase") return `Searched codebase for ${quote(firstLine(args))}`;
  if (tool === "list_code_definition_names") {
    return path ? `Outlined definitions in ${path}` : "Outlined code definitions";
  }
  if (tool === "apply_diff" || tool === "edit_file") {
    return path ? `Edited ${path}` : "Edited file";
  }
  if (tool === "edit") return path ? `Edited ${path}` : "Edited file";
  if (tool === "write_file" || tool === "write") {
    return path ? `Wrote ${path}` : "Wrote file";
  }
  if (tool === "delete_path" || tool === "delete") {
    return path ? `Deleted ${path}` : "Deleted path";
  }
  if (tool === "rename_path" || tool === "rename" || tool === "move") {
    return attrs.from && attrs.to
      ? `Renamed ${attrs.from} to ${attrs.to}`
      : "Renamed path";
  }
  if (tool === "rename_symbol") return "Renamed symbol";
  if (tool === "run_check") return "Ran project check";
  if (tool === "run_shell" || tool === "bash") {
    return `Ran ${quote(attrs.command || firstLine(args))}`;
  }
  return friendlyToolName(tool);
}

function describeToolResult(
  event: Extract<AgentEvent, { kind: "tool_result" }>,
  priorCall: Extract<AgentEvent, { kind: "tool_call" }> | undefined,
): string {
  const subject = toolSubject(event.tool, event.extra, priorCall);
  if (event.status === "ok") return `${subject} completed`;
  if (event.status === "rejected") return `${subject} rejected`;
  if (isPathMissResult(event)) return `${subject} not found`;
  return `${subject} failed`;
}

function toolSubject(
  tool: string,
  extra: Record<string, unknown>,
  priorCall: Extract<AgentEvent, { kind: "tool_call" }> | undefined,
): string {
  const path = toolPath(extra, priorCall);
  if (isReadTool(tool)) return path ? `Read ${path}` : "Read file";
  if (isListTool(tool)) return path ? `List ${path}` : "List files";
  if (isGlobTool(tool)) return path ? `Glob ${path}` : "Glob";
  if (isSearchTool(tool)) return "Search text";
  if (tool === "search_codebase") return "Search codebase";
  return path ? `${friendlyToolName(tool)} ${path}` : friendlyToolName(tool);
}

function phaseSubject(
  tool: string,
  extra: Record<string, unknown>,
  priorCall: Extract<AgentEvent, { kind: "tool_call" }> | undefined,
): string {
  const path = toolPath(extra, priorCall);
  if (isReadTool(tool)) return path ? `reading ${path}` : "reading a file";
  if (isListTool(tool)) return path ? `listing ${path}` : "listing files";
  if (isGlobTool(tool)) return path ? `matching ${path}` : "matching files";
  if (isSearchTool(tool)) return "searching text";
  if (tool === "search_codebase") return "searching the codebase";
  if (tool === "list_code_definition_names") {
    return path ? `outlining ${path}` : "outlining definitions";
  }
  if (tool === "apply_diff" || tool === "edit_file" || tool === "edit") {
    return path ? `editing ${path}` : "editing a file";
  }
  if (tool === "write_file" || tool === "write") {
    return path ? `writing ${path}` : "writing a file";
  }
  if (tool === "delete_path" || tool === "delete") {
    return path ? `deleting ${path}` : "deleting a path";
  }
  if (tool === "rename_path" || tool === "rename" || tool === "move") {
    return path ? `renaming ${path}` : "renaming a path";
  }
  if (tool === "run_check") return "running checks";
  if (tool === "run_shell" || tool === "bash") return "running a command";
  return friendlyToolName(tool).toLowerCase();
}

function toolPath(
  extra: Record<string, unknown>,
  priorCall: Extract<AgentEvent, { kind: "tool_call" }> | undefined,
): string {
  const extraPath =
    typeof extra.path === "string"
      ? extra.path
      : typeof extra.filePath === "string"
        ? extra.filePath
        : typeof extra.pattern === "string"
          ? extra.pattern
          : typeof extra.from === "string"
            ? extra.from
            : typeof extra.to === "string"
              ? extra.to
              : "";
  return (
    extraPath ||
    attrPath(priorCall?.attrs ?? {}) ||
    firstLine(priorCall?.args ?? "")
  );
}

function attrPath(attrs: Record<string, string>): string {
  return (
    attrs.path ||
    attrs.filePath ||
    attrs.from ||
    attrs.to ||
    attrs.pattern ||
    ""
  );
}

function isReadTool(tool: string): boolean {
  return tool === "read_file" || tool === "read";
}

function isListTool(tool: string): boolean {
  return tool === "list_dir" || tool === "list";
}

function isGlobTool(tool: string): boolean {
  return tool === "glob" || tool === "find";
}

function isSearchTool(tool: string): boolean {
  return tool === "grep" || tool === "search";
}

function inFlightToolStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "queued";
}

function isPathMissResult(event: Extract<AgentEvent, { kind: "tool_result" }>): boolean {
  if (event.status === "ok" || event.status === "rejected") return false;
  if (
    !isReadTool(event.tool) &&
    !isListTool(event.tool) &&
    !isGlobTool(event.tool) &&
    !isSearchTool(event.tool)
  ) {
    return false;
  }
  return /\b(no such file|file not found|not found|enoent|does not exist)\b/i.test(
    event.result,
  );
}

function previousToolCall(
  events: AgentEvent[],
  beforeIndex: number,
  step: number,
  tool: string,
): Extract<AgentEvent, { kind: "tool_call" }> | undefined {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "tool_call" && event.step === step && event.tool === tool) {
      return event;
    }
  }
  return undefined;
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
    isReadTool(tool) ||
    isListTool(tool) ||
    isGlobTool(tool) ||
    isSearchTool(tool) ||
    tool === "search_codebase" ||
    tool === "list_code_definition_names" ||
    tool === "agent_change"
  );
}

function mutatingTool(tool: string): boolean {
  return (
    tool === "apply_diff" ||
    tool === "edit_file" ||
    tool === "edit" ||
    tool === "write_file" ||
    tool === "write" ||
    tool === "delete_path" ||
    tool === "delete" ||
    tool === "rename_path" ||
    tool === "rename" ||
    tool === "move" ||
    tool === "rename_symbol" ||
    tool === "run_shell" ||
    tool === "bash" ||
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

function toolKey(step: number, tool: string): string {
  return `${step}:${tool}`;
}
