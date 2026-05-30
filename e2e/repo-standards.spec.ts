import {
  ROOT,
  expect,
  openE2EFile,
  test,
  writeE2EFile,
} from "./fixtures/pointerApp";

test.describe("repo-level IDE standards", () => {
  test("applies shared EditorConfig and VS Code workspace editor settings", async ({
    appPage: page,
  }) => {
    const target = `${ROOT}/standards/example.py`;
    await writeE2EFile(
      page,
      `${ROOT}/.editorconfig`,
      [
        "root = true",
        "",
        "[*.py]",
        "indent_style = space",
        "indent_size = 4",
        "trim_trailing_whitespace = true",
      ].join("\n"),
    );
    await writeE2EFile(
      page,
      `${ROOT}/.vscode/settings.json`,
      [
        "{",
        '  "editor.insertSpaces": false,',
        '  "[python]": {',
        '    "editor.insertSpaces": true',
        "  }",
        "}",
      ].join("\n"),
    );
    await writeE2EFile(
      page,
      target,
      ["def main():", "    return True"].join("\n"),
    );

    await openE2EFile(page, target);

    await expect
      .poll(() =>
        page.evaluate(() => window.__POINTER_E2E__?.editor?.modelOptions?.()),
      )
      .toEqual({ tabSize: 4, insertSpaces: true });
  });
});
