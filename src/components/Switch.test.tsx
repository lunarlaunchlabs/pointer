import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Switch } from "./Switch";

function thumb(container: HTMLElement) {
  const node = container.querySelector('span[aria-hidden="true"]');
  if (!(node instanceof HTMLSpanElement)) {
    throw new Error("Switch thumb was not rendered");
  }
  return node;
}

describe("<Switch>", () => {
  it("anchors the on thumb on the right side", () => {
    const { container } = render(
      <Switch checked onChange={() => {}} label="Example" />,
    );

    expect(screen.getByRole("switch", { name: "Example" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(thumb(container).className).toContain("left-[2px]");
    expect(thumb(container).className).toContain("translate-x-[14px]");
  });

  it("keeps the off thumb on the left side", () => {
    const { container } = render(
      <Switch checked={false} onChange={() => {}} label="Example" />,
    );

    expect(screen.getByRole("switch", { name: "Example" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(thumb(container).className).toContain("left-[2px]");
    expect(thumb(container).className).toContain("translate-x-0");
  });

  it("uses the correct larger travel distance for medium switches", () => {
    const { container } = render(
      <Switch checked onChange={() => {}} label="Example" size="md" />,
    );

    expect(thumb(container).className).toContain("translate-x-[16px]");
  });

  it("toggles to the inverse value when clicked", () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} label="Example" />);

    fireEvent.click(screen.getByRole("switch", { name: "Example" }));

    expect(onChange).toHaveBeenCalledWith(false);
  });
});
