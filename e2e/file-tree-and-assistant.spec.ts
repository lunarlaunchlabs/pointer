import {
  ROOT,
  commandLog,
  dropPathsIntoAssistant,
  expect,
  paths,
  pendingRefs,
  test,
} from "./fixtures/pointerApp";

test.describe("workspace tree and assistant flows", () => {
  test("supports file-tree context menus, inline rename, and inline creation", async ({
    appPage: page,
  }) => {
    await page.locator(`[data-tree-path="${ROOT}/src"]`).click();
    const appRow = page.locator(`[data-tree-path="${paths.app}"]`);
    await expect(appRow).toBeVisible();

    await appRow.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Context menu" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /Copy Relative Path/ }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /Select for Compare/ }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeVisible();

    await menu.getByRole("menuitem", { name: /Rename/ }).click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type("Main.tsx");
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-tree-path="${ROOT}/src/Main.tsx"]`)).toBeVisible();

    await page.getByLabel("New file at workspace root").click();
    const createInput = page.locator("input[placeholder='new-file.ts']");
    await expect(createInput).toBeVisible();
    await createInput.fill("Scratch.ts");
    await createInput.press("Enter");
    await expect(page.locator(`[data-tree-path="${ROOT}/Scratch.ts"]`)).toBeVisible();
  });

  test("accepts dragged files as assistant context and sends grounded ask requests", async ({
    appPage: page,
  }) => {
    await dropPathsIntoAssistant(page, [paths.app, paths.button]);

    await expect(page.getByLabel(paths.app)).toBeVisible();
    await expect(page.getByLabel(paths.button)).toBeVisible();
    await expect.poll(() => pendingRefs(page)).toEqual([
      { kind: "file", path: paths.app },
      { kind: "file", path: paths.button },
    ]);

    const composer = page.getByRole("textbox", { name: /Ask anything/ });
    await composer.fill("Tell me about App.tsx and how it uses its imports.");
    await page.getByLabel("Send message").click();

    await expect(
      page.getByText(/App\.tsx renders the Pointer E2E React shell/),
    ).toBeVisible();

    const askCall = (await commandLog(page)).find(
      (entry) => entry.command === "assistant_ask",
    );
    expect(askCall).toBeTruthy();
    expect(JSON.stringify(askCall?.args)).toContain(paths.app);
    expect(JSON.stringify(askCall?.args)).toContain(paths.button);
  });

  test("shows model startup feedback before ask-mode tokens arrive", async ({
    appPage: page,
  }) => {
    const composer = page.getByRole("textbox", { name: /Ask anything/ });
    await composer.fill("Tell me about App.tsx.");
    await page.getByLabel("Send message").click();

    await expect(page.getByText("Starting model").first()).toBeVisible();
    await expect(
      page.getByText(/App\.tsx renders the Pointer E2E React shell/),
    ).toBeVisible();
  });

  test("produces an executable plan and carries it into the agent path", async ({
    appPage: page,
  }) => {
    await page.getByRole("radio", { name: /^Plan mode/ }).click();
    await page
      .getByRole("textbox", { name: /Describe what you want planned/ })
      .fill("Plan how to add another React component to this project.");
    await page.getByLabel("Send message").click();

    await expect(page.getByText("Plan ready", { exact: true })).toBeVisible();
    await expect(page.getByText(/Inspect.*src\/App\.tsx/)).toBeVisible();

    const execute = page.getByRole("button", { name: /Execute as Agent/ });
    await expect(execute).toBeEnabled();
    await execute.click();
    await expect(
      page.getByText(/Executed the approved plan with the carried transcript/),
    ).toBeVisible();

    const calls = await commandLog(page);
    const planRun = calls.find((entry) => entry.command === "agent_run");
    expect(planRun).toBeTruthy();
    expect(JSON.stringify(planRun?.args)).toContain("<brain-frontier>");
    expect(calls.some((entry) => entry.command === "agent_execute_plan")).toBe(
      true,
    );
  });

  test("surfaces advanced git workflow controls and AI commit drafts", async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      window.__POINTER_E2E__?.git?.setStatus?.({
        files: { "src/App.tsx": "modified" },
        entries: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: true,
            unstaged: false,
          },
        ],
        dirty_count: 1,
      });
      window.__POINTER_E2E__?.git?.setCommandOutput?.(
        "git_push",
        Array.from({ length: 80 }, (_, i) => `remote line ${i + 1}`).join("\n"),
      );
      window.__POINTER_E2E__?.git?.setGenerateDelay?.(180);
      window.dispatchEvent(new Event("focus"));
    });

    await page.getByRole("tab", { name: "Source Control" }).click();
    await expect(page.getByRole("region", { name: "Source control" })).toBeVisible();
    await expect(page.getByText("Git workflow")).toBeVisible();
    await expect(page.getByText("Remote sync")).toBeVisible();
    const sync = page.locator("section").filter({ hasText: "Remote sync" });
    await sync.getByRole("button", { name: "Push to remote" }).click();
    await expect(page.getByText(/remote line 1/)).toBeVisible();
    await page.getByTestId("git-output-log").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(page.getByRole("button", { name: "Dismiss git output" })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss git output" }).click();
    await expect(page.getByTestId("git-output-pane")).toBeHidden();

    await expect(page.getByRole("button", { name: /Generate commit message/ })).toBeEnabled();

    await page.getByRole("button", { name: /Generate commit message/ }).click();
    await page.getByRole("tab", { name: "Model Activity" }).click();
    await expect(page.getByText("Active workflows")).toBeVisible();
    await expect(page.getByText("Draft commit message")).toBeVisible();
    await page.getByRole("tab", { name: "Source Control" }).click();
    await expect(page.getByRole("textbox", { name: "Commit message" })).toHaveJSProperty(
      "readOnly",
      true,
    );
    await expect(page.getByRole("textbox", { name: "Commit message" })).toHaveValue(
      /Improve source control workflow/,
    );
    await expect(page.getByRole("textbox", { name: "Commit message" })).toHaveJSProperty(
      "readOnly",
      false,
    );
    await expect(page.getByText(/Commit intelligence/)).toBeVisible();
    await page.getByText(/Commit intelligence/).click();
    const memory = page.getByTestId("commit-generation-memory");
    await expect(memory.getByText("Consolidated summary")).toBeVisible();
    await expect(memory.getByText("Commit message")).toBeVisible();

    const calls = await commandLog(page);
    expect(calls.some((entry) => entry.command === "git_push")).toBe(true);
    expect(calls.some((entry) => entry.command === "git_diff")).toBe(true);
    expect(calls.some((entry) => entry.command === "ollama_generate")).toBe(true);
  });

  test("normalizes weak draft output from the commit UI path", async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      window.__POINTER_E2E__?.git?.setStatus?.({
        files: {
          "src/App.tsx": "modified",
        },
        entries: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: true,
            unstaged: false,
          },
        ],
        dirty_count: 1,
      });
      window.__POINTER_E2E__?.git?.setCommandOutput?.(
        "git_diff",
        [
          "diff --git a/src/App.tsx b/src/App.tsx",
          "@@ -1,3 +1,5 @@",
          '+const draftStatus = "commit draft validation keeps generated summaries grounded";',
          '+const judgeStatus = "judge retry prevents incomplete scheduled stages";',
        ].join("\n"),
      );
      window.__POINTER_E2E__?.git?.setGenerateOverrides?.({
        chunk: "Adds file path.",
        file: "Updates src/lib/harnessCore.",
        change:
          "Updates remote line ${i + 1}. Updates Adds visual git workflow support.. Updates src/lib/harnessCore.",
        commit:
          "fix: correct git commit pipeline probe and commit file summary\n\nIncludes commit agent orbit, commit draft, and file path.",
      });
      window.dispatchEvent(new Event("focus"));
    });

    await page.getByRole("tab", { name: "Source Control" }).click();
    await page.getByRole("button", { name: /Generate commit message/ }).click();
    const message = page.getByRole("textbox", { name: "Commit message" });
    await expect(message).toHaveValue(/commit|judge|summary/i);
    await expect(message).not.toHaveValue(/file path/i);
    await expect(message).not.toHaveValue(/remote line|\$\{/i);
  });

  test("handles Git credential prompts inside Pointer", async ({ appPage: page }) => {
    await page.evaluate(() => {
      window.__POINTER_E2E__?.emitTauri?.("git:credential-prompt", {
        id: "prompt-1",
        prompt: "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        secret: true,
      });
    });

    await expect(page.getByRole("dialog", { name: "Git authentication" })).toBeVisible();
    await page.getByLabel("Git passphrase").fill("test-passphrase");
    await page.getByRole("button", { name: "Send to Git" }).click();
    await page.waitForFunction(() =>
      window.__POINTER_E2E__?.commandLog?.some(
        (entry: { command: string }) => entry.command === "git_credential_respond",
      ),
    );

    const calls = await commandLog(page);
    const response = calls.find((entry) => entry.command === "git_credential_respond");
    expect(JSON.stringify(response?.args)).toContain("prompt-1");
    expect(JSON.stringify(response?.args)).toContain("test-passphrase");
  });

  test("commits from a fresh git index snapshot when the panel is stale", async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      window.__POINTER_E2E__?.git?.setStatus?.({
        files: {},
        entries: [],
        dirty_count: 0,
      });
      window.dispatchEvent(new Event("focus"));
    });

    await page.getByRole("tab", { name: "Source Control" }).click();
    await page.getByRole("textbox", { name: "Commit message" }).fill("Commit staged work");

    await page.evaluate(() => {
      window.__POINTER_E2E__?.git?.setStatus?.({
        files: { "src/App.tsx": "modified" },
        entries: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: true,
            unstaged: false,
          },
        ],
        dirty_count: 1,
      });
    });

    await page.getByRole("button", { name: /Commit staged changes/ }).click();
    await page.waitForFunction(() =>
      window.__POINTER_E2E__?.commandLog?.some(
        (entry: { command: string }) => entry.command === "git_commit",
      ),
    );

    const calls = await commandLog(page);
    const commitCall = calls.find((entry) => entry.command === "git_commit");
    expect(commitCall).toBeTruthy();
    expect(JSON.stringify(commitCall?.args)).toContain("Commit staged work");
  });
});
