#!/usr/bin/env node
// Generates Pointer's app icons from the same SVG mark geometry the UI uses.
// Tauri expects the root icons for bundling; Pointer also embeds per-theme
// Dock-icon PNGs so macOS can mirror the active theme at runtime.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "..", "src-tauri", "icons");
const markSourcePath = path.resolve(__dirname, "..", "src", "lib", "brandLogo.ts");
const themeSourcePath = path.resolve(__dirname, "..", "src", "theme", "themes.ts");
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
];

const iconset = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

const POINTER_MARK_PATH = readPointerMarkPath();
const THEMES = readPointerThemes();
const DEFAULT_THEME = THEMES.find((theme) => theme.id === "pointer-noir") ?? THEMES[0];

const main = async () => {
  const themeOutDir = path.join(outDir, "themes");
  fs.mkdirSync(themeOutDir, { recursive: true });

  for (const s of sizes) {
    const out = path.join(outDir, s.name);
    fs.writeFileSync(out, await renderIconPng(s.size, DEFAULT_THEME));
    console.log("wrote", out);
  }

  for (const theme of THEMES) {
    const out = path.join(themeOutDir, `${theme.id}.png`);
    fs.writeFileSync(out, await renderIconPng(512, theme));
    console.log("wrote", out);
  }

  await writeIcns(path.join(outDir, "icon.icns"));
  await writeIco(path.join(outDir, "icon.ico"));
};

async function renderIconPng(size, theme) {
  return sharp(Buffer.from(renderIconSvg(size, theme)))
    .png()
    .toBuffer();
}

async function writeIcns(outPath) {
  const tmp = path.join(outDir, "icon.iconset");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const entry of iconset) {
    fs.writeFileSync(path.join(tmp, entry.name), await renderIconPng(entry.size, DEFAULT_THEME));
  }
  try {
    execFileSync("iconutil", ["-c", "icns", tmp, "-o", outPath], {
      stdio: "ignore",
    });
    console.log("wrote", outPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function writeIco(outPath) {
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(icoSizes.map((size) => renderIconPng(size, DEFAULT_THEME)));
  const headerSize = 6 + images.length * 16;
  const totalSize = headerSize + images.reduce((sum, img) => sum + img.length, 0);
  const out = Buffer.alloc(totalSize);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(images.length, 4);
  let imageOffset = headerSize;
  images.forEach((img, index) => {
    const size = icoSizes[index];
    const entryOffset = 6 + index * 16;
    out.writeUInt8(size >= 256 ? 0 : size, entryOffset);
    out.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
    out.writeUInt8(0, entryOffset + 2);
    out.writeUInt8(0, entryOffset + 3);
    out.writeUInt16LE(1, entryOffset + 4);
    out.writeUInt16LE(32, entryOffset + 6);
    out.writeUInt32LE(img.length, entryOffset + 8);
    out.writeUInt32LE(imageOffset, entryOffset + 12);
    img.copy(out, imageOffset);
    imageOffset += img.length;
  });
  fs.writeFileSync(outPath, out);
  console.log("wrote", outPath);
}

function renderIconSvg(size, theme) {
  const bg = theme.css["--pn-canvas"];
  const panel = theme.css["--pn-panel"];
  const line = theme.css["--pn-line"];
  const accent = theme.css["--pn-accent"];
  const accentHot = theme.css["--pn-accent-hot"];
  const accentSoft = theme.css["--pn-accent-soft"];
  const radius = 108;
  const stroke = 5;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="54" y1="31" x2="449" y2="489" gradientUnits="userSpaceOnUse">
          <stop stop-color="${panel}"/>
          <stop offset="1" stop-color="${bg}"/>
        </linearGradient>
        <radialGradient id="halo" cx="50%" cy="46%" r="52%">
          <stop stop-color="${accent}" stop-opacity="0.34"/>
          <stop offset="0.64" stop-color="${accent}" stop-opacity="0.09"/>
          <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="mark" x1="98" y1="112" x2="401" y2="397" gradientUnits="userSpaceOnUse">
          <stop stop-color="${accentHot}"/>
          <stop offset="0.58" stop-color="${accent}"/>
          <stop offset="1" stop-color="${accentSoft}"/>
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="${radius}" fill="url(#bg)"/>
      <rect width="512" height="512" rx="${radius}" fill="url(#halo)"/>
      <rect x="${stroke / 2}" y="${stroke / 2}" width="${512 - stroke}" height="${512 - stroke}" rx="${radius - stroke / 2}" fill="none" stroke="${line}" stroke-opacity="0.58" stroke-width="${stroke}"/>
      <rect x="${stroke / 2}" y="${stroke / 2}" width="${512 - stroke}" height="${512 - stroke}" rx="${radius - stroke / 2}" fill="none" stroke="${accent}" stroke-opacity="0.24" stroke-width="${stroke}"/>
      <path d="${POINTER_MARK_PATH}" transform="matrix(1.36 0 0 1.36 -60 -81)" fill="url(#mark)" fill-rule="evenodd"/>
    </svg>
  `;
}

function readPointerMarkPath() {
  const source = fs.readFileSync(markSourcePath, "utf8");
  const match = source.match(/export const POINTER_MARK_PATH =\n\s+"([\s\S]*?)";/);
  if (!match) {
    throw new Error(`Could not read POINTER_MARK_PATH from ${markSourcePath}`);
  }
  return match[1];
}

function readPointerThemes() {
  const source = fs.readFileSync(themeSourcePath, "utf8");
  const idsMatch = source.match(/export const POINTER_THEME_IDS = \[([\s\S]*?)\] as const;/);
  if (!idsMatch) {
    throw new Error(`Could not read POINTER_THEME_IDS from ${themeSourcePath}`);
  }
  const ids = [...idsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const themes = [];
  const themeRegex = /createTheme\(\{\s*id: "([^"]+)"[\s\S]*?css: \{([\s\S]*?)\n\s*\},\n\s*tokens:/g;
  for (const match of source.matchAll(themeRegex)) {
    const css = {};
    for (const cssMatch of match[2].matchAll(/"(--pn-[^"]+)": "([^"]+)"/g)) {
      css[cssMatch[1]] = cssMatch[2];
    }
    themes.push({ id: match[1], css });
  }
  const ordered = ids.map((id) => {
    const theme = themes.find((candidate) => candidate.id === id);
    if (!theme) throw new Error(`Missing theme icon palette for ${id}`);
    for (const key of [
      "--pn-canvas",
      "--pn-panel",
      "--pn-line",
      "--pn-accent",
      "--pn-accent-hot",
      "--pn-accent-soft",
    ]) {
      if (!theme.css[key]) throw new Error(`Theme ${id} is missing ${key}`);
    }
    return theme;
  });
  if (ordered.length === 0) throw new Error("No Pointer themes found");
  return ordered;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
