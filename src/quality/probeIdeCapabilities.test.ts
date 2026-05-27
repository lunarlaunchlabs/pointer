import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPathTarget,
  resolvePathTarget,
} from "@/lib/fileNavigation";
import { languageFromPath } from "@/lib/lang";
import { detectPreviewKind } from "@/store/editor";

const REPOS = {
  blog: process.env.BLOG_REPO || "/Users/sameer/Blog-and-Portfolio",
  express: process.env.EXPRESS_REPO || "/Users/sameer/express",
  tauriMarkdown:
    process.env.TAURI_MARKDOWN_REPO || "/Users/sameer/tauri-markdown",
};

const ENABLED = process.env.POINTER_IDE_REPO_PROBE === "1";
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  "coverage",
  ".nyc_output",
]);
const INTENTIONALLY_PLAIN = new Set([
  "",
  ".gitignore",
  ".gitattributes",
  ".gitkeep",
  ".eslintignore",
  "license",
  "readme",
  "txt",
  "sample",
]);

const maybeDescribe = ENABLED ? describe : describe.skip;

maybeDescribe("Pointer IDE capability probe against real local repos", () => {
  it("detects useful language modes or previews for real repo files", () => {
    for (const root of Object.values(REPOS)) {
      expect(fs.existsSync(root), `${root} should exist`).toBe(true);
      const unknown: string[] = [];
      for (const file of walk(root)) {
        if (fs.statSync(file).size === 0) continue;
        if (detectPreviewKind(file)) continue;
        const lang = languageFromPath(file);
        if (lang !== "plaintext") continue;
        const name = path.basename(file).toLowerCase();
        const ext = path.extname(name).replace(/^\./, "");
        if (INTENTIONALLY_PLAIN.has(name) || INTENTIONALLY_PLAIN.has(ext)) {
          continue;
        }
        unknown.push(path.relative(root, file));
      }
      expect(unknown, `${root} plaintext misses`).toEqual([]);
    }
  });

  it("resolves import, require, template, and public asset targets", async () => {
    await expectTarget(
      REPOS.blog,
      "src/App.js",
      "./Components/Nav",
      "src/Components/Nav.js",
    );
    await expectTarget(
      REPOS.blog,
      "src/Components/About.js",
      "assets/about.jpeg",
      "public/assets/about.jpeg",
    );
    await expectTarget(
      REPOS.blog,
      "src/Components/Contact.js",
      "./assets/contact.png",
      "public/assets/contact.png",
    );
    await expectTarget(
      REPOS.express,
      "lib/express.js",
      "./application",
      "lib/application.js",
    );
    await expectTarget(
      REPOS.express,
      "lib/express.js",
      "./request",
      "lib/request.js",
    );
    await expectTarget(
      REPOS.tauriMarkdown,
      "src/App.vue",
      "./components/MyVditor.vue",
      "src/components/MyVditor.vue",
    );
    await expectTarget(
      REPOS.tauriMarkdown,
      "src/components/FindReplace.vue",
      "../utils/i18n-helper.js",
      "src/utils/i18n-helper.js",
    );
    await expectTarget(
      REPOS.tauriMarkdown,
      "src/utils/export-lib.js",
      "/export-theme-switcher.js",
      "public/export-theme-switcher.js",
    );
  });
});

function* walk(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function expectTarget(
  root: string,
  sourceRel: string,
  raw: string,
  expectedRel: string,
) {
  const source = path.join(root, sourceRel);
  const line = fs
    .readFileSync(source, "utf8")
    .split("\n")
    .find((l) => l.includes(raw));
  expect(line, `${sourceRel} should contain ${raw}`).toBeTruthy();
  const target = extractPathTarget(line!, line!.indexOf(raw) + 2);
  expect(target?.raw).toBe(raw);
  const resolved = await resolvePathTarget({
    target: target!,
    sourcePath: source,
    workspaceRoot: root,
    exists: async (candidate) => {
      try {
        const s = fs.statSync(candidate);
        if (s.isFile()) return "file";
        if (s.isDirectory()) return "dir";
      } catch {
        return null;
      }
      return null;
    },
  });
  expect(path.relative(root, resolved?.path ?? "")).toBe(expectedRel);
}
