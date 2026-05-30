import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  expect,
  openE2EFile,
  pendingRefs,
  ROOT,
  test,
  writeE2EFile,
} from "./fixtures/pointerApp";
import {
  DEBUGGER_COMPATIBILITY_MATRIX,
  DEBUGGER_LAUNCH_CRITICAL_LANGUAGES,
  DEBUGGER_REQUIRED_FLOWS,
} from "../src/lib/debugCompatibilityMatrix";

type DebugScenario = {
  id: string;
  label: string;
  path: string;
  content: string;
  line: number;
  adapterLanguage: string;
  adapter: RegExp;
  tags: string[];
  valueType: string;
  value: string;
};

const SCENARIOS: DebugScenario[] = [
  {
    id: "react-vite-typescript",
    label: "React/Vite TypeScript frontend",
    path: `${ROOT}/src/App.tsx`,
    content: [
      "import { Button } from './components/Button';",
      "import { renderGreeting } from './utils/greeting';",
      "",
      "export default function App() {",
      "  const title = renderGreeting('Pointer');",
      "  return <Button label={title} onClick={() => console.log(title)} />;",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["react", "vite", "test"],
    valueType: "string",
    value: "Pointer",
  },
  {
    id: "express-node-javascript",
    label: "Express Node JavaScript backend",
    path: `${ROOT}/server/router.js`,
    content: [
      "import { Router } from 'express';",
      "",
      "export function makeRouter() {",
      "  const router = Router();",
      "  router.get('/health', (_req, res) => res.json({ ok: true }));",
      "  return router;",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "javascript",
    adapter: /js-debug/i,
    tags: ["express", "node", "test"],
    valueType: "Response",
    value: "{ ok: true }",
  },
  {
    id: "next-react-typescript",
    label: "Next.js React TypeScript app",
    path: `${ROOT}/next/app/page.tsx`,
    content: [
      "export default function Page() {",
      "  const user = { name: 'Pointer' };",
      "  const title = `Hello, ${user.name}`;",
      "  return <main>{title}</main>;",
      "}",
    ].join("\n"),
    line: 3,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["next", "react", "browser"],
    valueType: "string",
    value: "Hello, Pointer",
  },
  {
    id: "angular-typescript",
    label: "Angular TypeScript frontend",
    path: `${ROOT}/angular/src/app/app.component.ts`,
    content: [
      "import { Component } from '@angular/core';",
      "",
      "@Component({ selector: 'app-root', template: '<h1>{{ title }}</h1>' })",
      "export class AppComponent {",
      "  title = 'Pointer';",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["angular", "browser"],
    valueType: "string",
    value: "Pointer",
  },
  {
    id: "vue-typescript",
    label: "Vue TypeScript frontend",
    path: `${ROOT}/vue/App.vue`,
    content: [
      "<template>",
      "  <button @click=\"count++\">{{ label }} {{ count }}</button>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "import { ref } from 'vue';",
      "const label = 'Pointer';",
      "const count = ref(0);",
      "</script>",
    ].join("\n"),
    line: 7,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["vue", "vite"],
    valueType: "Ref<number>",
    value: "0",
  },
  {
    id: "nuxt-vue-typescript",
    label: "Nuxt Vue TypeScript app",
    path: `${ROOT}/nuxt/app.vue`,
    content: [
      "<template>",
      "  <h1>{{ title }}</h1>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "const title = 'Pointer';",
      "</script>",
    ].join("\n"),
    line: 6,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["nuxt", "vue", "vite"],
    valueType: "string",
    value: "Pointer",
  },
  {
    id: "svelte-typescript",
    label: "Svelte TypeScript frontend",
    path: `${ROOT}/svelte/App.svelte`,
    content: [
      "<script lang=\"ts\">",
      "  let count = 0;",
      "  export let label = 'Pointer';",
      "</script>",
      "",
      "<button on:click={() => count += 1}>{label} {count}</button>",
    ].join("\n"),
    line: 6,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["svelte", "browser"],
    valueType: "number",
    value: "1",
  },
  {
    id: "remix-typescript",
    label: "Remix React TypeScript route",
    path: `${ROOT}/remix/app/routes/_index.tsx`,
    content: [
      "export function loader() {",
      "  return { message: 'Pointer' };",
      "}",
      "",
      "export default function Index() {",
      "  const title = 'Pointer';",
      "  return <h1>{title}</h1>;",
      "}",
    ].join("\n"),
    line: 6,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["remix", "react"],
    valueType: "string",
    value: "Pointer",
  },
  {
    id: "nestjs-typescript",
    label: "NestJS TypeScript backend",
    path: `${ROOT}/nest/src/app.controller.ts`,
    content: [
      "import { Controller, Get } from '@nestjs/common';",
      "",
      "@Controller()",
      "export class AppController {",
      "  @Get('/health')",
      "  health() { return { ok: true }; }",
      "}",
    ].join("\n"),
    line: 6,
    adapterLanguage: "typescript",
    adapter: /js-debug/i,
    tags: ["nestjs", "node"],
    valueType: "object",
    value: "{ ok: true }",
  },
  {
    id: "python-fastapi",
    label: "FastAPI Python backend",
    path: `${ROOT}/python/app.py`,
    content: [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      "@app.get('/health')",
      "def health() -> dict[str, bool]:",
      "    return {'ok': True}",
    ].join("\n"),
    line: 6,
    adapterLanguage: "python",
    adapter: /debugpy/i,
    tags: ["fastapi", "pytest"],
    valueType: "dict[str, bool]",
    value: "{'ok': True}",
  },
  {
    id: "python-django",
    label: "Django Python backend",
    path: `${ROOT}/python/project/views.py`,
    content: [
      "from django.http import JsonResponse",
      "",
      "def health(request):",
      "    payload = {'ok': True}",
      "    return JsonResponse(payload)",
    ].join("\n"),
    line: 4,
    adapterLanguage: "python",
    adapter: /debugpy/i,
    tags: ["django", "pytest"],
    valueType: "dict[str, bool]",
    value: "{'ok': True}",
  },
  {
    id: "python-flask",
    label: "Flask Python backend",
    path: `${ROOT}/python/flask_app.py`,
    content: [
      "from flask import Flask, jsonify",
      "",
      "app = Flask(__name__)",
      "",
      "@app.get('/health')",
      "def health():",
      "    return jsonify(ok=True)",
    ].join("\n"),
    line: 6,
    adapterLanguage: "python",
    adapter: /debugpy/i,
    tags: ["flask", "pytest"],
    valueType: "Response",
    value: "200 OK",
  },
  {
    id: "rust-cargo",
    label: "Rust Cargo library/backend",
    path: `${ROOT}/rust/src/lib.rs`,
    content: [
      "pub fn render_greeting(name: &str) -> String {",
      "    format!(\"Hello, {name}\")",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "}",
    ].join("\n"),
    line: 2,
    adapterLanguage: "rust",
    adapter: /lldb/i,
    tags: ["cargo", "tauri", "axum"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "go-gin",
    label: "Go service",
    path: `${ROOT}/go/main.go`,
    content: [
      "package main",
      "",
      "import \"fmt\"",
      "",
      "func renderGreeting(name string) string {",
      "    return fmt.Sprintf(\"Hello, %s\", name)",
      "}",
      "",
      "func main() {",
      "    fmt.Println(renderGreeting(\"Pointer\"))",
      "}",
    ].join("\n"),
    line: 6,
    adapterLanguage: "go",
    adapter: /dlv dap/i,
    tags: ["go test", "go run", "gin"],
    valueType: "string",
    value: "Hello, Pointer",
  },
  {
    id: "java-spring-maven",
    label: "Java Maven/Spring backend",
    path: `${ROOT}/java/src/main/java/com/example/App.java`,
    content: [
      "package com.example;",
      "",
      "public class App {",
      "  public static String renderGreeting(String name) {",
      "    return \"Hello, \" + name;",
      "  }",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "java",
    adapter: /java-debug/i,
    tags: ["maven", "spring"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "dotnet-csharp-aspnet",
    label: ".NET C# backend",
    path: `${ROOT}/dotnet/Program.cs`,
    content: [
      "var builder = WebApplication.CreateBuilder(args);",
      "var app = builder.Build();",
      "",
      "app.MapGet(\"/health\", () => Results.Ok(new { ok = true }));",
      "app.Run();",
    ].join("\n"),
    line: 4,
    adapterLanguage: "csharp",
    adapter: /netcoredbg/i,
    tags: ["aspnet", "xunit"],
    valueType: "IResult",
    value: "{ ok = true }",
  },
  {
    id: "php-laravel",
    label: "PHP Laravel/Symfony backend",
    path: `${ROOT}/php/app.php`,
    content: [
      "<?php",
      "",
      "use Monolog\\Logger;",
      "",
      "function health(Logger $logger): array {",
      "    $logger->info('health');",
      "    return ['ok' => true];",
      "}",
    ].join("\n"),
    line: 6,
    adapterLanguage: "php",
    adapter: /xdebug/i,
    tags: ["laravel", "phpunit"],
    valueType: "array",
    value: "['ok' => true]",
  },
  {
    id: "ruby-rails",
    label: "Ruby Rails/RSpec backend",
    path: `${ROOT}/ruby/app.rb`,
    content: [
      "require \"faraday\"",
      "",
      "def health(client)",
      "  response = client.get('/health')",
      "  response.status",
      "end",
    ].join("\n"),
    line: 4,
    adapterLanguage: "ruby",
    adapter: /rdbg/i,
    tags: ["rails", "rspec"],
    valueType: "Faraday::Response",
    value: "200",
  },
  {
    id: "dart-flutter",
    label: "Dart/Flutter app",
    path: `${ROOT}/dart/lib/main.dart`,
    content: [
      "import 'package:flutter/widgets.dart';",
      "",
      "Widget buildTitle(String title) {",
      "  final text = Text(title);",
      "  return Center(child: text);",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "dart",
    adapter: /dart-debug-adapter/i,
    tags: ["flutter", "dart test"],
    valueType: "Text",
    value: "Text(\"Pointer\")",
  },
  {
    id: "swift-swiftpm",
    label: "Swift Package/Vapor app",
    path: `${ROOT}/swift/Sources/App.swift`,
    content: [
      "import Foundation",
      "",
      "func renderGreeting(_ name: String) -> String {",
      "  let title = \"Hello, \\(name)\"",
      "  return title",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "swift",
    adapter: /lldb/i,
    tags: ["swiftpm", "xctest"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "cpp-cmake",
    label: "C++ CMake native service",
    path: `${ROOT}/native/main.cpp`,
    content: [
      "#include <iostream>",
      "#include <string>",
      "",
      "std::string renderGreeting(std::string name) {",
      "  auto title = \"Hello, \" + name;",
      "  return title;",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "cpp",
    adapter: /lldb-dap|cpptools/i,
    tags: ["cmake", "gtest"],
    valueType: "std::string",
    value: "Hello, Pointer",
  },
  {
    id: "c-make",
    label: "C Make native service",
    path: `${ROOT}/native/main.c`,
    content: [
      "#include <stdio.h>",
      "",
      "int main(void) {",
      "  int status = 0;",
      "  return status;",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "c",
    adapter: /lldb-dap|cpptools/i,
    tags: ["make", "executable"],
    valueType: "int",
    value: "0",
  },
  {
    id: "objective-c-xcode",
    label: "Objective-C Xcode app",
    path: `${ROOT}/apple/AppDelegate.m`,
    content: [
      "#import <Foundation/Foundation.h>",
      "",
      "int main(int argc, const char * argv[]) {",
      "  @autoreleasepool {",
      "    NSString *title = @\"Pointer\";",
      "    NSLog(@\"%@\", title);",
      "  }",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "objective-c",
    adapter: /lldb/i,
    tags: ["xcode", "xctest"],
    valueType: "NSString *",
    value: "@\"Pointer\"",
  },
  {
    id: "kotlin-ktor",
    label: "Kotlin Ktor/Spring backend",
    path: `${ROOT}/kotlin/src/main/kotlin/App.kt`,
    content: [
      "package example",
      "",
      "fun renderGreeting(name: String): String {",
      "  val title = \"Hello, $name\"",
      "  return title",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "kotlin",
    adapter: /java-debug/i,
    tags: ["ktor", "junit"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "android-kotlin",
    label: "Android Kotlin app",
    path: `${ROOT}/android/app/src/main/java/com/example/MainActivity.kt`,
    content: [
      "package com.example",
      "",
      "class MainActivity {",
      "  fun renderTitle(): String {",
      "    val title = \"Pointer\"",
      "    return title",
      "  }",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "kotlin",
    adapter: /java-debug/i,
    tags: ["android", "gradle"],
    valueType: "String",
    value: "Pointer",
  },
  {
    id: "scala-play",
    label: "Scala Play/Akka backend",
    path: `${ROOT}/scala/src/main/scala/App.scala`,
    content: [
      "package example",
      "",
      "object App {",
      "  def renderGreeting(name: String): String = {",
      "    val title = s\"Hello, $name\"",
      "    title",
      "  }",
      "}",
    ].join("\n"),
    line: 5,
    adapterLanguage: "scala",
    adapter: /java-debug/i,
    tags: ["sbt", "scalatest"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "groovy-gradle",
    label: "Groovy Gradle/Spock app",
    path: `${ROOT}/groovy/src/main/groovy/App.groovy`,
    content: [
      "class App {",
      "  static String renderGreeting(String name) {",
      "    def title = \"Hello, ${name}\"",
      "    return title",
      "  }",
      "}",
    ].join("\n"),
    line: 3,
    adapterLanguage: "groovy",
    adapter: /java-debug/i,
    tags: ["gradle", "spock"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "clojure-deps",
    label: "Clojure deps.edn service",
    path: `${ROOT}/clojure/src/example/core.clj`,
    content: [
      "(ns example.core)",
      "",
      "(defn render-greeting [name]",
      "  (let [title (str \"Hello, \" name)]",
      "    title))",
    ].join("\n"),
    line: 4,
    adapterLanguage: "clojure",
    adapter: /java-debug/i,
    tags: ["deps.edn", "repl"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "fsharp-dotnet",
    label: "F# .NET service",
    path: `${ROOT}/fsharp/Program.fs`,
    content: [
      "module Program",
      "",
      "let renderGreeting name =",
      "  let title = $\"Hello, {name}\"",
      "  title",
    ].join("\n"),
    line: 4,
    adapterLanguage: "fsharp",
    adapter: /netcoredbg/i,
    tags: ["dotnet", "expecto"],
    valueType: "string",
    value: "Hello, Pointer",
  },
  {
    id: "shell-bats",
    label: "Shell/Bats script",
    path: `${ROOT}/scripts/health.sh`,
    content: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      "status=\"ok\"",
      "printf '%s\\n' \"$status\"",
    ].join("\n"),
    line: 4,
    adapterLanguage: "shell",
    adapter: /bashdb/i,
    tags: ["bash", "bats"],
    valueType: "string",
    value: "ok",
  },
  {
    id: "powershell-pester",
    label: "PowerShell/Pester script",
    path: `${ROOT}/scripts/Health.ps1`,
    content: [
      "param([string]$Name = \"Pointer\")",
      "",
      "function Get-Greeting {",
      "  $title = \"Hello, $Name\"",
      "  return $title",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "powershell",
    adapter: /PowerShell Editor Services/i,
    tags: ["powershell", "pester"],
    valueType: "string",
    value: "Hello, Pointer",
  },
  {
    id: "lua-busted",
    label: "Lua/Busted script",
    path: `${ROOT}/lua/app.lua`,
    content: [
      "local M = {}",
      "",
      "function M.render_greeting(name)",
      "  local title = \"Hello, \" .. name",
      "  return title",
      "end",
      "",
      "return M",
    ].join("\n"),
    line: 4,
    adapterLanguage: "lua",
    adapter: /local-lua-debugger/i,
    tags: ["luarocks", "busted"],
    valueType: "string",
    value: "Hello, Pointer",
  },
  {
    id: "perl-mojolicious",
    label: "Perl/Mojolicious script",
    path: `${ROOT}/perl/app.pl`,
    content: [
      "use strict;",
      "use warnings;",
      "",
      "my $title = \"Hello, Pointer\";",
      "print \"$title\\n\";",
    ].join("\n"),
    line: 4,
    adapterLanguage: "perl",
    adapter: /perl-debug-adapter/i,
    tags: ["prove", "mojolicious"],
    valueType: "scalar",
    value: "Hello, Pointer",
  },
  {
    id: "r-shiny",
    label: "R/Shiny script",
    path: `${ROOT}/r/app.R`,
    content: [
      "library(shiny)",
      "",
      "render_greeting <- function(name) {",
      "  title <- paste(\"Hello\", name, sep = \", \")",
      "  title",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "r",
    adapter: /R Debugger/i,
    tags: ["testthat", "shiny"],
    valueType: "character",
    value: "Hello, Pointer",
  },
  {
    id: "haskell-stack",
    label: "Haskell Stack/Cabal service",
    path: `${ROOT}/haskell/app/Main.hs`,
    content: [
      "module Main where",
      "",
      "renderGreeting :: String -> String",
      "renderGreeting name =",
      "  let title = \"Hello, \" ++ name",
      "  in title",
    ].join("\n"),
    line: 5,
    adapterLanguage: "haskell",
    adapter: /haskell-debug-adapter/i,
    tags: ["cabal", "stack"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "elixir-phoenix",
    label: "Elixir Phoenix app",
    path: `${ROOT}/elixir/lib/app.ex`,
    content: [
      "defmodule App do",
      "  def render_greeting(name) do",
      "    title = \"Hello, #{name}\"",
      "    title",
      "  end",
      "end",
    ].join("\n"),
    line: 3,
    adapterLanguage: "elixir",
    adapter: /elixir-ls-debugger/i,
    tags: ["phoenix", "exunit"],
    valueType: "String.t()",
    value: "Hello, Pointer",
  },
  {
    id: "erlang-otp",
    label: "Erlang/OTP service",
    path: `${ROOT}/erlang/src/app.erl`,
    content: [
      "-module(app).",
      "-export([render_greeting/1]).",
      "",
      "render_greeting(Name) ->",
      "  Title = \"Hello, \" ++ Name,",
      "  Title.",
    ].join("\n"),
    line: 5,
    adapterLanguage: "erlang",
    adapter: /erlang-debugger/i,
    tags: ["otp", "eunit"],
    valueType: "string()",
    value: "Hello, Pointer",
  },
  {
    id: "julia-pkg",
    label: "Julia package/test workflow",
    path: `${ROOT}/julia/src/App.jl`,
    content: [
      "module App",
      "",
      "function render_greeting(name)",
      "  title = \"Hello, $name\"",
      "  return title",
      "end",
      "",
      "end",
    ].join("\n"),
    line: 4,
    adapterLanguage: "julia",
    adapter: /Julia VS Code Debug Adapter/i,
    tags: ["pkg", "test"],
    valueType: "String",
    value: "Hello, Pointer",
  },
  {
    id: "zig-build",
    label: "Zig build/test workflow",
    path: `${ROOT}/zig/src/main.zig`,
    content: [
      "const std = @import(\"std\");",
      "",
      "pub fn renderGreeting(name: []const u8) []const u8 {",
      "  const title = name;",
      "  return title;",
      "}",
    ].join("\n"),
    line: 4,
    adapterLanguage: "zig",
    adapter: /lldb-dap/i,
    tags: ["zig build", "zig test"],
    valueType: "[]const u8",
    value: "Pointer",
  },
  {
    id: "ocaml-dune",
    label: "OCaml Dune workflow",
    path: `${ROOT}/ocaml/bin/main.ml`,
    content: [
      "let render_greeting name =",
      "  let title = \"Hello, \" ^ name in",
      "  title",
      "",
      "let () = print_endline (render_greeting \"Pointer\")",
    ].join("\n"),
    line: 2,
    adapterLanguage: "ocaml",
    adapter: /ocamlearlybird/i,
    tags: ["dune", "alcotest"],
    valueType: "string",
    value: "Hello, Pointer",
  },
];

test.describe("debugger polyglot visual coverage", () => {
  test("keeps scenario coverage aligned with the debugger launch matrix", () => {
    const scenarioLanguages = new Set(SCENARIOS.map((scenario) => scenario.adapterLanguage));
    expect([...scenarioLanguages].sort()).toEqual(
      expect.arrayContaining(
        DEBUGGER_COMPATIBILITY_MATRIX.map((capability) => capability.language),
      ),
    );
    expect([...scenarioLanguages].sort()).toEqual(
      expect.arrayContaining(DEBUGGER_LAUNCH_CRITICAL_LANGUAGES),
    );

    const scenarioTags = new Set(SCENARIOS.flatMap((scenario) => scenario.tags));
    expect([...scenarioTags].sort()).toEqual(
      expect.arrayContaining([
        "react",
        "vite",
        "next",
        "vue",
        "nuxt",
        "angular",
        "svelte",
        "remix",
        "nestjs",
        "express",
        "django",
        "flask",
        "fastapi",
        "pytest",
        "cargo",
        "axum",
        "gin",
        "spring",
        "aspnet",
        "laravel",
        "rails",
        "flutter",
        "android",
        "cmake",
        "make",
      ]),
    );
    expect(DEBUGGER_REQUIRED_FLOWS).toEqual(
      expect.arrayContaining([
        "gutter breakpoint",
        "conditional breakpoint",
        "logpoint",
        "captured value",
        "send breakpoint to assistant",
        "send value to assistant",
      ]),
    );
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.label} debugger flow`, async ({ appPage: page }, testInfo) => {
      await exerciseDebuggerScenario(page, scenario, testInfo);
    });
  }
});

async function exerciseDebuggerScenario(
  page: Page,
  scenario: DebugScenario,
  testInfo: TestInfo,
) {
  await writeE2EFile(page, scenario.path, scenario.content);
  await openE2EFile(page, scenario.path);

  const breakpoint = await page.evaluate(async ({ path, line }) => {
    await window.__POINTER_E2E__?.editor?.toggleBreakpointAt?.(line, 1);
    return window.__POINTER_E2E__?.debug
      ?.breakpoints?.()
      ?.find((bp: any) => bp.path === path && bp.line === line);
  }, scenario);
  expect(breakpoint).toMatchObject({
    path: scenario.path,
    line: scenario.line,
    enabled: true,
  });

  await expect
    .poll(() =>
      page.evaluate(
        () => window.__POINTER_E2E__?.editor?.breakpointDecorationClasses?.() ?? [],
      ),
    )
    .toContainEqual(expect.stringContaining("pn-breakpoint-glyph"));

  await page.getByRole("tab", { name: "Debug" }).click();
  const panel = page.getByRole("region", { name: "Debug panel" });
  await expect(panel).toBeVisible();

  const adapterCard = panel
    .locator(`[data-debug-adapter-language="${scenario.adapterLanguage}"]`)
    .first();
  await adapterCard.scrollIntoViewIfNeeded();
  await expect(adapterCard).toContainText(scenario.adapter);
  for (const tag of scenario.tags) {
    await expect(adapterCard).toContainText(tag);
  }
  await attachVisual(testInfo, adapterCard, `${scenario.id}-adapter`);

  const breakpointRow = panel
    .locator(`[data-debug-breakpoint-line="${scenario.line}"]`)
    .filter({ hasText: `${shortPath(scenario.path)}:${scenario.line}` })
    .first();
  await breakpointRow.scrollIntoViewIfNeeded();
  await expect(breakpointRow).toBeVisible();
  if (scenario.id === "react-vite-typescript") {
    await breakpointRow
      .getByLabel("Breakpoint condition")
      .fill("title.length > 0");
    await breakpointRow
      .getByLabel("Breakpoint log message")
      .fill("rendered title");
    await breakpointRow.getByLabel("Disable breakpoint").click();
    await expect
      .poll(() =>
        page.evaluate(({ path, line }) => {
          return window.__POINTER_E2E__?.debug
            ?.breakpoints?.()
            ?.find((bp: any) => bp.path === path && bp.line === line);
        }, scenario),
      )
      .toMatchObject({
        enabled: false,
        condition: "title.length > 0",
        logMessage: "rendered title",
      });
    await breakpointRow.getByLabel("Enable breakpoint").click();
  }
  await attachVisual(testInfo, breakpointRow, `${scenario.id}-breakpoint`);

  const valueName = `${scenario.id}Value`;
  await panel.getByLabel("Debug value name").fill(valueName);
  await panel.getByLabel("Debug value type").fill(scenario.valueType);
  await panel.getByLabel("Debug value", { exact: true }).fill(scenario.value);
  await panel.getByRole("button", { name: "Capture debug value" }).click();

  const valueRow = panel.locator(`[data-debug-value-name="${valueName}"]`).first();
  await valueRow.scrollIntoViewIfNeeded();
  await expect(valueRow).toContainText(scenario.value);
  await expect(valueRow).toContainText(scenario.valueType);
  await attachVisual(testInfo, valueRow, `${scenario.id}-debug-value`);

  await valueRow.getByLabel("Send to Plan").click();
  await page.getByRole("tab", { name: "Debug" }).click();
  const breakpointRowAgain = panel
    .locator(`[data-debug-breakpoint-line="${scenario.line}"]`)
    .filter({ hasText: `${shortPath(scenario.path)}:${scenario.line}` })
    .first();
  await breakpointRowAgain.scrollIntoViewIfNeeded();
  await breakpointRowAgain.getByLabel("Send to Ask").click();
  await expect
    .poll(() => pendingRefs(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "breakpoint",
          path: scenario.path,
          line: scenario.line,
        }),
        expect.objectContaining({
          kind: "debugValue",
          name: valueName,
          value: scenario.value,
        }),
      ]),
    );
}

async function attachVisual(
  testInfo: TestInfo,
  locator: Locator,
  name: string,
) {
  const shot = await locator.screenshot({ animations: "disabled" });
  expect(shot.length).toBeGreaterThan(500);
  await testInfo.attach(name, { body: shot, contentType: "image/png" });
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).slice(-2).join("/");
}
