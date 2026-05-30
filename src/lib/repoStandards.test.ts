import { describe, expect, it } from "vitest";
import {
  resolveRepoEditorStandards,
  standardsFromEditorConfigProperties,
  standardsFromVsCodeSettings,
} from "./repoStandards";

describe("repo standards", () => {
  it("maps EditorConfig indentation and whitespace settings", () => {
    expect(
      standardsFromEditorConfigProperties({
        indent_style: "space",
        indent_size: "4",
        trim_trailing_whitespace: "true",
        insert_final_newline: "true",
        end_of_line: "lf",
      }),
    ).toEqual({
      insertSpaces: true,
      tabSize: 4,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      endOfLine: "lf",
    });
  });

  it("maps language-specific VS Code workspace settings", () => {
    const settings = {
      "editor.tabSize": 4,
      "editor.insertSpaces": false,
      "[typescript]": {
        "editor.tabSize": 2,
        "editor.insertSpaces": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
      },
      "files.trimTrailingWhitespace": true,
    };

    expect(standardsFromVsCodeSettings(settings, "/repo/src/App.tsx")).toEqual({
      tabSize: 2,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      defaultFormatter: "esbenp.prettier-vscode",
    });
  });

  it("resolves cascading EditorConfig and VS Code settings from the workspace", async () => {
    const files = new Map<string, string>([
      [
        "/repo/.editorconfig",
        [
          "root = true",
          "",
          "[*]",
          "indent_style = space",
          "indent_size = 2",
          "trim_trailing_whitespace = true",
        ].join("\n"),
      ],
      [
        "/repo/packages/app/.editorconfig",
        [
          "[*.py]",
          "indent_size = 4",
          "insert_final_newline = true",
        ].join("\n"),
      ],
      [
        "/repo/.vscode/settings.json",
        [
          "{",
          "  // committed workspace standards",
          '  "editor.formatOnSave": true,',
          '  "[python]": { "editor.insertSpaces": true }',
          "}",
        ].join("\n"),
      ],
    ]);

    const result = await resolveRepoEditorStandards({
      path: "/repo/packages/app/main.py",
      workspaceRoot: "/repo",
      readTextFile: async (path) => {
        const value = files.get(path);
        if (value == null) throw new Error("missing");
        return value;
      },
    });

    expect(result).toEqual({
      tabSize: 4,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      formatOnSave: true,
      sources: [".editorconfig", ".vscode/settings.json"],
    });
  });
});
