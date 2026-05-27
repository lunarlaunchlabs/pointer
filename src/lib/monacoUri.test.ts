import { describe, expect, it } from "vitest";
import { pathFromMonacoUri } from "./monacoUri";

describe("pathFromMonacoUri", () => {
  it("normalizes encoded Monaco file URIs back to filesystem paths", () => {
    expect(pathFromMonacoUri("file:///Users/sameer/My%20Repo/src/App.tsx")).toBe(
      "/Users/sameer/My Repo/src/App.tsx",
    );
  });

  it("normalizes Windows-style file URIs", () => {
    expect(pathFromMonacoUri("file:///C:/repo/src/App.tsx")).toBe(
      "C:/repo/src/App.tsx",
    );
  });
});
