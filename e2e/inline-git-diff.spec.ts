import {
  expect,
  openE2EFile,
  paths,
  test,
  writeE2EFile,
} from "./fixtures/pointerApp";

test.describe("inline git diffs", () => {
  test("marks changed lines in the editor and opens a quick file diff", async ({
    appPage: page,
  }) => {
    const original = [
      "export const anchor = 1;",
      'export const label = "old";',
      "export const shared = true;",
      "export const removeMe = true;",
      "export const middle = 2;",
      "export const tail = 3;",
    ].join("\n");
    const modified = [
      "export const anchor = 1;",
      'export const label = "new";',
      "export const shared = true;",
      "export const middle = 2;",
      "export const inserted = 4;",
      "export const tail = 3;",
    ].join("\n");

    await page.evaluate(
      ({ path, head }) => {
        window.__POINTER_E2E__?.git?.setHeadFile?.(path, head);
        window.__POINTER_E2E__?.git?.setStatus?.({
          files: { "src/utils/greeting.ts": "modified" },
          entries: [
            {
              path: "src/utils/greeting.ts",
              status: "modified",
              staged: false,
              unstaged: true,
            },
          ],
          dirty_count: 1,
        });
      },
      { path: paths.greeting, head: original },
    );
    await writeE2EFile(page, paths.greeting, modified);
    await openE2EFile(page, paths.greeting);

    await expect
      .poll(async () =>
        page.evaluate(
          () => window.__POINTER_E2E__?.editor?.gitDiffDecorationClasses?.() ?? [],
        ),
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("pn-git-diff-line-modified"),
          expect.stringContaining("pn-git-diff-line-deleted"),
          expect.stringContaining("pn-git-diff-line-added"),
        ]),
      );

    await page.evaluate(() =>
      window.__POINTER_E2E__?.editor?.runAction?.(
        "pointer.git.showCurrentFileDiff",
      ),
    );
    await expect(
      page.getByRole("region", {
        name: /Diff: src\/utils\/greeting\.ts \(HEAD ↔ working tree\)/,
      }),
    ).toBeVisible();
  });
});
