import { ROOT, expect, test } from "./fixtures/pointerApp";

test.describe("sidebar layout", () => {
  test("keeps a large collapsed file tree inside the workbench above the status bar", async ({
    appPage: page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 360 });

    await page.evaluate((root) => {
      for (let i = 0; i < 90; i++) {
        window.__POINTER_E2E__?.fs?.write?.(
          `${root}/zz-root-file-${String(i).padStart(3, "0")}.ts`,
          `export const value${i} = ${i};\n`,
        );
      }
    }, ROOT);

    await page.getByLabel("Refresh file tree").click();
    await expect(
      page.locator(`[data-tree-path="${ROOT}/zz-root-file-089.ts"]`),
    ).toHaveCount(1);

    const tree = page.getByRole("tree", { name: "Files" });
    const status = page.getByRole("contentinfo", { name: "Status bar" });
    await expect(tree).toBeVisible();
    await expect(status).toBeVisible();

    const [treeBox, statusBox] = await Promise.all([
      tree.boundingBox(),
      status.boundingBox(),
    ]);
    expect(treeBox).toBeTruthy();
    expect(statusBox).toBeTruthy();
    expect(treeBox!.y + treeBox!.height).toBeLessThanOrEqual(statusBox!.y + 1);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const status = document.querySelector<HTMLElement>(
            '[role="contentinfo"][aria-label="Status bar"]',
          );
          if (!status) return false;
          const rect = status.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + 24,
            rect.top + rect.height / 2,
          );
          return !!hit && status.contains(hit);
        }),
      )
      .toBe(true);
  });
});
