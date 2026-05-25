import type * as monaco from "monaco-editor";

/**
 * Register Monaco color providers that surface a swatch+picker over
 * any hex (`#RGB`, `#RRGGBB`, `#RRGGBBAA`) or rgb/rgba(...) literal
 * in the document. Mirrors VS Code's "Color Decorators" + inline
 * color picker — handy for CSS, Tailwind theme files, JSON colour
 * tables, and the like.
 *
 * Why per-language? Monaco color providers are registered by
 * language id, so we attach to every language that commonly
 * embeds colour literals. JS/TS/HTML/CSS/JSON/YAML/MD covers ~99%
 * of the practical cases without firing the regex parser on every
 * source file (e.g. C/C++/Rust where `#define` and rgb() are not
 * colours).
 */

const LANGS = [
  "css",
  "scss",
  "less",
  "html",
  "json",
  "jsonc",
  "yaml",
  "markdown",
  "javascript",
  "typescript",
];

let registered = false;

export function registerColorProviders(m: typeof monaco): void {
  if (registered) return;
  registered = true;
  const provider: monaco.languages.DocumentColorProvider = {
    provideDocumentColors(model) {
      return scanColors(model);
    },
    provideColorPresentations(model, info) {
      // Round-trip: take the user's pick and emit a single text
      // edit that replaces the literal with the new colour in the
      // same syntax it had before.
      const { color, range } = info;
      const orig = model.getValueInRange(range);
      const next = orig.startsWith("#")
        ? toHex(color, orig.length === 9 || orig.length === 5)
        : toRgb(color, orig.toLowerCase().startsWith("rgba"));
      return [{ label: next, textEdit: { range, text: next } }];
    },
  };
  for (const lang of LANGS) {
    m.languages.registerColorProvider(lang, provider);
  }
}

const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const RGB_RE =
  /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([01]?(?:\.\d+)?))?\s*\)/gi;

function scanColors(
  model: monaco.editor.ITextModel,
): monaco.languages.IColorInformation[] {
  const out: monaco.languages.IColorInformation[] = [];
  const lineCount = model.getLineCount();
  // Cheap upper bound — a 50k-line CSS file would otherwise pin
  // the renderer for a full second on every keystroke.
  if (lineCount > 5000) return out;
  for (let line = 1; line <= lineCount; line++) {
    const text = model.getLineContent(line);
    HEX_RE.lastIndex = 0;
    RGB_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX_RE.exec(text))) {
      const color = parseHex(m[0]);
      if (!color) continue;
      out.push({
        color,
        range: {
          startLineNumber: line,
          startColumn: m.index + 1,
          endLineNumber: line,
          endColumn: m.index + 1 + m[0].length,
        },
      });
    }
    while ((m = RGB_RE.exec(text))) {
      const r = clamp255(+m[1]);
      const g = clamp255(+m[2]);
      const b = clamp255(+m[3]);
      const a = m[4] !== undefined ? Math.max(0, Math.min(1, +m[4])) : 1;
      out.push({
        color: { red: r / 255, green: g / 255, blue: b / 255, alpha: a },
        range: {
          startLineNumber: line,
          startColumn: m.index + 1,
          endLineNumber: line,
          endColumn: m.index + 1 + m[0].length,
        },
      });
    }
  }
  return out;
}

function clamp255(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(lit: string): monaco.languages.IColor | null {
  const h = lit.slice(1);
  let r: number, g: number, b: number, a: number;
  if (h.length === 3 || h.length === 4) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
    a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
  } else if (h.length === 6 || h.length === 8) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  } else {
    return null;
  }
  return { red: r / 255, green: g / 255, blue: b / 255, alpha: a };
}

function toHex(c: monaco.languages.IColor, withAlpha: boolean): string {
  const r = Math.round(c.red * 255);
  const g = Math.round(c.green * 255);
  const b = Math.round(c.blue * 255);
  const a = Math.round(c.alpha * 255);
  const hh = (n: number) => n.toString(16).padStart(2, "0");
  return withAlpha
    ? `#${hh(r)}${hh(g)}${hh(b)}${hh(a)}`
    : `#${hh(r)}${hh(g)}${hh(b)}`;
}

function toRgb(c: monaco.languages.IColor, withAlpha: boolean): string {
  const r = Math.round(c.red * 255);
  const g = Math.round(c.green * 255);
  const b = Math.round(c.blue * 255);
  if (withAlpha || c.alpha < 1) {
    const a = Math.round(c.alpha * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}
