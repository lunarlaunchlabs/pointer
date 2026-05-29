import {
  activeTab,
  editorLanguage,
  editorMarkers,
  emitLspDiagnostics,
  expect,
  openE2EFile,
  paths,
  test,
} from "./fixtures/pointerApp";

const languageCases = [
  ["React TSX", paths.app, "tsx"],
  ["TypeScript", paths.greeting, "typescript"],
  ["Node/Express JavaScript", paths.server, "javascript"],
  ["Python/FastAPI", paths.python, "python"],
  ["Rust", paths.rust, "rust"],
  ["Go", paths.go, "go"],
  ["Java", paths.java, "java"],
  ["C#", paths.csharp, "csharp"],
  ["Vue", paths.vue, "vue"],
  ["Svelte", paths.svelte, "svelte"],
  ["CSS", paths.css, "css"],
  ["package.json", paths.json, "json"],
  ["Markdown", paths.markdown, "markdown"],
] as const;

test.describe("editor language intelligence", () => {
  for (const [label, path, language] of languageCases) {
    test(`detects ${label} language mode and renders syntax tokens`, async ({
      appPage: page,
    }) => {
      await openE2EFile(page, path);
      await expect.poll(() => editorLanguage(page)).toBe(language);
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__POINTER_E2E__?.editor?.visibleTokenClasses?.()?.length ?? 0,
          ),
        )
        .toBeGreaterThan(0);
    });
  }

  test("surfaces language diagnostics in the editor marker stream", async ({
    appPage: page,
  }) => {
    await openE2EFile(page, paths.app);
    await emitLspDiagnostics(page, paths.app, [
      {
        message: "E2E JSX prop type mismatch",
        code: "E2E_TSX",
        severity: 1,
        range: {
          startLine: 9,
          startColumn: 8,
          endLine: 9,
          endColumn: 14,
        },
      },
    ]);

    await expect
      .poll(async () => {
        const markers = await editorMarkers(page);
        return JSON.stringify(markers);
      })
      .toContain("E2E JSX prop type mismatch");
  });

  test("shows LSP completion suggestions in Monaco", async ({ appPage: page }) => {
    await openE2EFile(page, paths.completion);
    await page.evaluate(async () => {
      await window.__POINTER_E2E__?.editor?.triggerSuggest?.(2, 1);
    });

    const suggestWidget = page.locator(".suggest-widget");
    await expect(suggestWidget).toBeVisible();
    await expect(suggestWidget).toContainText("renderGreeting");
    await expect(suggestWidget).toContainText("Button");
  });

  test("follows definitions across imported files and framework entrypoints", async ({
    appPage: page,
  }) => {
    await openE2EFile(page, paths.app);
    await page.evaluate(async () => {
      await window.__POINTER_E2E__?.editor?.gotoDefinitionAt?.(1, 12);
    });
    await expect.poll(() => activeTab(page)).toMatchObject({ path: paths.button });

    await openE2EFile(page, paths.app);
    await page.evaluate(async () => {
      await window.__POINTER_E2E__?.editor?.gotoDefinitionAt?.(2, 15);
    });
    await expect.poll(() => activeTab(page)).toMatchObject({ path: paths.greeting });

    await openE2EFile(page, paths.server);
    await page.evaluate(async () => {
      await window.__POINTER_E2E__?.editor?.gotoDefinitionAt?.(2, 14);
    });
    await expect.poll(() => activeTab(page)).toMatchObject({ path: paths.router });
  });
});
