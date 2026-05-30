#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const themeSourcePath = path.join(repoRoot, "src", "theme", "themes.ts");
const referencePath =
  process.argv.find((arg) => arg.startsWith("--reference="))?.slice("--reference=".length) ??
  "/Users/sameer/Desktop/download.png";
const outPath =
  process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length) ??
  path.join(os.tmpdir(), "pointer-meteor-probe.png");

const targetSamples = {
  outer: { point: [30, 30], hex: "#64B898", tolerance: 7 },
  window: { point: [90, 90], hex: "#1E1E1E", tolerance: 5 },
  sidebar: { point: [105, 449], hex: "#1E1E1E", tolerance: 5 },
  selectedRow: { point: [269, 609], hex: "#343434", tolerance: 6 },
  editor: { point: [1048, 344], hex: "#212121", tolerance: 5 },
  currentLine: { point: [1272, 507], hex: "#373737", tolerance: 6 },
  status: { point: [1377, 1853], hex: "#49616D", tolerance: 7 },
  accent: { point: [2832, 112], hex: "#7ACAC4", tolerance: 9 },
  keyword: { point: [1050, 254], hex: "#F27076", tolerance: 10 },
  function: { point: [1163, 194], hex: "#60B4F9", tolerance: 8 },
  string: { point: [1567, 794], hex: "#7FC881", tolerance: 8 },
  type: { point: [1049, 194], hex: "#FFCC63", tolerance: 8 },
  number: { point: [1256, 254], hex: "#F98C68", tolerance: 8 },
  cyan: { point: [1354, 260], hex: "#86DDFF", tolerance: 10 },
  purple: { point: [969, 194], hex: "#B39BDD", tolerance: 10 },
};

function readTheme(id) {
  const source = fs.readFileSync(themeSourcePath, "utf8");
  const themeMatch = source.match(
    new RegExp(`createTheme\\(\\{\\s*id: "${id}"[\\s\\S]*?css: \\{([\\s\\S]*?)\\n\\s*\\},\\n\\s*tokens: (\\w+),`),
  );
  if (!themeMatch) throw new Error(`Missing ${id} theme`);
  const css = {};
  for (const match of themeMatch[1].matchAll(/"(--pn-[^"]+)": "([^"]+)"/g)) {
    css[match[1]] = match[2];
  }
  const tokenName = themeMatch[2];
  const tokenMatch = source.match(new RegExp(`const ${tokenName}: TokenPalette = \\{([\\s\\S]*?)\\n\\};`));
  if (!tokenMatch) throw new Error(`Missing ${tokenName}`);
  const tokens = {};
  for (const match of tokenMatch[1].matchAll(/(\w+): "([^"]+)"/g)) {
    tokens[match[1]] = match[2];
  }
  return { css, tokens };
}

function cssVars(css) {
  return Object.entries(css)
    .map(([key, value]) => `${key}: ${value};`)
    .join("\n");
}

function renderHtml(theme) {
  const t = theme.tokens;
  return `<!doctype html>
    <html>
      <head>
        <style>
          :root { ${cssVars(theme.css)} }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            width: 1461px;
            height: 956px;
            overflow: hidden;
            background: var(--pn-body-bg);
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .window {
            position: absolute;
            left: 30px;
            top: 16px;
            width: 1401px;
            height: 912px;
            overflow: hidden;
            border-radius: 6px;
            background: var(--pn-panel);
          }
          .top { position: absolute; inset: 0 0 auto 0; height: 50px; background: var(--pn-panel); }
          .dot { position: absolute; top: 10px; width: 12px; height: 12px; border-radius: 999px; }
          .red { left: 10px; background: #ff6059; }
          .yellow { left: 30px; background: #ffbd2e; }
          .green { left: 50px; background: #28c840; }
          .dots { position: absolute; right: 16px; top: 36px; width: 18px; height: 18px; color: var(--pn-accent); }
          .dots::before { content: ""; position: absolute; left: 0; top: 0; width: 10px; height: 10px; border-radius: 50%; background: currentColor; box-shadow: 0 8px 0 currentColor, 0 16px 0 currentColor; }
          .sidebar { position: absolute; left: 0; top: 50px; bottom: 26px; width: 376px; background: var(--pn-panel); }
          .editor { position: absolute; left: 376px; top: 50px; right: 0; bottom: 26px; background: var(--pn-canvas); }
          .tabbar { position: absolute; left: 376px; top: 50px; right: 0; height: 34px; background: var(--pn-chrome); }
          .tab { position: absolute; top: 0; height: 34px; width: 98px; background: var(--pn-canvas); }
          .tab.one { left: 122px; }
          .selected { position: absolute; left: 0; top: 238px; width: 376px; height: 20px; background: var(--pn-selection-bg); }
          .line { position: absolute; left: 0; top: 187px; right: 0; height: 20px; background: ${t.lineHighlight}; }
          .status { position: absolute; left: 0; bottom: 0; right: 0; height: 26px; background: var(--pn-status-bg); }
          .probe { position: absolute; width: 16px; height: 16px; border-radius: 2px; }
          .accentProbe { left: 1412px; top: 52px; background: var(--pn-accent); border-radius: 999px; }
          .keyword { left: 521px; top: 123px; background: ${t.keyword}; }
          .fn { left: 577px; top: 93px; background: ${t.function}; }
          .string { left: 779px; top: 393px; background: ${t.string}; }
          .type { left: 520px; top: 93px; background: ${t.type}; }
          .number { left: 624px; top: 123px; background: ${t.number}; }
          .cyan { left: 673px; top: 126px; background: ${t.operator}; }
          .purple { left: 480px; top: 93px; background: #B39BDD; }
        </style>
      </head>
      <body>
        <div class="window">
          <div class="top"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span><span class="dots"></span></div>
          <div class="sidebar"><div class="selected"></div></div>
          <div class="editor"><div class="tabbar"><div class="tab one"></div></div><div class="line"></div></div>
          <div class="status"></div>
        </div>
        <div class="probe accentProbe"></div><div class="probe keyword"></div><div class="probe fn"></div><div class="probe string"></div>
        <div class="probe type"></div><div class="probe number"></div><div class="probe cyan"></div><div class="probe purple"></div>
      </body>
    </html>`;
}

function hexToRgb(hex) {
  return hex
    .replace("#", "")
    .match(/../g)
    .map((part) => parseInt(part, 16));
}

function delta(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function sampleImage(imagePath) {
  const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const samples = {};
  for (const [name, sample] of Object.entries(targetSamples)) {
    const [x, y] = sample.point;
    const offset = (y * info.width + x) * 4;
    samples[name] = [data[offset], data[offset + 1], data[offset + 2]];
  }
  return samples;
}

const theme = readTheme("pointer-meteor");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1461, height: 956 },
    deviceScaleFactor: 2,
  });
  await page.setContent(renderHtml(theme), { waitUntil: "load" });
  await page.screenshot({ path: outPath });
} finally {
  await browser.close();
}

const actual = await sampleImage(outPath);
const reference = fs.existsSync(referencePath) ? await sampleImage(referencePath) : {};
const rows = [];
let failed = false;
for (const [name, target] of Object.entries(targetSamples)) {
  const expected = reference[name] ?? hexToRgb(target.hex);
  const got = actual[name];
  const d = delta(got, expected);
  const ok = d <= target.tolerance;
  if (!ok) failed = true;
  rows.push({
    sample: name,
    expected: `#${expected.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`,
    actual: `#${got.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`,
    delta: Number(d.toFixed(2)),
    tolerance: target.tolerance,
    ok,
  });
}
console.table(rows);
console.log(`screenshot: ${outPath}`);
if (failed) process.exit(1);
