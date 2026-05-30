import {
  editorCursor,
  expect,
  openE2EFile,
  paths,
  test,
} from "./fixtures/pointerApp";

test.describe("document outline", () => {
  test("renders symbols for the active file and jumps to a selected symbol", async ({
    appPage: page,
  }) => {
    await page.getByRole("button", { name: "Outline" }).click();

    await expect(page.getByText("Outline · App.tsx")).toBeVisible();
    await expect(page.getByRole("tree", { name: "Document outline" })).toBeVisible();

    const appSymbol = page.getByRole("treeitem", { name: /App/ });
    await expect(appSymbol).toBeVisible();
    await appSymbol.getByRole("button", { name: /App/ }).click();

    await expect.poll(() => editorCursor(page)).toMatchObject({
      line: 4,
    });
  });

  test("clears stale entries and falls back to content scanning when LSP has no symbols", async ({
    appPage: page,
  }) => {
    await page.getByRole("button", { name: "Outline" }).click();
    await expect(page.getByRole("treeitem", { name: /App/ })).toBeVisible();

    await openE2EFile(page, paths.markdown);

    await expect(page.getByText("Outline · README.md")).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /App/ })).toHaveCount(0);

    const heading = page.getByRole("treeitem", {
      name: /Pointer E2E Fixture/,
    });
    await expect(heading).toBeVisible();
    await heading.getByRole("button", { name: /Pointer E2E Fixture/ }).click();

    await expect.poll(() => editorCursor(page)).toMatchObject({
      line: 1,
    });
  });
});
