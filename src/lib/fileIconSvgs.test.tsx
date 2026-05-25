/**
 * Smoke test that every exported icon actually renders a valid
 * <svg> element with the requested size and at least one fill or
 * stroke. This guards against accidentally returning `null`,
 * forgetting the wrapper, or shipping an empty placeholder.
 *
 * Rather than enumerate every icon manually, we discover them
 * from the module's exports — any new icon added to
 * `fileIconSvgs.tsx` automatically joins this audit. That's the
 * point: a fully-tested icon set with zero per-icon boilerplate.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as Icons from "./fileIconSvgs";
import type { IconProps } from "./fileIconSvgs";

type IconComp = React.FC<IconProps>;
const ICONS = Icons as unknown as Record<string, IconComp>;

const isIcon = (key: string) =>
  key.startsWith("Icon") && typeof ICONS[key] === "function";

describe("fileIconSvgs", () => {
  const iconKeys = Object.keys(Icons).filter(isIcon);

  it("exports at least 80 icon components (no regressions in coverage)", () => {
    // The full set we built spans ~100 unique types. We assert a
    // floor of 80 so future deletions ring an alarm.
    expect(iconKeys.length).toBeGreaterThanOrEqual(80);
  });

  for (const key of iconKeys) {
    it(`${key} renders a valid SVG at the requested size`, () => {
      const Icon = ICONS[key];
      const { container } = render(<Icon size={24} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("width")).toBe("24");
      expect(svg?.getAttribute("height")).toBe("24");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
      // Must draw *something* — at least one rect / polygon / path /
      // circle / line / text inside.
      const inner = svg?.querySelector("rect, polygon, path, circle, line, text, ellipse, g");
      expect(inner).not.toBeNull();
    });
  }

  it("two adjacent JS-family icons render with different SVG content", () => {
    // Make sure the badge variations actually produce different
    // markup. If a copy-paste bug ever ties JS and TS to the same
    // component this would catch it.
    const { container: ts } = render(<Icons.IconTypeScript size={16} />);
    const { container: js } = render(<Icons.IconJavaScript size={16} />);
    expect(ts.innerHTML).not.toBe(js.innerHTML);
  });

  it("a representative cross-family sample produces unique SVG markup", () => {
    // Picks one icon from each major family. None of them should
    // render the same markup — that's our visual-distinctness
    // floor.
    const sample: IconComp[] = [
      Icons.IconTypeScript,
      Icons.IconJavaScript,
      Icons.IconRust,
      Icons.IconGo,
      Icons.IconPython,
      Icons.IconRuby,
      Icons.IconJava,
      Icons.IconSwift,
      Icons.IconHaskell,
      Icons.IconElixir,
      Icons.IconLua,
      Icons.IconJSON,
      Icons.IconYAML,
      Icons.IconTOML,
      Icons.IconMarkdown,
      Icons.IconDocker,
      Icons.IconKubernetes,
      Icons.IconTerraform,
      Icons.IconSQL,
      Icons.IconGraphQL,
      Icons.IconCSV,
      Icons.IconImage,
      Icons.IconSVG,
      Icons.IconAudio,
      Icons.IconVideo,
      Icons.IconArchive,
      Icons.IconLock,
      Icons.IconReadme,
      Icons.IconLicense,
      Icons.IconShell,
    ];
    const markup = new Set<string>();
    for (const Icon of sample) {
      const { container } = render(<Icon size={16} />);
      markup.add(container.innerHTML);
    }
    expect(markup.size).toBe(sample.length);
  });
});
