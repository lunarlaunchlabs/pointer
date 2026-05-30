import { describe, expect, it } from "vitest";
import {
  dependencyDiagnosticsForFile,
  isDependencyManifestPath,
} from "./dependencyDiagnostics";

const root = "/repo";

function reader(files: Record<string, string>) {
  return async (path: string) => files[path] ?? null;
}

function lister(files: Record<string, string>) {
  return async (path: string) => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const filePath of Object.keys(files)) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      names.add(rest);
    }
    return Array.from(names).map((name) => ({
      name,
      path: `${prefix}${name}`,
      is_dir: false,
    }));
  };
}

async function diagnosticsFor(opts: {
  path: string;
  language: string;
  content: string;
  files: Record<string, string>;
}) {
  return dependencyDiagnosticsForFile({
    path: opts.path,
    language: opts.language,
    content: opts.content,
    workspaceRoot: root,
    readFile: reader(opts.files),
    listDir: lister(opts.files),
  });
}

describe("dependencyDiagnostics", () => {
  it("marks unresolved package imports without flagging declared JavaScript dependencies", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/src/App.tsx",
      language: "tsx",
      content: "import React from 'react';\nimport leftPad from 'left-pad';\n",
      files: {
        "/repo/package.json": JSON.stringify({
          dependencies: {
            react: "^19.0.0",
          },
        }),
      },
    });

    expect(messages(diagnostics)).toContain('Dependency "left-pad"');
    expect(messages(diagnostics)).not.toContain('Dependency "react"');
  });

  it("normalizes Python package names from pyproject dependencies", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/services/api/app.py",
      language: "python",
      content: "from fastapi import FastAPI\nimport requests\nimport os\n",
      files: {
        "/repo/services/api/pyproject.toml": [
          "[project]",
          'dependencies = ["fastapi>=0.110"]',
        ].join("\n"),
      },
    });

    expect(messages(diagnostics)).toContain('Dependency "requests"');
    expect(messages(diagnostics)).not.toContain('Dependency "fastapi"');
    expect(messages(diagnostics)).not.toContain('Dependency "os"');
  });

  it("checks Rust crates against the nearest Cargo manifest", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/crates/core/src/lib.rs",
      language: "rust",
      content: "use serde::Serialize;\nuse anyhow::Result;\nuse std::fmt;\n",
      files: {
        "/repo/crates/core/Cargo.toml": [
          "[package]",
          'name = "core"',
          "",
          "[dependencies]",
          'serde = "1"',
        ].join("\n"),
      },
    });

    expect(messages(diagnostics)).toContain('Dependency "anyhow"');
    expect(messages(diagnostics)).not.toContain('Dependency "serde"');
    expect(messages(diagnostics)).not.toContain('Dependency "std"');
  });

  it("matches Go imports by module prefix", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/go/cmd/server/main.go",
      language: "go",
      content: [
        "package main",
        "",
        "import (",
        '  "fmt"',
        '  "github.com/gin-gonic/gin"',
        '  "github.com/labstack/echo/v4"',
        ")",
      ].join("\n"),
      files: {
        "/repo/go/go.mod": [
          "module example.com/pointer",
          "",
          "go 1.22",
          "",
          "require github.com/gin-gonic/gin v1.10.0",
        ].join("\n"),
      },
    });

    expect(messages(diagnostics)).toContain('Dependency "github.com/labstack/echo/v4"');
    expect(messages(diagnostics)).not.toContain('Dependency "github.com/gin-gonic/gin"');
    expect(messages(diagnostics)).not.toContain('Dependency "fmt"');
  });

  it("discovers named .csproj manifests rather than requiring a fixed file name", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/dotnet/Program.cs",
      language: "csharp",
      content: "using System;\nusing Newtonsoft.Json;\nusing Dapper;\n",
      files: {
        "/repo/dotnet/App.csproj": [
          '<Project Sdk="Microsoft.NET.Sdk">',
          "  <ItemGroup>",
          '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
          "  </ItemGroup>",
          "</Project>",
        ].join("\n"),
      },
    });

    expect(messages(diagnostics)).toContain('Dependency "Dapper"');
    expect(messages(diagnostics)).not.toContain('Dependency "Newtonsoft"');
    expect(messages(diagnostics)).not.toContain('Dependency "System"');
  });

  it("matches JVM imports against manifest package prefixes", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/jvm/PackageProbe.java",
      language: "java",
      content: [
        "import org.springframework.boot.SpringApplication;",
        "import org.junit.jupiter.api.Test;",
        "import org.slf4j.Logger;",
        "import org.apache.commons.lang3.StringUtils;",
      ].join("\n"),
      files: {
        "/repo/jvm/pom.xml": [
          "<project><dependencies>",
          "<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot</artifactId><version>3.3.0</version></dependency>",
          "<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-api</artifactId><version>5.10.0</version></dependency>",
          "<dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.14.0</version></dependency>",
          "<dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.0</version></dependency>",
          "</dependencies></project>",
        ].join("\n"),
      },
    });

    expect(diagnostics).toEqual([]);
  });

  it("stays quiet when no manifest exists for the file ecosystem", async () => {
    const diagnostics = await diagnosticsFor({
      path: "/repo/scripts/one_off.py",
      language: "python",
      content: "import requests\n",
      files: {},
    });

    expect(diagnostics).toEqual([]);
  });

  it("recognizes fixed and project-named dependency manifests", () => {
    expect(isDependencyManifestPath("/repo/package.json")).toBe(true);
    expect(isDependencyManifestPath("/repo/src/App.csproj")).toBe(true);
    expect(isDependencyManifestPath("/repo/src/App.tsx")).toBe(false);
  });
});

function messages(items: Array<{ message: string }>): string {
  return items.map((item) => item.message).join("\n");
}
