import { describe, expect, it } from "vitest";
import { latestPlanText, planStepCount } from "./assistantPlans";
import type { AgentEvent } from "@/store/agentSessions";

describe("assistant plan helpers", () => {
  it("uses the latest non-empty plan block as the executable plan", () => {
    const events: AgentEvent[] = [
      { kind: "plan", step: 1, text: "1. Inspect files first" },
      { kind: "thought", step: 2, text: "I found the component." },
      {
        kind: "plan",
        step: 3,
        text: "1. Edit src/App.jsx to add the route.\n2. Verify with npm test.",
      },
    ];
    expect(latestPlanText(events)).toBe(
      "1. Edit src/App.jsx to add the route.\n2. Verify with npm test.",
    );
  });

  it("counts markdown list items as plan steps", () => {
    expect(planStepCount("1. Edit src/App.jsx\n\n2. Verify with npm test")).toBe(2);
  });

  it("does not count headings or fenced examples as plan steps", () => {
    expect(
      planStepCount(
        [
          "## Plan",
          "",
          "- Inspect the component",
          "- Add the slide",
          "```tsx",
          "const notAPlanStep = true;",
          "```",
        ].join("\n"),
      ),
    ).toBe(2);
  });
});
