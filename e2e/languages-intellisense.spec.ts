import {
  activeTab,
  editorLanguage,
  editorMarkers,
  emitLspDiagnostics,
  expect,
  openE2EFile,
  paths,
  test,
  writeE2EFile,
} from "./fixtures/pointerApp";

const languageCases = [
  ["React TSX", paths.app, "typescript"],
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

  test("keeps inline JSX child text on the default foreground after cold boot", async ({
    appPage: page,
  }) => {
    const jsxPath = paths.app.replace("/src/App.tsx", "/src/InlineJsxTextProbe.tsx");
    await writeE2EFile(
      page,
      jsxPath,
      [
        "export function InlineJsxTextProbe() {",
        "  return (",
        "    <div className=\"ad-mockup-title\">",
        "      sports<span>move</span> News",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    );
    await openE2EFile(page, jsxPath);
    await expect.poll(() => editorLanguage(page)).toBe("typescript");

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const styles = window.__POINTER_E2E__?.editor?.tokenStylesForLine?.(4) ?? [];
            const defaultColor = canonicalColor(
              getComputedStyle(document.documentElement).getPropertyValue("--pn-code-fg"),
            );
            const prose = styles.filter((item) =>
              ["sports", "move", "News"].some((word) => item.text.includes(word)),
            );
            return (
              prose.length >= 3 &&
              prose.every((item) => canonicalColor(item.color) === defaultColor)
            );

            function canonicalColor(value: string): string {
              const raw = value.trim().toLowerCase();
              const rgb = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
              if (rgb) {
                return [rgb[1], rgb[2], rgb[3]]
                  .map((part) => Number(part).toString(16).padStart(2, "0"))
                  .join("");
              }
              return raw.replace(/^#/, "").slice(0, 6);
            }
          }),
        { timeout: 5000 },
      )
      .toBe(true);
  });

  test("marks missing dependencies across ecosystems without flagging installed packages", async ({
    appPage: page,
  }) => {
    const cases = [
      { path: paths.missingDepsTs, missing: "left-pad", installed: "react" },
      { path: paths.missingDepsPython, missing: "requests", installed: "fastapi" },
      { path: paths.missingDepsRust, missing: "anyhow", installed: "serde" },
      {
        path: paths.missingDepsGo,
        missing: "github.com/labstack/echo/v4",
        installed: "github.com/gin-gonic/gin",
      },
      {
        path: paths.missingDepsJava,
        missing: "org.apache.commons.lang3",
        installed: "com.google.common",
      },
      { path: paths.missingDepsCsharp, missing: "Dapper", installed: "Newtonsoft" },
      { path: paths.missingDepsPhp, missing: "GuzzleHttp", installed: "Monolog" },
      { path: paths.missingDepsRuby, missing: "httparty", installed: "faraday" },
      { path: paths.missingDepsDart, missing: "riverpod", installed: "http" },
      { path: paths.missingDepsSwift, missing: "ArgumentParser", installed: "Alamofire" },
    ];

    for (const item of cases) {
      await openE2EFile(page, item.path);
      await expect
        .poll(async () => {
          const markers = await editorMarkers(page);
          return JSON.stringify(
            markers.filter((marker: { source?: string }) => marker.source === "pointer-deps"),
          );
        })
        .toContain(item.missing);

      const dependencyMarkers = await editorMarkers(page);
      const serialized = JSON.stringify(
        dependencyMarkers.filter(
          (marker: { source?: string }) => marker.source === "pointer-deps",
        ),
      );
      expect(serialized).not.toContain(item.installed);
    }
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

  test("continues FIM inline tab completion after repeated accepts", async ({ appPage: page }) => {
    await openE2EFile(page, paths.completion);
    await page.evaluate(() => {
      window.__POINTER_E2E__?.ai?.setFimDelay?.(220);
    });
    await page.evaluate(async () => {
      await window.__POINTER_E2E__?.editor?.triggerInlineSuggest?.(4, 16);
    });

    await expect(page.getByRole("alert").filter({ hasText: "Greeting" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__POINTER_E2E__?.editor
              ?.visibleGhostText?.()
              ?.map((item) => `${item.text}|${item.color}|${item.visibility}`)
              .join("\n") ?? "",
        ),
      )
      .toContain("Greeting");
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const content = String(window.__POINTER_E2E__?.editor?.content?.());
          return content.includes("renderGreeting") && content.includes("Pointer");
        }),
      )
      .toBe(true);

    await expect(page.getByRole("alert").filter({ hasText: ";" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => String(window.__POINTER_E2E__?.editor?.content?.())))
      .toContain("renderGreeting('Pointer');");

    await expect(page.getByRole("alert").filter({ hasText: "completed by FIM" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => String(window.__POINTER_E2E__?.editor?.content?.())))
      .toContain("// completed by FIM");
    const fimCalls = await page.evaluate(
      () =>
        window.__POINTER_E2E__?.commandLog?.filter((entry) => entry.command === "ollama_fim")
          .length ?? 0,
    );
    expect(fimCalls).toBeGreaterThanOrEqual(3);
    expect(fimCalls).toBeLessThanOrEqual(6);
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
