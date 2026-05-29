import { describe, expect, it } from "vitest";
import {
  agentActivityItems,
  latestActivityPhase,
  visibleEventOutputs,
} from "./assistantDisplay";
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
      "Edit File src/services/auth.js completed",
    ]);
  });

  it("keeps failed tool results tied to the attempted path and reason", () => {
    const events: AgentEvent[] = [
      {
        kind: "tool_call",
        step: 2,
        tool: "read_file",
        attrs: { path: "app/src/slides/TestSlide.jsx" },
        args: "",
      },
      {
        kind: "tool_result",
        step: 2,
        tool: "read_file",
        status: "error",
        result:
          "ERROR: read_file app/src/slides/TestSlide.jsx: No such file or directory",
        extra: {},
      },
    ];
    expect(agentActivityItems(events)).toEqual([
      {
        key: "tool_call:2:0",
        tone: "neutral",
        label: "Read app/src/slides/TestSlide.jsx",
      },
      {
        key: "tool_result:2:1",
        tone: "warn",
        label: "Read app/src/slides/TestSlide.jsx not found",
        detail:
          "ERROR: read_file app/src/slides/TestSlide.jsx: No such file or directory",
      },
    ]);
    expect(latestActivityPhase(events)).toBe(
      "Read app/src/slides/TestSlide.jsx not found; trying another path",
    );
  });

  it("uses tool body paths when legacy calls omit attrs", () => {
    const events: AgentEvent[] = [
      {
        kind: "tool_call",
        step: 1,
        tool: "read_file",
        attrs: {},
        args: "src/App.jsx",
      },
      {
        kind: "tool_result",
        step: 1,
        tool: "read_file",
        status: "error",
        result: "ERROR: read_file src/App.jsx: permission denied",
        extra: {},
      },
    ];
    expect(agentActivityItems(events).map((item) => item.label)).toEqual([
      "Read src/App.jsx",
      "Read src/App.jsx failed",
    ]);
  });

  it("labels opencode read events with filePath attrs", () => {
    const events: AgentEvent[] = [
      {
        kind: "tool_call",
        step: 3,
        tool: "read",
        attrs: { filePath: "app/src/slides/index.js" },
        args: "{}",
      },
      {
        kind: "tool_result",
        step: 3,
        tool: "read",
        status: "error",
        result: "File not found",
        extra: {},
      },
    ];
    expect(agentActivityItems(events).map((item) => item.label)).toEqual([
      "Read app/src/slides/index.js",
      "Read app/src/slides/index.js not found",
    ]);
    expect(latestActivityPhase(events)).toBe(
      "Read app/src/slides/index.js not found; trying another path",
    );
  });

  it("hides successful opencode read results from the activity tail", () => {
    const events: AgentEvent[] = [
      {
        kind: "tool_call",
        step: 1,
        tool: "read",
        attrs: { filePath: "src/App.jsx" },
        args: "{}",
      },
      {
        kind: "tool_result",
        step: 1,
        tool: "read",
        status: "ok",
        result: "export function App() {}",
        extra: {},
      },
    ];
    expect(agentActivityItems(events).map((item) => item.label)).toEqual([
      "Read src/App.jsx",
    ]);
    expect(latestActivityPhase(events)).toBe("Thinking after reading src/App.jsx");
  });

  it("does not render in-flight opencode tool states as failures", () => {
    const events: AgentEvent[] = [
      {
        kind: "tool_call",
        step: 4,
        tool: "read",
        attrs: { filePath: "src/main.ts" },
        args: "{}",
      },
      {
        kind: "tool_result",
        step: 4,
        tool: "read",
        status: "running",
        result: "",
        extra: {},
      },
    ];
    expect(agentActivityItems(events).map((item) => item.label)).toEqual([
      "Read src/main.ts",
    ]);
    expect(latestActivityPhase(events)).toBe("Read src/main.ts");
  });

  it("surfaces opencode process failures in the activity trace", () => {
    const events: AgentEvent[] = [
      { kind: "started", mode: "plan", depth: 0, workspace: "/repo" },
      {
        kind: "shell_progress",
        stream: "stderr",
        chunk: "File not found: Add a new slide\n",
      },
      {
        kind: "error",
        step: 1,
        text: "opencode exited with exit status: 1\n\nFile not found: Add a new slide",
      },
    ];
    expect(agentActivityItems(events).map((item) => item.label)).toEqual([
      "Started plan",
      "OpenCode output",
      "Run error",
    ]);
    expect(agentActivityItems(events).at(-1)?.detail).toBe(
      "opencode exited with exit status: 1",
    );
  });
});
