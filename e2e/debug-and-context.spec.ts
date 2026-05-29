import {
  dropBreakpointIntoAssistant,
  dropDebugValueIntoAssistant,
  expect,
  pendingRefs,
  test,
} from "./fixtures/pointerApp";

test.describe("debugger context routing", () => {
  test("shows breakpoints and captured values, then routes both into the assistant", async ({
    appPage: page,
  }) => {
    await page.getByRole("tab", { name: "Debug" }).click();

    await expect(page.getByText("Breakpoints", { exact: true })).toBeVisible();
    await expect(page.getByText(/App\.tsx:9/)).toBeVisible();
    await expect(page.getByText("Captured values")).toBeVisible();
    await expect(page.getByText("Hello, Pointer")).toBeVisible();

    const breakpoint = await page.evaluate(
      () => window.__POINTER_E2E__?.debug?.breakpoints?.()[0],
    );
    const debugValue = await page.evaluate(
      () => window.__POINTER_E2E__?.debug?.values?.()[0],
    );

    await page.getByRole("tab", { name: /Assistant/ }).click();
    await dropBreakpointIntoAssistant(page, breakpoint);
    await dropDebugValueIntoAssistant(page, debugValue);

    await expect(page.getByLabel(/Breakpoint in .*App\.tsx:9/)).toBeVisible();
    await expect(page.getByLabel(/Debug value: title/)).toBeVisible();
    await expect.poll(() => pendingRefs(page)).toMatchObject([
      { kind: "breakpoint", line: 9 },
      { kind: "debugValue", name: "title", value: "Hello, Pointer" },
    ]);
  });
});
