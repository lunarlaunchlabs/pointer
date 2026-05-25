import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Marketplace } from "./Marketplace";
import type { HardwareProfile } from "@/lib/ipc";

const GB = 1024 ** 3;

function mkHw(opts: {
  totalGb: number;
  freeGb?: number;
  gpu?: string | null;
}): HardwareProfile {
  return {
    cpu_count: 8,
    cpu_name: "Test CPU",
    cpu_brand: "Test CPU",
    total_ram_bytes: opts.totalGb * GB,
    available_ram_bytes: (opts.freeGb ?? opts.totalGb * 0.7) * GB,
    swap_total: 0,
    gpu_label: opts.gpu ?? null,
    os_name: "test-os",
    os_version: "0.0",
    host_name: "host",
    arch: "aarch64",
  };
}

function renderMarketplace(overrides?: Partial<Parameters<typeof Marketplace>[0]>) {
  const onPull = vi.fn();
  const baseProps: Parameters<typeof Marketplace>[0] = {
    hardware: mkHw({ totalGb: 32, freeGb: 24, gpu: "Apple M2 Pro" }),
    installedModelIds: [],
    ollamaRunning: true,
    activePulls: {},
    onPull,
  };
  const utils = render(<Marketplace {...baseProps} {...overrides} />);
  return { ...utils, onPull };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<Marketplace>", () => {
  it("renders the hardware budget banner with detected specs", () => {
    renderMarketplace({
      hardware: mkHw({ totalGb: 32, freeGb: 16, gpu: "Apple M2 Pro" }),
    });
    expect(screen.getByText(/32 GB/)).toBeInTheDocument();
    expect(screen.getByText(/16\.0 GB/)).toBeInTheDocument();
    expect(screen.getByText(/Apple M2 Pro/)).toBeInTheDocument();
  });

  it("falls back to a 'Detecting hardware…' banner when hardware is null", () => {
    renderMarketplace({ hardware: null });
    expect(screen.getByText(/Detecting hardware/)).toBeInTheDocument();
  });

  it("shows a runnability badge that says 'runs' for fit models on a beefy machine", () => {
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48, gpu: "Apple M3 Max" }),
    });
    const runsBadges = screen.getAllByText(/^runs$/);
    expect(runsBadges.length).toBeGreaterThan(0);
  });

  it("hides 'blocked' rows by default, exposes them when the filter is off", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 8, freeGb: 4 }),
    });
    // 70B should be blocked on 8 GB. With "hide can't-run" ON it is hidden.
    expect(screen.queryByText(/llama3\.3:70b/)).not.toBeInTheDocument();
    const checkbox = screen.getByLabelText("Hide models I can't run");
    await user.click(checkbox);
    expect(await screen.findByText(/llama3\.3:70b/)).toBeInTheDocument();
  });

  it("filters by category when a pill is clicked", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
    });
    // "Embeddings" pill restricts to the indexing category.
    await user.click(screen.getByRole("tab", { name: /Embeddings/ }));
    // The category-description hint appears.
    expect(
      screen.getByText(/Embedding models for the @codebase semantic index/),
    ).toBeInTheDocument();
    // Nomic Embed must be in the list.
    expect(screen.getByText(/nomic-embed-text:latest/)).toBeInTheDocument();
    // A non-embedding model should not be.
    expect(screen.queryByText(/qwen2\.5-coder:7b-instruct/)).not.toBeInTheDocument();
  });

  it("text search narrows the list", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
    });
    const input = screen.getByLabelText("Search models");
    await user.type(input, "vision ocr");
    // The top result should be one of the vision models.
    const list = screen.getByTestId("marketplace-list");
    const text = list.textContent ?? "";
    expect(text.toLowerCase()).toMatch(/vision/);
    // Non-vision should be gone.
    expect(within(list).queryByText(/qwen2\.5-coder:3b-base/)).not.toBeInTheDocument();
  });

  it("clear-search button restores the full list", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
    });
    const input = screen.getByLabelText("Search models");
    await user.type(input, "vision");
    const before = (screen.getByTestId("marketplace-list").textContent ?? "").length;
    await user.click(screen.getByLabelText("Clear search"));
    const after = (screen.getByTestId("marketplace-list").textContent ?? "").length;
    expect(after).toBeGreaterThan(before);
  });

  it("marks installed entries with the 'Installed' button and does not call onPull", async () => {
    const user = userEvent.setup();
    const { onPull } = renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
      installedModelIds: ["qwen2.5-coder:7b-instruct"],
    });
    const installedBtn = await screen.findByTestId(
      "pull-qwen2.5-coder:7b-instruct",
    );
    expect(installedBtn).toBeDisabled();
    await user.click(installedBtn);
    expect(onPull).not.toHaveBeenCalled();
  });

  it("disables install buttons when Ollama is not running and explains why", async () => {
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
      ollamaRunning: false,
    });
    const btn = await screen.findByTestId("pull-qwen2.5-coder:7b-instruct");
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/Start Ollama/);
  });

  it("shows a 'won't fit' badge AND a risky-install button for blocked models when shown", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 8, freeGb: 4 }),
    });
    // Reveal blocked rows.
    await user.click(screen.getByLabelText("Hide models I can't run"));
    // 70B button text should be "Install (risky)".
    const btn = await screen.findByTestId("pull-llama3.3:70b");
    expect(btn.textContent).toMatch(/risky/);
    // The runnability badge "won't fit" must appear at least once.
    expect(screen.getAllByText(/won't fit/).length).toBeGreaterThan(0);
  });

  it("clicking Install calls onPull with the model id", async () => {
    const user = userEvent.setup();
    const { onPull } = renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
    });
    const btn = await screen.findByTestId("pull-qwen2.5-coder:7b-instruct");
    await user.click(btn);
    expect(onPull).toHaveBeenCalledWith("qwen2.5-coder:7b-instruct");
  });

  it("renders an in-flight progress bar when a pull is active", async () => {
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
      activePulls: {
        "qwen2.5-coder:7b-instruct": {
          pct: 42,
          status: "downloading",
          error: null,
        },
      },
    });
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    const btn = await screen.findByTestId("pull-qwen2.5-coder:7b-instruct");
    expect(btn.textContent).toMatch(/Pulling/);
    expect(btn).toBeDisabled();
  });

  it("surfaces a pull error inline on the failed row", () => {
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
      activePulls: {
        "qwen2.5-coder:7b-instruct": {
          pct: 13,
          status: "error",
          error: "manifest not found",
        },
      },
    });
    expect(screen.getByText(/manifest not found/)).toBeInTheDocument();
  });

  it("'Hide installed' filter removes installed rows", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
      installedModelIds: ["nomic-embed-text:latest"],
    });
    expect(screen.getByText(/nomic-embed-text:latest/)).toBeInTheDocument();
    await user.click(screen.getByLabelText("Hide installed"));
    expect(screen.queryByText(/nomic-embed-text:latest/)).not.toBeInTheDocument();
  });

  it("changing the sort order rearranges the list", async () => {
    const user = userEvent.setup();
    renderMarketplace({
      hardware: mkHw({ totalGb: 64, freeGb: 48 }),
    });
    await user.click(screen.getByRole("tab", { name: /^Chat$/ }));
    await user.selectOptions(screen.getByLabelText("Sort"), "smallest");
    const list = screen.getByTestId("marketplace-list");
    const firstId = list.querySelector("[data-testid^='pull-']")?.getAttribute("data-testid") ?? "";
    expect(firstId).toMatch(/llama3\.2:1b|llama3\.2:3b/);
  });
});
