#!/usr/bin/env node
// Generates Pointer's app icons (a pink ▸ on a deep-noir background)
// at all sizes Tauri expects. Run once before `tauri dev` / `tauri build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "..", "src-tauri", "icons");
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
];

function svgFor(size) {
  const pad = Math.round(size * 0.18);
  const tri = size - pad * 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="70%">
      <stop offset="0%" stop-color="#15151B"/>
      <stop offset="100%" stop-color="#0A0A0C"/>
    </radialGradient>
    <linearGradient id="tri" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FF2D7E"/>
      <stop offset="60%" stop-color="#FFB3CE"/>
      <stop offset="100%" stop-color="#FFD480"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="${size * 0.04}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#bg)"/>
  <g filter="url(#glow)">
    <polygon points="${pad},${pad} ${pad + tri},${size / 2} ${pad},${size - pad}" fill="url(#tri)"/>
  </g>
</svg>`;
}

const main = async () => {
  for (const s of sizes) {
    const svg = Buffer.from(svgFor(s.size));
    const out = path.join(outDir, s.name);
    await sharp(svg).png().toFile(out);
    console.log("wrote", out);
  }

  // .icns and .ico for bundling — produce from the 512px PNG.
  const png512 = path.join(outDir, "icon.png");
  // Tauri also expects icon.icns and icon.ico in bundle.icon. We generate
  // placeholders by copying the PNG — they're only required for actual bundles.
  try {
    fs.copyFileSync(png512, path.join(outDir, "icon.icns"));
    fs.copyFileSync(png512, path.join(outDir, "icon.ico"));
  } catch (e) {
    console.warn("icns/ico copy failed:", e);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
