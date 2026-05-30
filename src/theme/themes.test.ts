import { describe, expect, it } from "vitest";
import {
  POINTER_THEMES,
  applyPointerThemeToDocument,
  normalizeAppThemeId,
  themeActionId,
} from "./themes";

const REQUIRED_CSS_VARS = [
  "--pn-canvas",
  "--pn-panel",
  "--pn-chrome",
  "--pn-ridge",
  "--pn-line",
  "--pn-text",
  "--pn-subtext",
  "--pn-mute",
  "--pn-accent",
  "--pn-accent-hot",
  "--pn-ok",
  "--pn-warn",
  "--pn-err",
  "--pn-body-bg",
  "--pn-titlebar-bg",
  "--pn-app-shell-bg",
  "--pn-inset-highlight",
] as const;

const REQUIRED_CODE_CSS_VARS = [
  "--pn-code-bg",
  "--pn-code-fg",
  "--pn-code-comment",
  "--pn-code-keyword",
  "--pn-code-string",
  "--pn-code-number",
  "--pn-code-type",
  "--pn-code-function",
  "--pn-code-property",
  "--pn-code-tag",
  "--pn-code-tag-bracket",
  "--pn-code-attribute",
  "--pn-code-attribute-value",
  "--pn-code-config-key",
  "--pn-code-config-value",
  "--pn-code-config-section",
  "--pn-code-selector",
  "--pn-code-markup-heading",
  "--pn-code-markup-link",
  "--pn-code-regex",
  "--pn-code-invalid",
] as const;

const GUIDE_COLOR_KEYS = [
  "editorIndentGuide.background1",
  "editorIndentGuide.activeBackground1",
  "editorBracketPairGuide.background1",
  "editorBracketPairGuide.activeBackground1",
  "editorRuler.foreground",
] as const;

const REQUIRED_MONACO_RULES = [
  { token: "keyword", bold: true },
  { token: "function", bold: true },
  { token: "type", bold: true },
  { token: "annotation", bold: true },
  { token: "macro", bold: true },
  { token: "selector", bold: true },
  { token: "tag", bold: true },
  { token: "attribute.name", bold: true },
  { token: "attribute.value", bold: false },
  { token: "key", bold: true },
  { token: "section", bold: true },
  { token: "regexp", bold: false },
  { token: "heading", bold: true },
  { token: "link", bold: false },
] as const;

const REQUIRED_SHIKI_SCOPES = [
  "entity.name.tag.html",
  "entity.name.tag.xml",
  "entity.name.tag.jsx",
  "entity.name.tag.tsx",
  "entity.other.attribute-name.html",
  "entity.other.attribute-name.xml",
  "entity.other.attribute-name.jsx",
  "entity.other.attribute-name.tsx",
  "support.type.property-name.json",
  "entity.name.tag.yaml",
  "constant.other.key.toml",
  "entity.name.section.group-title.ini",
  "storage.type.annotation.java",
  "entity.name.function",
  "entity.name.type",
  "support.type.property-name.css",
  "entity.other.attribute-name.class.css",
  "markup.heading",
  "markup.underline.link",
  "string.regexp",
] as const;

type ShikiSetting = {
  scope?: string | string[];
  settings?: {
    foreground?: string;
    fontStyle?: string;
  };
};

function shikiSettings(theme: (typeof POINTER_THEMES)[number]): ShikiSetting[] {
  return theme.shiki.settings as ShikiSetting[];
}

function hasShikiScope(theme: (typeof POINTER_THEMES)[number], scope: string): boolean {
  return shikiSettings(theme).some((entry) => {
    if (!entry.scope) return false;
    return Array.isArray(entry.scope) ? entry.scope.includes(scope) : entry.scope === scope;
  });
}

describe("Pointer themes", () => {
  it("ships the launch theme set through one complete registry", () => {
    expect(POINTER_THEMES.map((theme) => theme.id)).toEqual([
      "pointer-noir",
      "pointer-gris",
      "pointer-blanc",
      "pointer-magnet",
      "pointer-alien",
      "pointer-pastelle",
      "pointer-paladin",
      "pointer-desert-sage",
      "pointer-salmon",
      "pointer-dark-photon",
      "pointer-harmonic-tide",
      "pointer-rocket",
      "pointer-meteor",
      "pointer-dark-cola",
      "pointer-vampire",
      "pointer-monkey-pro",
    ]);

    for (const theme of POINTER_THEMES) {
      expect(themeActionId(theme.id)).toBe(`theme:${theme.id}`);
      expect(theme.shiki.name).toBe(theme.id);
      expect(theme.monaco.colors["editor.background"]).toBeTruthy();
      expect(theme.monaco.colors["editor.foreground"]).toBeTruthy();
      expect(theme.monaco.rules.length).toBeGreaterThan(10);
      for (const cssVar of REQUIRED_CSS_VARS) {
        expect(theme.css[cssVar], `${theme.id} ${cssVar}`).toBeTruthy();
      }
      for (const cssVar of REQUIRED_CODE_CSS_VARS) {
        expect(theme.css[cssVar], `${theme.id} ${cssVar}`).toMatch(/^#[0-9a-f]{6,8}$/i);
      }
    }
  });

  it("covers broad language families with shared semantic token rules", () => {
    for (const theme of POINTER_THEMES) {
      for (const { token, bold } of REQUIRED_MONACO_RULES) {
        const rule = theme.monaco.rules.find((candidate) => candidate.token === token);
        expect(rule, `${theme.id} missing Monaco token ${token}`).toBeTruthy();
        expect(rule?.foreground, `${theme.id} ${token} foreground`).toBeTruthy();
        if (bold) {
          expect(rule?.fontStyle, `${theme.id} ${token} font style`).toContain("bold");
        }
      }

      for (const scope of REQUIRED_SHIKI_SCOPES) {
        expect(hasShikiScope(theme, scope), `${theme.id} missing Shiki scope ${scope}`).toBe(true);
      }
    }
  });

  it("keeps syntax palettes distinguishable and readable", () => {
    const semanticVars = [
      "--pn-code-comment",
      "--pn-code-keyword",
      "--pn-code-string",
      "--pn-code-number",
      "--pn-code-type",
      "--pn-code-function",
      "--pn-code-property",
      "--pn-code-tag",
      "--pn-code-attribute",
      "--pn-code-config-key",
      "--pn-code-markup-link",
      "--pn-code-regex",
    ] as const;

    for (const theme of POINTER_THEMES) {
      const colors = semanticVars.map((name) => theme.css[name]);
      expect(new Set(colors.map((color) => color.toLowerCase())).size, theme.id).toBeGreaterThanOrEqual(6);
      for (const name of semanticVars) {
        const ratio = contrastRatio(theme.css[name], theme.css["--pn-code-bg"]);
        const floor = name === "--pn-code-comment" ? 2.15 : 3;
        expect(ratio, `${theme.id} ${name} contrast`).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it("defines Pointer Magnet from the requested palette on matte greys", () => {
    const magnet = POINTER_THEMES.find((theme) => theme.id === "pointer-magnet");
    expect(magnet).toBeTruthy();
    expect(magnet?.css["--pn-canvas"]).toBe("#2F3234");
    expect(magnet?.css["--pn-panel"]).toBe("#373B3D");
    expect(magnet?.css["--pn-code-keyword"]).toBe("#E76F51");
    expect(magnet?.css["--pn-code-attribute"]).toBe("#2A9D8F");
    expect(magnet?.css["--pn-code-string"]).toBe("#E9C46A");
    expect(magnet?.css["--pn-code-operator"]).toBe("#F4A261");
    expect(magnet?.css["--pn-code-fg"]).toBe("#E0FBFC");
    expect(magnet?.css["--pn-accent-deep"]).toBe("#264653");
  });

  it("defines Pointer Alien from the extracted palette on black", () => {
    const alien = POINTER_THEMES.find((theme) => theme.id === "pointer-alien");
    expect(alien).toBeTruthy();
    expect(alien?.label).toBe("Pointer Alien");
    expect(alien?.css["--pn-canvas"]).toBe("#000000");
    expect(alien?.css["--pn-code-bg"]).toBe("#000000");
    expect(alien?.css["--pn-code-fg"]).toBe("#E0FBFC");
    expect(alien?.css["--pn-accent-deep"]).toBe("#264653");
    expect(alien?.css["--pn-accent"]).toBe("#2A9D8F");
    expect(alien?.css["--pn-code-string"]).toBe("#E9C46A");
    expect(alien?.css["--pn-code-operator"]).toBe("#F4A261");
    expect(alien?.css["--pn-code-keyword"]).toBe("#E76F51");
  });

  it("defines Pointer Pastelle from the extracted palette", () => {
    const pastelle = POINTER_THEMES.find((theme) => theme.id === "pointer-pastelle");
    expect(pastelle).toBeTruthy();
    expect(pastelle?.label).toBe("Pointer Pastelle");
    expect(pastelle?.type).toBe("light");
    expect(pastelle?.css["--pn-canvas"]).toBe("#ECE3C4");
    expect(pastelle?.css["--pn-panel"]).toBe("#F6EED6");
    expect(pastelle?.css["--pn-accent"]).toBe("#739A9E");
    expect(pastelle?.css["--pn-accent-soft"]).toBe("#EA8A8A");
    expect(pastelle?.css["--pn-accent-deep"]).toBe("#877394");
    expect(pastelle?.css["--pn-line"]).toBe("#CDBBA0");
    expect(pastelle?.css["--pn-code-bg"]).toBe("#ECE3C4");
    expect(pastelle?.css["--pn-code-keyword"]).toBe("#A7424B");
  });

  it("defines Pointer Paladin from the extracted palette", () => {
    const paladin = POINTER_THEMES.find((theme) => theme.id === "pointer-paladin");
    expect(paladin).toBeTruthy();
    expect(paladin?.label).toBe("Pointer Paladin");
    expect(paladin?.type).toBe("dark");
    expect(paladin?.css["--pn-canvas"]).toBe("#1E1F33");
    expect(paladin?.css["--pn-text"]).toBe("#FFFFFF");
    expect(paladin?.css["--pn-line"]).toBe("#707E92");
    expect(paladin?.css["--pn-accent"]).toBe("#40B488");
    expect(paladin?.css["--pn-accent-hot"]).toBe("#80F077");
    expect(paladin?.css["--pn-code-bg"]).toBe("#1E1F33");
    expect(paladin?.css["--pn-code-keyword"]).toBe("#80F077");
    expect(paladin?.css["--pn-code-number"]).toBe("#40B488");
  });

  it("defines Pointer Desert Sage from the extracted palette", () => {
    const desertSage = POINTER_THEMES.find((theme) => theme.id === "pointer-desert-sage");
    expect(desertSage).toBeTruthy();
    expect(desertSage?.label).toBe("Pointer Desert Sage");
    expect(desertSage?.type).toBe("dark");
    expect(desertSage?.css["--pn-canvas"]).toBe("#3B342E");
    expect(desertSage?.css["--pn-line"]).toBe("#7F8A69");
    expect(desertSage?.css["--pn-accent"]).toBe("#7F8A69");
    expect(desertSage?.css["--pn-accent-soft"]).toBe("#DCC9A1");
    expect(desertSage?.css["--pn-code-bg"]).toBe("#3B342E");
    expect(desertSage?.css["--pn-code-string"]).toBe("#DCC9A1");
    expect(desertSage?.css["--pn-code-operator"]).toBe("#B8B08C");
    expect(desertSage?.css["--pn-code-keyword"]).toBe("#D77C56");
  });

  it("defines Pointer Salmon from the extracted palette", () => {
    const salmon = POINTER_THEMES.find((theme) => theme.id === "pointer-salmon");
    expect(salmon).toBeTruthy();
    expect(salmon?.label).toBe("Pointer Salmon");
    expect(salmon?.type).toBe("dark");
    expect(salmon?.css["--pn-canvas"]).toBe("#041F1E");
    expect(salmon?.css["--pn-ridge"]).toBe("#1E2D2F");
    expect(salmon?.css["--pn-accent"]).toBe("#F1AB86");
    expect(salmon?.css["--pn-accent-hot"]).toBe("#F7DBA7");
    expect(salmon?.css["--pn-accent-soft"]).toBe("#C57B57");
    expect(salmon?.css["--pn-code-bg"]).toBe("#041F1E");
    expect(salmon?.css["--pn-code-string"]).toBe("#F7DBA7");
    expect(salmon?.css["--pn-code-keyword"]).toBe("#F1AB86");
    expect(salmon?.css["--pn-code-operator"]).toBe("#C57B57");
  });

  it("keeps editor guide lines themed and away from white grid defaults", () => {
    for (const theme of POINTER_THEMES) {
      for (const key of GUIDE_COLOR_KEYS) {
        const color = theme.monaco.colors[key]?.toLowerCase();
        expect(color, `${theme.id} ${key}`).toBeTruthy();
        expect(color).not.toMatch(/^#(?:fff|ffffff|ffffff[0-9a-f]{2})$/);
      }
    }
  });

  it("normalizes legacy stored theme ids", () => {
    expect(normalizeAppThemeId("noir")).toBe("pointer-noir");
    expect(normalizeAppThemeId("light")).toBe("pointer-blanc");
    expect(normalizeAppThemeId("pointer-gris")).toBe("pointer-gris");
    expect(normalizeAppThemeId("pointer-vampire")).toBe("pointer-vampire");
    expect(normalizeAppThemeId("missing")).toBe("pointer-noir");
  });

  it("applies css variables and theme metadata to the document", () => {
    const theme = applyPointerThemeToDocument("pointer-vampire");

    expect(theme.id).toBe("pointer-vampire");
    expect(document.documentElement.dataset.pointerTheme).toBe("pointer-vampire");
    expect(document.body.dataset.pointerTheme).toBe("pointer-vampire");
    expect(document.documentElement.style.getPropertyValue("--pn-canvas")).toBe(
      theme.css["--pn-canvas"],
    );
  });
});

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(hexToRgb(foreground));
  const b = relativeLuminance(hexToRgb(background));
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channels = [r, g, b].map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function hexToRgb(value: string): [number, number, number] {
  const hex = value.replace(/^#/, "").slice(0, 6);
  return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [
    number,
    number,
    number,
  ];
}
