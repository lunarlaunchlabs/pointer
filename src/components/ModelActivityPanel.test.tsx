import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelActivityPanel } from "./ModelActivityPanel";
import { ipc, type InferenceSnapshot, type SystemLoadSnapshot } from "@/lib/ipc";
import { useModelWorkflows } from "@/store/modelWorkflows";

const idle: InferenceSnapshot = {
  active: [],
  active_count: 0,
  updated_at_ms: Date.now(),
};

const system: SystemLoadSnapshot = {
  cpu_percent: 23,
  cpu_count: 8,
  mem_total: 32 * 1024 ** 3,
  mem_used: 11 * 1024 ** 3,
  pointer_cpu_percent: 2,
  pointer_mem_bytes: 512 * 1024 ** 2,
};

vi.mock("@/lib/ipc", async () => ({
  ipc: {
    inferenceStatus: vi.fn(),
    inferenceCancel: vi.fn(),
    systemLoadSnapshot: vi.fn(),
    ollamaPs: vi.fn(),
    ollamaUnloadModel: vi.fn(),
  },
  listenEvent: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@/components/Toast", () => ({
  toast: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useModelWorkflows.setState({ workflows: [] });
  vi.mocked(ipc.inferenceStatus).mockResolvedValue(idle);
  vi.mocked(ipc.inferenceCancel).mockResolvedValue(true);
  vi.mocked(ipc.systemLoadSnapshot).mockResolvedValue(system);
  vi.mocked(ipc.ollamaPs).mockResolvedValue([]);
  vi.mocked(ipc.ollamaUnloadModel).mockResolvedValue();
});

describe("<ModelActivityPanel>", () => {
  it("renders idle state from the runtime snapshot", async () => {
    render(<ModelActivityPanel />);
    expect(await screen.findByText("Model activity")).toBeInTheDocument();
    expect(await screen.findAllByText("Idle")).toHaveLength(1);
  });

  it("shows active jobs and cancels by request id", async () => {
    vi.mocked(ipc.inferenceStatus).mockResolvedValue({
      active_count: 1,
      updated_at_ms: Date.now(),
      active: [
        {
          request_id: "agent_123",
          model: "qwen2.5-coder:7b-instruct",
          kind: "agent",
          title: "Agent run",
          started_at_ms: Date.now() - 2_000,
          updated_at_ms: Date.now(),
          token_count: 42,
          cancellable: true,
          interruptible: false,
          cancelling: false,
        },
      ],
    });

    const user = userEvent.setup();
    render(<ModelActivityPanel />);

    expect(await screen.findByText("Agent run")).toBeInTheDocument();
    expect(screen.getByText("qwen2.5-coder:7b-instruct")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Cancel Agent run"));
    await waitFor(() =>
      expect(ipc.inferenceCancel).toHaveBeenCalledWith("agent_123"),
    );
  });

  it("shows frontend workflows and cancels the whole run", async () => {
    const store = useModelWorkflows.getState();
    store.startWorkflow({
      id: "commit_run",
      kind: "git_commit",
      title: "Draft commit message",
      currentStep: "Summarize src/App.tsx",
    });
    store.attachRequest("commit_run", "git_commit_1");

    const user = userEvent.setup();
    render(<ModelActivityPanel />);

    expect(await screen.findByText("Active workflows")).toBeInTheDocument();
    expect(screen.getByText("Draft commit message")).toBeInTheDocument();
    expect(screen.getByText("Summarize src/App.tsx")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Cancel whole run Draft commit message"));
    await waitFor(() =>
      expect(ipc.inferenceCancel).toHaveBeenCalledWith("git_commit_1"),
    );
    expect(useModelWorkflows.getState().isCancelling("commit_run")).toBe(true);
  });

  it("unloads a loaded idle model from the activity tab", async () => {
    vi.mocked(ipc.ollamaPs)
      .mockResolvedValueOnce([
        {
          name: "qwen3:8b",
          processor: "gpu",
          size_bytes: 6 * 1024 ** 3,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ])
      .mockResolvedValueOnce([]);

    const user = userEvent.setup();
    render(<ModelActivityPanel />);

    expect(await screen.findByText("qwen3:8b")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Unload qwen3:8b"));

    await waitFor(() =>
      expect(ipc.ollamaUnloadModel).toHaveBeenCalledWith("qwen3:8b"),
    );
    await waitFor(() => expect(screen.queryByText("qwen3:8b")).not.toBeInTheDocument());
  });

  it("keeps unload disabled while a model has active work", async () => {
    vi.mocked(ipc.inferenceStatus).mockResolvedValue({
      active_count: 1,
      updated_at_ms: Date.now(),
      active: [
        {
          request_id: "chat_1",
          model: "ollama/qwen3:8b",
          kind: "chat",
          title: "Ask",
          started_at_ms: Date.now() - 1000,
          updated_at_ms: Date.now(),
          token_count: 12,
          cancellable: true,
          interruptible: false,
          cancelling: false,
        },
      ],
    });
    vi.mocked(ipc.ollamaPs).mockResolvedValue([
      {
        name: "qwen3:8b",
        processor: "gpu",
        size_bytes: 6 * 1024 ** 3,
        expires_at: null,
      },
    ]);

    render(<ModelActivityPanel />);

    expect(await screen.findByText("qwen3:8b")).toBeInTheDocument();
    expect(screen.getByLabelText("Unload qwen3:8b")).toBeDisabled();
  });
});
