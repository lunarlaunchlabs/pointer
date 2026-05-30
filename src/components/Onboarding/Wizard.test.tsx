import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Onboarding } from "./Wizard";
import { usePulls } from "@/store/pulls";
import { useSettings } from "@/store/settings";

const recommendations = [
  {
    id: "qwen2.5-coder:7b-instruct",
    purpose: "chat",
    size_gb: 4.4,
    min_ram_gb: 8,
    description: "General coding chat and agent work.",
    recommended: true,
  },
  {
    id: "qwen2.5-coder:1.5b-base",
    purpose: "fim",
    size_gb: 1.1,
    min_ram_gb: 4,
    description: "Fast fill-in-the-middle completions.",
    recommended: true,
  },
  {
    id: "nomic-embed-text",
    purpose: "embed",
    size_gb: 0.3,
    min_ram_gb: 4,
    description: "Codebase indexing embeddings.",
    recommended: true,
  },
] as const;

function mockRuntime(installedModels: string[]) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "ollama_status") {
      return {
        installed: true,
        running: true,
        version: "0.9.0",
        base_url: "http://127.0.0.1:11434",
      };
    }
    if (cmd === "ollama_list_models") {
      return installedModels.map((name) => ({
        name,
        size: null,
        modified_at: null,
      }));
    }
    if (cmd === "recommend_models") return recommendations;
    if (cmd === "system_memory_gb") return 64;
    throw new Error(`unexpected invoke ${cmd}`);
  });
}

function resetSettings() {
  useSettings.setState({
    hydrated: true,
    onboarded: false,
    ollamaReady: false,
    installedModels: [],
    chatModel: "qwen2.5-coder:7b-instruct",
    agentModel: "qwen2.5-coder:7b-instruct",
    fimModel: "qwen2.5-coder:1.5b-base",
    embedModel: "nomic-embed-text",
    chatEnabled: true,
    agentEnabled: true,
    inlineEditEnabled: true,
    fimEnabled: true,
    indexingEnabled: true,
  });
  usePulls.setState({ active: {} });
}

describe("<Onboarding>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettings();
  });

  it("reruns as a live setup review and preserves valid existing assignments", async () => {
    mockRuntime([
      "gemma4:31b",
      "qwen2.5-coder:1.5b-base",
      "nomic-embed-text:latest",
    ]);
    useSettings.setState({
      onboarded: true,
      chatModel: "gemma4:31b",
      agentModel: "gemma4:31b",
      fimModel: "qwen2.5-coder:1.5b-base",
      embedModel: "nomic-embed-text",
    });

    const user = userEvent.setup();
    render(<Onboarding onDone={vi.fn()} />);

    expect(screen.getByText("Review Pointer setup")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Review setup/i }));

    expect(await screen.findByText(/Ollama is running/)).toBeInTheDocument();
    await waitFor(() =>
      expect(useSettings.getState().installedModels).toEqual([
        "gemma4:31b",
        "qwen2.5-coder:1.5b-base",
        "nomic-embed-text:latest",
      ]),
    );

    await user.click(screen.getByRole("button", { name: /^Next/i }));
    expect(await screen.findByText("Current setup")).toBeInTheDocument();
    expect(screen.getAllByText("gemma4:31b").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Installed as nomic-embed-text:latest"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Use current setup/i }),
    );
    const state = useSettings.getState();
    expect(state.chatModel).toBe("gemma4:31b");
    expect(state.agentModel).toBe("gemma4:31b");
    expect(state.fimModel).toBe("qwen2.5-coder:1.5b-base");
    expect(state.embedModel).toBe("nomic-embed-text");
  });

  it("treats bare model names and :latest installs as the same local model", async () => {
    mockRuntime(["nomic-embed-text:latest"]);
    useSettings.setState({
      embedModel: "nomic-embed-text",
      chatModel: "",
      agentModel: "",
      fimModel: "",
    });

    const user = userEvent.setup();
    render(<Onboarding onDone={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Get started/i }));
    expect(await screen.findByText(/Ollama is running/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Next/i }));

    expect(
      await screen.findByText("Installed as nomic-embed-text:latest"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 local model")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Use current setup/i }),
      ).toBeEnabled(),
    );
  });
});
