import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useModelWorkflows } from "./modelWorkflows";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    inferenceCancel: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.inferenceCancel).mockResolvedValue(true);
  useModelWorkflows.setState({ workflows: [] });
});

describe("model workflow store", () => {
  it("tracks a whole workflow across many request ids", () => {
    const store = useModelWorkflows.getState();
    store.startWorkflow({
      id: "run_1",
      kind: "git_commit",
      title: "Draft commit message",
    });
    store.attachRequest("run_1", "req_a", "Summarize file");
    store.attachRequest("run_1", "req_b", "Judge summary");
    store.detachRequest("run_1", "req_a");

    const workflow = useModelWorkflows.getState().workflows[0];
    expect(workflow.currentStep).toBe("Judge summary");
    expect(workflow.activeRequestIds).toEqual(["req_b"]);
  });

  it("cancels every active request in a workflow", async () => {
    const store = useModelWorkflows.getState();
    store.startWorkflow({
      id: "run_1",
      kind: "git_commit",
      title: "Draft commit message",
    });
    store.attachRequest("run_1", "req_a");
    store.attachRequest("run_1", "req_b");

    await store.cancelWorkflow("run_1");

    expect(useModelWorkflows.getState().isCancelling("run_1")).toBe(true);
    expect(ipc.inferenceCancel).toHaveBeenCalledWith("req_a");
    expect(ipc.inferenceCancel).toHaveBeenCalledWith("req_b");
  });
});
