import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

describe("<ContextMenu>", () => {
  it("focuses the first enabled item and supports arrow/enter activation", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    render(
      <ContextMenu
        x={20}
        y={20}
        onClose={() => {}}
        items={[
          { kind: "item", label: "Disabled", disabled: true, onSelect: vi.fn() },
          { kind: "item", label: "First", onSelect: first },
          { kind: "item", label: "Second", onSelect: second },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus());
    await user.keyboard("{ArrowDown}{Enter}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps the menu inside the viewport", () => {
    render(
      <ContextMenu
        x={99999}
        y={99999}
        onClose={() => {}}
        items={[{ kind: "item", label: "Copy", onSelect: vi.fn() }]}
      />,
    );
    const menu = screen.getByRole("menu");
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(6);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(6);
  });
});
