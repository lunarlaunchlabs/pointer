import { describe, expect, it } from "vitest";
import {
  candidatePaths,
  extractPathTarget,
  resolvePathTarget,
} from "./fileNavigation";

describe("fileNavigation", () => {
  it("extracts import-string targets under the cursor", () => {
    const line = `import Button from "@/components/Button";`;
    const target = extractPathTarget(line, line.indexOf("components") + 2);
    expect(target).toMatchObject({
      raw: "@/components/Button",
      startColumn: line.indexOf("@/") + 1,
    });
  });

  it("ignores package imports that are not files", () => {
    const line = `import React from "react";`;
    expect(extractPathTarget(line, line.indexOf("react") + 2)).toBeNull();
  });

  it("expands extensionless relative imports like modern JS tooling", () => {
    const paths = candidatePaths("./Button", "/repo/src/App.tsx", "/repo");
    expect(paths).toContain("/repo/src/Button.tsx");
    expect(paths).toContain("/repo/src/Button/index.ts");
  });

  it("resolves aliased imports against src first", async () => {
    const target = extractPathTarget(`import x from "@/lib/x"`, 18)!;
    const resolved = await resolvePathTarget({
      target,
      sourcePath: "/repo/src/App.tsx",
      workspaceRoot: "/repo",
      exists: async (p) => (p === "/repo/src/lib/x.ts" ? "file" : null),
    });
    expect(resolved?.path).toBe("/repo/src/lib/x.ts");
  });

  it("prefers an exact js target before ts source fallbacks", async () => {
    const target = extractPathTarget(`import x from "./x.js"`, 18)!;
    const seen: string[] = [];
    const resolved = await resolvePathTarget({
      target,
      sourcePath: "/repo/src/App.tsx",
      workspaceRoot: "/repo",
      exists: async (p) => {
        seen.push(p);
        return p === "/repo/src/x.js" ? "file" : null;
      },
    });
    expect(resolved?.path).toBe("/repo/src/x.js");
    expect(seen[0]).toBe("/repo/src/x.js");
  });

  it("extracts markdown link destinations", () => {
    const line = "See [guide](./docs/start.md) for details";
    const target = extractPathTarget(line, line.indexOf("start") + 2);
    expect(target?.raw).toBe("./docs/start.md");
  });

  it("treats imported image assets as navigable files", async () => {
    const line = `import hero from "../public/assets/home.png";`;
    const target = extractPathTarget(line, line.indexOf("home") + 2)!;
    expect(target.raw).toBe("../public/assets/home.png");

    const resolved = await resolvePathTarget({
      target,
      sourcePath: "/repo/src/Components/Home.js",
      workspaceRoot: "/repo",
      exists: async (p) =>
        p === "/repo/src/public/assets/home.png" ? "file" : null,
    });
    expect(resolved?.path).toBe("/repo/src/public/assets/home.png");
  });

  it("expands directory component imports to Vue index files", () => {
    const paths = candidatePaths("./components/Editor", "/repo/src/App.vue", "/repo");
    expect(paths).toContain("/repo/src/components/Editor/index.vue");
  });

  it("resolves public asset strings used in React JSX", async () => {
    const target = extractPathTarget(`<img src="assets/about.jpeg" />`, 12)!;
    const resolved = await resolvePathTarget({
      target,
      sourcePath: "/repo/src/Components/About.js",
      workspaceRoot: "/repo",
      exists: async (p) =>
        p === "/repo/public/assets/about.jpeg" ? "file" : null,
    });
    expect(resolved?.path).toBe("/repo/public/assets/about.jpeg");
  });

  it("resolves absolute public URLs back into the workspace public folder", async () => {
    const target = extractPathTarget(`<script src="/export-theme-switcher.js"></script>`, 16)!;
    const resolved = await resolvePathTarget({
      target,
      sourcePath: "/repo/src/utils/export-lib.js",
      workspaceRoot: "/repo",
      exists: async (p) =>
        p === "/repo/public/export-theme-switcher.js" ? "file" : null,
    });
    expect(resolved?.path).toBe("/repo/public/export-theme-switcher.js");
  });
});
