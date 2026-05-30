import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  activeTab,
  commandLog,
  editorCursor,
  expect,
  openE2EFile,
  paths,
  test,
} from "./fixtures/pointerApp";

const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe("workbench interaction matrix", () => {
  test.describe.configure({ timeout: 120_000 });

  test("drives global command, finder, settings, search, terminal, and empty-editor flows with visual captures", async ({
    appPage: page,
  }, testInfo) => {
    await expectWorkbenchShell(page);
    await captureVisual(page, testInfo, "01-workbench-shell");

    await openCommandPalette(page);
    await captureVisual(page, testInfo, "02-command-palette");
    await page.getByPlaceholder("Type a command…").fill("Open Settings");
    await page.getByText("Open Settings", { exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expectBoxInsideViewport(page, page.getByRole("dialog", { name: "Settings" }), "settings dialog");
    await page.getByPlaceholder("Search settings…").fill("theme");
    await page.getByLabel("App theme").selectOption("pointer-gris");
    await expect(page.getByLabel("App theme")).toHaveValue("pointer-gris");
    await captureVisual(page, testInfo, "03-settings-theme-search");
    await page.getByLabel("Close settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();

    await page.keyboard.press(`${mod}+P`);
    const fileFinder = page.getByRole("dialog", { name: "File finder" });
    await expect(fileFinder).toBeVisible();
    await fileFinder
      .getByPlaceholder("Find file by name — append :line[:col] to jump…")
      .fill("Button.tsx:6:17");
    await expect(page.getByLabel(/Will jump to line 6 column 17/)).toBeVisible();
    await expect(fileFinder.getByText("Button.tsx", { exact: true })).toBeVisible();
    await captureVisual(page, testInfo, "04-file-finder-line-column");
    await fileFinder.getByText("Button.tsx", { exact: true }).click();
    await expect.poll(() => activeTab(page)).toMatchObject({ path: paths.button });
    await expect.poll(() => editorCursor(page)).toMatchObject({ line: 6, column: 17 });

    await page.keyboard.press(`${mod}+Shift+F`);
    const findDialog = page.getByRole("dialog", { name: "Find in files" });
    await expect(findDialog).toBeVisible();
    await findDialog.getByLabel("Search workspace").fill("renderGreeting");
    await expect(findDialog.getByText(/src\/App\.tsx|utils\/greeting\.ts/).first()).toBeVisible();
    await findDialog.getByLabel("Toggle case sensitive").click();
    await expect(findDialog.getByLabel("Toggle case sensitive")).toHaveAttribute("aria-pressed", "true");
    await findDialog.getByLabel("Show replace field").click();
    await findDialog.getByLabel("Replacement text").fill("renderPointerGreeting");
    await captureVisual(page, testInfo, "05-find-in-files-replace");
    await findDialog.locator("button", { hasText: "renderGreeting" }).first().click();
    await expect.poll(() => activeTab(page)).toMatchObject({ path: paths.app });

    await runCommandPaletteAction(page, "Toggle Terminal");
    await expect(page.getByRole("tablist", { name: "Terminal sessions" })).toBeVisible();
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(page.getByRole("application", { name: "Terminal output" })).toBeVisible();
    await captureVisual(page, testInfo, "06-terminal-panel");
    await page.getByRole("application", { name: "Terminal output" }).click();
    await page.keyboard.type("npm test");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () =>
        (await commandLog(page)).filter((entry) => entry.command === "terminal_write").length,
      )
      .toBeGreaterThan(0);
    await page.keyboard.type("npm");
    await expect(page.getByTestId("terminal-history-suggestion")).toContainText("test");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press(`${mod}+F`);
    await expect(page.getByRole("search", { name: "Search terminal scrollback" })).toBeVisible();
    await page.getByLabel("Search scrollback").fill("npm");
    await captureVisual(page, testInfo, "07-terminal-search-history");
    await page.getByLabel("Close search").click();
    await page.getByLabel("Hide terminal panel").click();

    await openE2EFile(page, paths.app);
    await page.getByRole("tab", { name: "App.tsx" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close All" }).click();
    await expect(page.getByText("No file open")).toBeVisible();
    await expect(page.locator(".text-4xl", { hasText: "▸" })).toHaveCount(0);
    await captureVisual(page, testInfo, "08-empty-editor-current-logo");
  });

  test("drives right-dock assistant, source-control, activity, debug, history, and AI-control surfaces", async ({
    appPage: page,
  }, testInfo) => {
    await seedModelActivity(page);

    await page.getByRole("radio", { name: /^Agent mode/ }).click();
    const agentBox = page.getByRole("textbox", { name: /Describe the task/ });
    await agentBox.fill("Add a tiny farewell helper.");
    await page.getByLabel("Send message").click();
    await expect(page.getByText("Starting model").first()).toBeVisible();
    await expect(page.getByText("Review agent changes")).toBeVisible();
    await captureVisual(page, testInfo, "09-agent-change-review");
    await page.getByLabel(/View diff for .*greeting\.ts/).click();
    await expect(page.getByRole("region", { name: /Diff: .*Agent change/ })).toBeVisible();
    await captureVisual(page, testInfo, "10-agent-file-diff");
    await page.getByLabel(/Keep change to .*greeting\.ts/).click();
    await expect(page.getByText(/kept/)).toBeVisible();

    await page.evaluate(() => {
      window.__POINTER_E2E__?.git?.setStatus?.({
        files: { "src/App.tsx": "modified" },
        entries: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: false,
            unstaged: true,
          },
        ],
        dirty_count: 1,
      });
      window.dispatchEvent(new Event("focus"));
    });
    await page.getByRole("tab", { name: "Source Control" }).click();
    await expect(page.getByRole("region", { name: "Source control" })).toBeVisible();
    await captureVisual(page, testInfo, "11-source-control-dirty");
    await page.getByLabel("Stage all").click();
    await page.getByLabel(/Current branch main/).click();
    await expect(page.getByRole("dialog", { name: "Branch picker" })).toBeVisible();
    await captureVisual(page, testInfo, "12-branch-picker");
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: "Model Activity" }).click();
    await expect(page.getByText("Active inference")).toBeVisible();
    await expect(page.getByText("qwen2.5-coder:7b-instruct").first()).toBeVisible();
    await captureVisual(page, testInfo, "13-model-activity");
    await page.getByLabel("Cancel Inline completion").click();
    await expect
      .poll(async () => JSON.stringify(await commandLog(page)))
      .toContain("inference_cancel");
    await page.evaluate(() => {
      window.__POINTER_E2E__?.modelActivity?.setInferenceSnapshot?.({
        active: [],
        active_count: 0,
        updated_at_ms: Date.now(),
      });
    });
    await expect(page.getByLabel("Unload qwen2.5-coder:7b-instruct")).toBeEnabled();
    await page.getByLabel("Unload qwen2.5-coder:7b-instruct").click();
    await expect
      .poll(async () => JSON.stringify(await commandLog(page)))
      .toContain("ollama_unload_model");

    await page.getByRole("tab", { name: "Debug" }).click();
    await expect(page.getByText("Breakpoints", { exact: true })).toBeVisible();
    await captureVisual(page, testInfo, "14-debug-panel");

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByLabel("Filter chat and agent sessions")).toBeVisible();
    await captureVisual(page, testInfo, "15-history-panel");

    await page.getByRole("tab", { name: /AI control/ }).click();
    await expect(page.getByText("Marketplace")).toBeVisible();
    await page.getByLabel("Search models").scrollIntoViewIfNeeded();
    await page.getByLabel("Search models").fill("qwen");
    await expect(page.getByTestId("marketplace-list")).toContainText("qwen");
    await page
      .getByRole("switch", { name: "Auto-stop unused language servers" })
      .scrollIntoViewIfNeeded();
    await page.getByRole("switch", { name: "Auto-stop unused language servers" }).click();
    await expect(
      page.getByRole("switch", { name: "Auto-stop unused language servers" }),
    ).toHaveAttribute("aria-checked", "true");
    await captureVisual(page, testInfo, "16-ai-control-marketplace-lsp");
  });

  test("drives editor tab context, keyboard navigation, drag context, and reveal-in-tree interactions", async ({
    appPage: page,
  }, testInfo) => {
    await openE2EFile(page, paths.button);
    await openE2EFile(page, paths.greeting);
    await page.getByRole("tab", { name: "greeting.ts" }).click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Context menu" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Pin Tab" }).click();
    await expect(page.getByRole("tab", { name: /greeting\.ts, pinned/ })).toBeVisible();
    await page.getByRole("tab", { name: /greeting\.ts, pinned/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "App.tsx" })).toHaveAttribute("aria-selected", "true");
    await captureVisual(page, testInfo, "18-tabs-context-keyboard");

    await page.getByRole("tab", { name: "Button.tsx" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reveal in File Tree" }).click();
    const buttonRow = page.locator(`[data-tree-path="${paths.button}"]`);
    await expect(buttonRow).toBeVisible();
    await expect(buttonRow).toHaveAttribute("aria-current", "page");
    await expect(buttonRow).toHaveAttribute("data-active-file", "true");

    await ensureAssistantOpen(page);
    await dragTabPathIntoAssistant(page, paths.button);
    await expect(page.getByLabel(paths.button)).toBeVisible();
    await captureVisual(page, testInfo, "19-tab-drag-to-assistant");
  });
});

async function openCommandPalette(page: Page) {
  await page.keyboard.press(`${mod}+Shift+P`);
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
}

async function runCommandPaletteAction(page: Page, label: string) {
  await openCommandPalette(page);
  await page.getByPlaceholder("Type a command…").fill(label);
  await page.getByText(label, { exact: true }).click();
}

async function captureVisual(
  page: Page,
  testInfo: TestInfo,
  name: string,
  locator?: Locator,
) {
  const path = testInfo.outputPath(`llm-visual-${name}.png`);
  const target = locator ?? page.locator("body");
  const shot = await target.screenshot({
    path,
    animations: "disabled",
  });
  expect(shot.length, `${name} screenshot should not be blank`).toBeGreaterThan(1_000);
  await testInfo.attach(`llm-visual-${name}`, {
    path,
    contentType: "image/png",
  });
}

async function expectWorkbenchShell(page: Page) {
  await expect(page.getByLabel("Title bar")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Open editors" })).toBeVisible();
  await expect(page.getByLabel("Status bar")).toBeVisible();
  await expectBoxInsideViewport(page, page.getByLabel("Title bar"), "title bar");
  await expectBoxInsideViewport(page, page.getByRole("tree", { name: "Files" }), "file tree");
  await expectBoxInsideViewport(page, page.getByLabel("Status bar"), "status bar");
}

async function expectBoxInsideViewport(page: Page, locator: Locator, label: string) {
  const [box, viewport] = await Promise.all([
    locator.boundingBox(),
    page.viewportSize(),
  ]);
  expect(box, `${label} should have a layout box`).toBeTruthy();
  expect(viewport, "viewport should exist").toBeTruthy();
  if (!box || !viewport) return;
  expect(box.width, `${label} width`).toBeGreaterThan(20);
  expect(box.height, `${label} height`).toBeGreaterThan(12);
  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
}

async function seedModelActivity(page: Page) {
  await page.evaluate(() => {
    const now = Date.now();
    window.__POINTER_E2E__?.modelActivity?.setLoadedModels?.([
      {
        name: "qwen2.5-coder:7b-instruct",
        processor: "gpu",
        size_bytes: 4_700_000_000,
        expires_at: new Date(now + 60_000).toISOString(),
      },
    ]);
    window.__POINTER_E2E__?.modelActivity?.setInferenceSnapshot?.({
      active: [
        {
          request_id: "fim-active-1",
          model: "qwen2.5-coder:7b-instruct",
          title: "Inline completion",
          kind: "fim",
          started_at_ms: now - 1000,
          updated_at_ms: now,
          token_count: 12,
          interruptible: true,
          cancellable: true,
        },
      ],
      active_count: 1,
      updated_at_ms: now,
    });
  });
}

async function dragTabPathIntoAssistant(page: Page, path: string) {
  await ensureAssistantOpen(page);
  const target = page.locator('[data-pointer-drop-context="assistant"]');
  const data = await page.evaluateHandle((item) => {
    const dt = new DataTransfer();
    dt.setData("application/x-pointer-paths", JSON.stringify([item]));
    dt.setData("text/plain", item);
    return dt;
  }, path);
  await target.dispatchEvent("dragover", { dataTransfer: data });
  await target.dispatchEvent("drop", { dataTransfer: data });
  await data.dispose();
}

async function ensureAssistantOpen(page: Page) {
  const target = page.locator('[data-pointer-drop-context="assistant"]');
  if (!(await target.isVisible().catch(() => false))) {
    const expand = page.getByLabel("Expand right dock panel");
    if (await expand.isVisible().catch(() => false)) {
      await expand.click();
    } else {
      await page.getByRole("tab", { name: /Assistant/ }).click();
    }
  }
  await expect(target).toBeVisible();
}
