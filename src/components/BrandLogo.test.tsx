import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PointerMarkSvg, PointerWordmarkSvg } from "@/components/BrandLogo";
import { POINTER_MARK_PATH } from "@/lib/brandLogo";

describe("Pointer brand logo SVGs", () => {
  it("renders the short mark as theme-reactive SVG art", () => {
    const { container } = render(<PointerMarkSvg title="Pointer mark" />);

    expect(screen.getByRole("img", { name: "Pointer mark" })).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("84 112 292 292");
    expect(container.querySelector("filter")).not.toBeInTheDocument();
    expect(container.querySelector("path")?.getAttribute("d")).toBe(POINTER_MARK_PATH);

    const stops = Array.from(container.querySelectorAll("stop")).map((stop) =>
      stop.getAttribute("stop-color"),
    );
    expect(stops).toEqual([
      "var(--pn-accent-hot)",
      "var(--pn-accent)",
      "var(--pn-accent-soft)",
    ]);
  });

  it("renders the full wordmark as SVG text plus mark geometry", () => {
    const { container } = render(<PointerWordmarkSvg title="Pointer logo" />);

    expect(screen.getByRole("img", { name: "Pointer logo" })).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("filter")).not.toBeInTheDocument();
    expect(container.querySelector("text")?.textContent).toBe("pointer");
    expect(container.querySelector("text")?.getAttribute("x")).toBe("346");
    expect(container.querySelector("text")?.getAttribute("transform")).toBeNull();
    expect(container.querySelector("text")?.getAttribute("fill")).toMatch(
      /^url\(#pointer-wordmark-gradient-/,
    );
  });
});
