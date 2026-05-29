#!/usr/bin/env node
// Generates Pointer's app icons from the branded mark asset at all sizes
// Tauri expects. Run once before `tauri dev` / `tauri build`.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "..", "src-tauri", "icons");
const markPath = path.resolve(__dirname, "..", "public", "brand", "pointer-mark.png");
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

const main = async () => {
  if (!fs.existsSync(markPath)) {
    throw new Error(`Missing Pointer mark asset: ${markPath}`);
  }

  for (const s of sizes) {
    const out = path.join(outDir, s.name);
    fs.writeFileSync(out, await renderIconPng(s.size));
    console.log("wrote", out);
  }

  await writeIcns(path.join(outDir, "icon.icns"));
  await writeIco(path.join(outDir, "icon.ico"));
};

async function renderIconPng(size) {
  const radius = Math.round(size * 0.21);
  const stroke = Math.max(1, Math.round(size / 160));
  const markSize = Math.round(size * 0.76);
  const mark = await sharp(markPath)
    .resize(markSize, markSize, { fit: "inside", position: "center" })
    .png()
    .toBuffer();
  const base = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" rx="${radius}" fill="#050507"/>
      <rect x="${stroke / 2}" y="${stroke / 2}" width="${size - stroke}" height="${size - stroke}" rx="${Math.max(0, radius - stroke / 2)}" fill="none" stroke="rgba(255,45,126,0.24)" stroke-width="${stroke}"/>
    </svg>
  `);
  return sharp(base)
    .composite([
      {
        input: mark,
        left: Math.round((size - markSize) / 2),
        top: Math.round((size - markSize) / 2),
        blend: "screen",
      },
    ])
    .png()
    .toBuffer();
}

async function writeIcns(outPath) {
  const tmp = path.join(outDir, "icon.iconset");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const entry of iconset) {
    fs.writeFileSync(path.join(tmp, entry.name), await renderIconPng(entry.size));
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
  const images = await Promise.all(icoSizes.map((size) => renderIconPng(size)));
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
