import { describe, expect, it } from "vitest";
import {
  appendAgentEvent,
  SHELL_PROGRESS_TAIL_CHARS,
  type AgentEvent,
} from "./agentSessions";

/**
 * Regression coverage for the "app hangs while creating an npx
 * react app" bug. With the prior implementation, each stdout/stderr
 * chunk emitted by a chatty install became its own `shell_progress`
 * event in the persisted session. `npm install` typically emits
 * thousands of lines, which (a) tanked React rendering and (b)
 * blew up the persisted session JSON.
 *
 * The fix coalesces consecutive chunks for the same (request, stream)
 * into a single event holding only the last ~16 KB of output (the
 * "live tail"). These tests pin that behaviour.
 */
describe("appendAgentEvent (shell_progress coalescing)", () => {
  const chunk = (stream: "stdout" | "stderr", text: string): AgentEvent => ({
    kind: "shell_progress",
    request_id: "req-1",
    stream,
    chunk: text,
  });

  it("merges consecutive chunks of the same stream into one event", () => {
    let events: AgentEvent[] = [];
    events = appendAgentEvent(events, chunk("stdout", "fetching... "));
    events = appendAgentEvent(events, chunk("stdout", "installing... "));
    events = appendAgentEvent(events, chunk("stdout", "done\n"));
    expect(events).toHaveLength(1);
    const merged = events[0];
    expect(merged.kind).toBe("shell_progress");
    if (merged.kind === "shell_progress") {
      expect(merged.chunk).toBe("fetching... installing... done\n");
    }
  });

  it("keeps separate events for stdout vs stderr", () => {
    let events: AgentEvent[] = [];
    events = appendAgentEvent(events, chunk("stdout", "ok\n"));
    events = appendAgentEvent(events, chunk("stderr", "warn\n"));
    events = appendAgentEvent(events, chunk("stdout", "ok 2\n"));
    expect(events.map((e) => (e.kind === "shell_progress" ? e.stream : null))).toEqual([
      "stdout",
      "stderr",
      "stdout",
    ]);
  });

  it("does not coalesce across other events", () => {
    let events: AgentEvent[] = [];
    events = appendAgentEvent(events, chunk("stdout", "a"));
    events = appendAgentEvent(events, {
      kind: "tool_call",
      step: 2,
      tool: "read_file",
      attrs: {},
      args: "",
    });
    events = appendAgentEvent(events, chunk("stdout", "b"));
    expect(events).toHaveLength(3);
  });

  it("trims the merged buffer to the last SHELL_PROGRESS_TAIL_CHARS bytes", () => {
    let events: AgentEvent[] = [];
    // Pile on 50 KB — well above the 16 KB cap.
    for (let i = 0; i < 50; i++) {
      events = appendAgentEvent(events, chunk("stdout", "X".repeat(1024)));
    }
    expect(events).toHaveLength(1);
    const last = events[0];
    if (last.kind !== "shell_progress") throw new Error("unexpected event shape");
    expect(last.chunk.length).toBe(SHELL_PROGRESS_TAIL_CHARS);
    // Tail should be the most-recently-pushed bytes (all 'X').
    expect(last.chunk).toMatch(/^X+$/);
  });

  it("does not coalesce chunks across different requests", () => {
    let events: AgentEvent[] = [];
    events = appendAgentEvent(events, { kind: "shell_progress", request_id: "req-a", stream: "stdout", chunk: "a" });
    events = appendAgentEvent(events, { kind: "shell_progress", request_id: "req-b", stream: "stdout", chunk: "b" });
    expect(events).toHaveLength(2);
  });
});
