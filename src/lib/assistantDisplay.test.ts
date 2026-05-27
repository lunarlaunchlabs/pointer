import { describe, expect, it } from "vitest";
import { agentActivityItems, visibleEventOutputs } from "./assistantDisplay";
import type { AgentEvent } from "@/store/agentSessions";

describe("assistant display helpers", () => {
  it("surfaces final events that are not already visible messages", () => {
    const events: AgentEvent[] = [
      { kind: "final", step: 4, text: "Done: updated src/App.jsx." },
      { kind: "clarify", step: 5, text: "Which route should I change?" },
    ];
    expect(visibleEventOutputs(events, ["Done: updated src/App.jsx."])).toEqual([
      {
        key: "clarify:5:1",
        tone: "clarify",
        title: "Question",
        text: "Which route should I change?",
      },
    ]);
  });

  it("turns tool calls into readable activity instead of ledger turn codes", () => {
    const events: AgentEvent[] = [
      {
        kind: "tool_call",
        step: 1,
        tool: "search_codebase",
        attrs: {},
        args: "auth service",
      },
      {
        kind: "tool_call",
        step: 2,
        tool: "read_file",
        attrs: { path: "src/services/auth.js" },
        args: "",
      },
      {
        kind: "tool_call",
        step: 3,
        tool: "edit_file",
        attrs: { path: "src/services/auth.js" },
        args: "",
      },
      {
        kind: "tool_result",
        step: 3,
        tool: "edit_file",
        status: "ok",
        result: "applied 1 hunk",
        extra: {},
      },
    ];
    expect(agentActivityItems(events).map((item) => item.label)).toEqual([
      "Searched codebase for “auth service”",
      "Read src/services/auth.js",
      "Edited src/services/auth.js",
      "Edit File completed",
    ]);
  });
});
