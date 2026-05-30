import type { Page, TestInfo } from "@playwright/test";
import { POINTER_THEME_IDS } from "../src/theme/themes";
import {
  ROOT,
  activeTab,
  deleteE2EPath,
  editorCursor,
  editorLanguage,
  editorMarkers,
  emitLspDiagnostics,
  expect,
  openE2EFile,
  test,
  writeE2EFile,
} from "./fixtures/pointerApp";

type CorpusCase = {
  label: string;
  path: string;
  language: string;
  content: string;
  hoverToken?: string;
};

const syntaxCorpus: CorpusCase[] = [
  c("React / TSX", "apps/react/App.tsx", "typescript", [
    "import React from 'react';",
    "export function PointerProbe() { return <main>{React.version}</main>; }",
  ]),
  c("Next route handler", "apps/next/route.ts", "typescript", [
    "export async function GET() {",
    "  const PointerProbe = Response.json({ ok: true });",
    "  return PointerProbe;",
    "}",
  ]),
  c("Angular component", "apps/angular/app.component.ts", "typescript", [
    "import { Component } from '@angular/core';",
    "@Component({ selector: 'pointer-probe', template: '<h1>{{ title }}</h1>' })",
    "export class PointerProbeComponent { title = 'PointerProbe'; }",
  ]),
  c("JavaScript / JSX", "apps/react/Widget.jsx", "javascript", [
    "export function PointerProbe() {",
    "  return <button onClick={() => console.log('PointerProbe')}>Run</button>;",
    "}",
  ]),
  c("CommonJS", "server/common.cjs", "javascript", [
    "const http = require('http');",
    "const PointerProbe = http.createServer((_req, res) => res.end('ok'));",
    "module.exports = PointerProbe;",
  ]),
  c("Vue single-file component", "apps/vue/PointerProbe.vue", "vue", [
    "<template><button @click=\"count++\">{{ count }}</button></template>",
    "<script setup lang=\"ts\">",
    "import { ref } from 'vue';",
    "const PointerProbe = ref(0);",
    "const count = PointerProbe;",
    "</script>",
  ]),
  c("Svelte component", "apps/svelte/PointerProbe.svelte", "svelte", [
    "<script lang=\"ts\">",
    "  export let PointerProbe = 'ready';",
    "</script>",
    "<p>{PointerProbe}</p>",
  ]),
  c("Astro page", "apps/astro/PointerProbe.astro", "astro", [
    "---",
    "const PointerProbe = 'astro';",
    "---",
    "<h1>{PointerProbe}</h1>",
  ]),
  c("HTML", "web/index.html", "html", [
    "<!doctype html>",
    "<main id=\"PointerProbe\" data-state=\"ready\"></main>",
  ]),
  c("XML", "config/PointerProbe.xml", "xml", [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<PointerProbe enabled=\"true\" />",
  ]),
  c("SVG", "assets/PointerProbe.svg", "xml", [
    "<svg viewBox=\"0 0 10 10\" xmlns=\"http://www.w3.org/2000/svg\">",
    "  <title>PointerProbe</title>",
    "</svg>",
  ]),
  c("Pug", "templates/PointerProbe.pug", "pug", [
    "main.PointerProbe",
    "  h1 PointerProbe",
  ]),
  c("Handlebars", "templates/PointerProbe.hbs", "handlebars", [
    "<section class=\"PointerProbe\">{{title}}</section>",
  ]),
  c("EJS", "templates/PointerProbe.ejs", "ejs", [
    "<section><%= PointerProbe %></section>",
  ]),
  c("Liquid", "templates/PointerProbe.liquid", "liquid", [
    "{% assign PointerProbe = 'ready' %}",
    "{{ PointerProbe }}",
  ]),
  c("Twig", "templates/PointerProbe.twig", "twig", [
    "{% set PointerProbe = 'ready' %}",
    "{{ PointerProbe }}",
  ]),
  c("Razor", "views/PointerProbe.cshtml", "razor", [
    "@{ var PointerProbe = \"ready\"; }",
    "<main>@PointerProbe</main>",
  ]),
  c("MDX", "docs/PointerProbe.mdx", "mdx", [
    "export const PointerProbe = () => <strong>ready</strong>;",
    "# <PointerProbe />",
  ]),
  c("Markdown", "docs/PointerProbe.md", "markdown", [
    "# PointerProbe",
    "",
    "```ts",
    "const ok = true;",
    "```",
  ]),
  c("CSS", "styles/PointerProbe.css", "css", [
    ".PointerProbe { display: grid; color: var(--accent); }",
  ]),
  c("SCSS", "styles/PointerProbe.scss", "scss", [
    "$accent: #ff2d8d;",
    ".PointerProbe { color: $accent; }",
  ]),
  c("Sass", "styles/PointerProbe.sass", "scss", [
    "$accent: #ff2d8d",
    ".PointerProbe",
    "  color: $accent",
  ]),
  c("Less", "styles/PointerProbe.less", "less", [
    "@accent: #ff2d8d;",
    ".PointerProbe { color: @accent; }",
  ]),
  c("Stylus", "styles/PointerProbe.styl", "stylus", [
    "accent = #ff2d8d",
    ".PointerProbe",
    "  color accent",
  ]),
  c("JSON", "data/PointerProbe.json", "json", [
    "{",
    "  \"PointerProbe\": true",
    "}",
  ]),
  c("JSONC", "data/PointerProbe.jsonc", "json", [
    "{",
    "  // PointerProbe",
    "  \"enabled\": true",
    "}",
  ]),
  c("YAML", "config/PointerProbe.yaml", "yaml", [
    "PointerProbe:",
    "  enabled: true",
  ]),
  c("TOML", "config/PointerProbe.toml", "toml", [
    "[PointerProbe]",
    "enabled = true",
  ]),
  c("INI", "config/PointerProbe.ini", "ini", [
    "[PointerProbe]",
    "enabled=true",
  ]),
  c("Python / FastAPI", "services/fastapi/PointerProbe.py", "python", [
    "from fastapi import FastAPI",
    "app = FastAPI()",
    "def PointerProbe() -> dict[str, bool]:",
    "    return {'ok': True}",
  ]),
  c("Ruby / Rails", "apps/rails/pointer_probe.rb", "ruby", [
    "class PointerProbe",
    "  def call = :ok",
    "end",
  ]),
  c("ERB", "apps/rails/PointerProbe.erb", "erb", [
    "<% PointerProbe = 'ready' %>",
    "<%= PointerProbe %>",
  ]),
  c("PHP / Laravel", "apps/laravel/PointerProbe.php", "php", [
    "<?php",
    "class PointerProbe { public function __invoke(): string { return 'ok'; } }",
  ]),
  c("Lua", "scripts/PointerProbe.lua", "lua", [
    "local PointerProbe = {}",
    "function PointerProbe.run() return true end",
  ]),
  c("Perl", "scripts/PointerProbe.pl", "perl", [
    "my $PointerProbe = 'ready';",
    "print $PointerProbe;",
  ]),
  c("Dart / Flutter", "apps/flutter/lib/PointerProbe.dart", "dart", [
    "import 'package:flutter/widgets.dart';",
    "class PointerProbe extends StatelessWidget {",
    "  const PointerProbe({super.key});",
    "  Widget build(BuildContext context) => const Text('ok');",
    "}",
  ]),
  c("Elixir / Phoenix", "apps/phoenix/pointer_probe.ex", "elixir", [
    "defmodule PointerProbe do",
    "  def call, do: :ok",
    "end",
  ]),
  c("Julia", "analysis/PointerProbe.jl", "julia", [
    "module PointerProbe",
    "run() = true",
    "end",
  ]),
  c("R", "analysis/PointerProbe.r", "r", [
    "PointerProbe <- function() {",
    "  TRUE",
    "}",
  ]),
  c("R Markdown", "analysis/PointerProbe.rmd", "r", [
    "---",
    "title: PointerProbe",
    "---",
    "```{r}",
    "PointerProbe <- TRUE",
    "```",
  ]),
  c("Racket", "languages/PointerProbe.rkt", "racket", [
    "#lang racket",
    "(define PointerProbe #t)",
  ]),
  c("Rust / Axum", "crates/api/src/PointerProbe.rs", "rust", [
    "pub async fn PointerProbe() -> &'static str {",
    "    \"ok\"",
    "}",
  ]),
  c("Go / Gin", "services/go/PointerProbe.go", "go", [
    "package main",
    "func PointerProbe() bool { return true }",
  ]),
  c("C", "systems/PointerProbe.c", "c", [
    "int PointerProbe(void) { return 1; }",
  ]),
  c("C++", "systems/PointerProbe.cpp", "cpp", [
    "#include <string>",
    "std::string PointerProbe() { return \"ok\"; }",
  ]),
  c("Zig", "systems/PointerProbe.zig", "zig", [
    "pub fn PointerProbe() bool {",
    "    return true;",
    "}",
  ]),
  c("Nix", "infra/PointerProbe.nix", "nix", [
    "{ pkgs ? import <nixpkgs> {} }:",
    "let PointerProbe = true; in PointerProbe",
  ]),
  c("Haskell", "languages/PointerProbe.hs", "haskell", [
    "module PointerProbe where",
    "pointerProbe :: Bool",
    "pointerProbe = True",
  ], "pointerProbe"),
  c("Erlang", "languages/pointer_probe.erl", "erlang", [
    "-module(pointer_probe).",
    "-export([PointerProbe/0]).",
    "PointerProbe() -> true.",
  ]),
  c("Elm", "apps/elm/PointerProbe.elm", "elm", [
    "module PointerProbe exposing (main)",
    "main = text \"ok\"",
  ]),
  c("OCaml", "languages/PointerProbe.ml", "ocaml", [
    "let PointerProbe = true",
  ]),
  c("Crystal", "languages/PointerProbe.cr", "crystal", [
    "class PointerProbe",
    "  def call; true; end",
    "end",
  ]),
  c("Nim", "languages/PointerProbe.nim", "nim", [
    "proc PointerProbe(): bool = true",
  ]),
  c("D", "languages/PointerProbe.d", "d", [
    "module PointerProbe;",
    "bool pointerProbe() { return true; }",
  ], "pointerProbe"),
  c("Java / Spring", "apps/spring/PointerProbe.java", "java", [
    "public class PointerProbe {",
    "  public boolean ok() { return true; }",
    "}",
  ]),
  c("Kotlin / Ktor", "apps/ktor/PointerProbe.kt", "kotlin", [
    "class PointerProbe {",
    "  fun ok(): Boolean = true",
    "}",
  ]),
  c("Scala", "apps/scala/PointerProbe.scala", "scala", [
    "object PointerProbe {",
    "  def ok: Boolean = true",
    "}",
  ]),
  c("Groovy / Gradle", "build/PointerProbe.gradle", "groovy", [
    "def PointerProbe = true",
    "tasks.register('probe') { doLast { println PointerProbe } }",
  ]),
  c("Clojure", "apps/clojure/pointer_probe.clj", "clojure", [
    "(ns pointer-probe)",
    "(def PointerProbe true)",
  ]),
  c("C# / ASP.NET", "apps/dotnet/PointerProbe.cs", "csharp", [
    "public class PointerProbe {",
    "  public bool Ok() => true;",
    "}",
  ]),
  c("F#", "apps/fsharp/PointerProbe.fs", "fsharp", [
    "module PointerProbe",
    "let ok = true",
  ]),
  c("Visual Basic", "apps/vb/PointerProbe.vb", "vb", [
    "Public Class PointerProbe",
    "End Class",
  ]),
  c("Swift / SwiftUI", "apps/swift/PointerProbe.swift", "swift", [
    "import SwiftUI",
    "struct PointerProbe: View { var body: some View { Text(\"ok\") } }",
  ]),
  c("Objective-C", "apps/objc/PointerProbe.m", "objective-c", [
    "#import <Foundation/Foundation.h>",
    "@interface PointerProbe : NSObject",
    "@end",
  ]),
  c("Shell", "scripts/PointerProbe.sh", "shell", [
    "#!/usr/bin/env bash",
    "PointerProbe=ready",
    "echo \"$PointerProbe\"",
  ]),
  c("PowerShell", "scripts/PointerProbe.ps1", "powershell", [
    "$PointerProbe = $true",
    "Write-Output $PointerProbe",
  ]),
  c("Batch", "scripts/PointerProbe.bat", "bat", [
    "@echo off",
    "set PointerProbe=ready",
    "echo %PointerProbe%",
  ]),
  c("Dockerfile", "containers/Dockerfile", "dockerfile", [
    "FROM node:22 AS PointerProbe",
    "RUN node --version",
  ]),
  c("Makefile", "build/Makefile", "makefile", [
    "PointerProbe:",
    "\t@echo ready",
  ]),
  c("SQL", "db/PointerProbe.sql", "sql", [
    "CREATE TABLE PointerProbe (id integer primary key);",
  ]),
  c("Bicep", "infra/PointerProbe.bicep", "bicep", [
    "resource PointerProbe 'Microsoft.Storage/storageAccounts@2023-01-01' = {",
    "  name: 'pointerprobe'",
    "  location: resourceGroup().location",
    "}",
  ]),
  c("GraphQL", "schema/PointerProbe.graphql", "graphql", [
    "type PointerProbe {",
    "  id: ID!",
    "}",
  ]),
  c("Protocol Buffers", "schema/PointerProbe.proto", "proto", [
    "syntax = \"proto3\";",
    "message PointerProbe { string id = 1; }",
  ]),
  c("Prisma", "schema/PointerProbe.prisma", "prisma", [
    "model PointerProbe {",
    "  id String @id",
    "}",
  ]),
  c("Solidity", "contracts/PointerProbe.sol", "solidity", [
    "pragma solidity ^0.8.0;",
    "contract PointerProbe { function ok() public pure returns (bool) { return true; } }",
  ]),
  c("WGSL", "graphics/PointerProbe.wgsl", "wgsl", [
    "@fragment",
    "fn PointerProbe() -> @location(0) vec4f { return vec4f(1.0); }",
  ]),
  c("LaTeX", "docs/PointerProbe.tex", "latex", [
    "\\documentclass{article}",
    "\\newcommand{\\PointerProbe}{ready}",
    "\\begin{document}\\PointerProbe\\end{document}",
  ]),
  c("Q#", "quantum/PointerProbe.qs", "qsharp", [
    "namespace PointerProbe {",
    "  operation Run() : Unit { }",
    "}",
  ]),
  c("TypeSpec", "api/PointerProbe.tsp", "typespec", [
    "model PointerProbe {",
    "  id: string;",
    "}",
  ]),
  c("SystemVerilog", "hardware/PointerProbe.sv", "system-verilog", [
    "module PointerProbe;",
    "endmodule",
  ]),
  c("Verilog", "hardware/PointerProbe.v", "verilog", [
    "module PointerProbe;",
    "endmodule",
  ]),
  c("Terraform / HCL", "infra/PointerProbe.tf", "hcl", [
    "resource \"null_resource\" \"PointerProbe\" {}",
  ]),
];

const installedFrameworkCases: CorpusCase[] = [
  c("React installed", "frameworks/react/Installed.tsx", "typescript", [
    "import React from 'react';",
    "export const PointerProbe = React.version;",
  ]),
  c("Next installed", "frameworks/next/Installed.ts", "typescript", [
    "import { NextResponse } from 'next/server';",
    "export const PointerProbe = NextResponse.json({ ok: true });",
  ]),
  c("Remix installed", "frameworks/remix/Installed.ts", "typescript", [
    "import { json } from '@remix-run/node';",
    "export const PointerProbe = json({ ok: true });",
  ]),
  c("Astro installed", "frameworks/astro/Installed.astro", "astro", [
    "---",
    "import { AstroError } from 'astro/errors';",
    "const PointerProbe = AstroError;",
    "---",
    "<p>{PointerProbe.name}</p>",
  ]),
  c("Vite installed", "frameworks/vite/Installed.ts", "typescript", [
    "import { defineConfig } from 'vite';",
    "export const PointerProbe = defineConfig({});",
  ]),
  c("Tailwind installed", "frameworks/tailwind/Installed.ts", "typescript", [
    "import plugin from 'tailwindcss/plugin';",
    "export const PointerProbe = plugin;",
  ]),
  c("Vue installed", "frameworks/vue/Installed.vue", "vue", [
    "<script setup lang=\"ts\">",
    "import { ref } from 'vue';",
    "const PointerProbe = ref(true);",
    "</script>",
  ]),
  c("Svelte installed", "frameworks/svelte/Installed.svelte", "svelte", [
    "<script>import { tick } from 'svelte'; const PointerProbe = tick;</script>",
  ]),
  c("Express installed", "frameworks/express/Installed.js", "javascript", [
    "import express from 'express';",
    "export const PointerProbe = express.Router();",
  ]),
  c("Fastify installed", "frameworks/fastify/Installed.js", "javascript", [
    "import fastify from 'fastify';",
    "export const PointerProbe = fastify();",
  ]),
  c("NestJS installed", "frameworks/nest/Installed.ts", "typescript", [
    "import { Controller } from '@nestjs/common';",
    "export const PointerProbe = Controller;",
  ]),
  c("React Native installed", "frameworks/react-native/Installed.tsx", "typescript", [
    "import { View } from 'react-native';",
    "export const PointerProbe = View;",
  ]),
  c("FastAPI installed", "frameworks/python/fastapi.py", "python", [
    "from fastapi import FastAPI",
    "PointerProbe = FastAPI()",
  ]),
  c("Django installed", "frameworks/python/django_app.py", "python", [
    "import django",
    "PointerProbe = django.get_version()",
  ]),
  c("Flask installed", "frameworks/python/flask_app.py", "python", [
    "import flask",
    "PointerProbe = flask.Flask(__name__)",
  ]),
  c("Pandas installed", "frameworks/python/pandas_app.py", "python", [
    "import pandas as pd",
    "PointerProbe = pd.DataFrame()",
  ]),
  c("NumPy installed", "frameworks/python/numpy_app.py", "python", [
    "import numpy as np",
    "PointerProbe = np.array([1])",
  ]),
  c("Axum installed", "frameworks/rust/axum.rs", "rust", [
    "use axum::Router;",
    "pub fn PointerProbe() -> Router { Router::new() }",
  ]),
  c("Tauri installed", "frameworks/rust/tauri.rs", "rust", [
    "use tauri::Builder;",
    "pub fn PointerProbe() { let _ = Builder::default(); }",
  ]),
  c("Tokio installed", "frameworks/rust/tokio.rs", "rust", [
    "use tokio::runtime::Runtime;",
    "pub fn PointerProbe() { let _ = Runtime::new(); }",
  ]),
  c("Gin installed", "frameworks/go/gin.go", "go", [
    "package main",
    "import \"github.com/gin-gonic/gin\"",
    "func PointerProbe() { _ = gin.New() }",
  ]),
  c("Echo installed", "frameworks/go/echo.go", "go", [
    "package main",
    "import \"github.com/labstack/echo/v4\"",
    "func PointerProbe() { _ = echo.New() }",
  ]),
  c("Fiber installed", "frameworks/go/fiber.go", "go", [
    "package main",
    "import \"github.com/gofiber/fiber/v2\"",
    "func PointerProbe() { _ = fiber.New() }",
  ]),
  c("Spring installed", "frameworks/java/SpringProbe.java", "java", [
    "import org.springframework.boot.SpringApplication;",
    "public class SpringProbe { Object PointerProbe = SpringApplication.class; }",
  ]),
  c("JUnit installed", "frameworks/java/JUnitProbe.java", "java", [
    "import org.junit.jupiter.api.Test;",
    "public class JUnitProbe { Object PointerProbe = Test.class; }",
  ]),
  c("Ktor installed", "frameworks/kotlin/KtorProbe.kt", "kotlin", [
    "import io.ktor.server.application.Application",
    "class PointerProbe(val app: Application)",
  ]),
  c("ASP.NET installed", "frameworks/dotnet/AspNetProbe.cs", "csharp", [
    "using Microsoft.AspNetCore.Builder;",
    "public class PointerProbe { WebApplication? App { get; set; } }",
  ]),
  c("Laravel installed", "frameworks/php/LaravelProbe.php", "php", [
    "<?php",
    "use Illuminate\\Support\\Collection;",
    "class PointerProbe extends Collection {}",
  ]),
  c("Symfony installed", "frameworks/php/SymfonyProbe.php", "php", [
    "<?php",
    "use Symfony\\Component\\HttpFoundation\\Response;",
    "class PointerProbe extends Response {}",
  ]),
  c("Rails installed", "frameworks/ruby/rails_probe.rb", "ruby", [
    "require \"rails\"",
    "PointerProbe = Rails.version",
  ]),
  c("RSpec installed", "frameworks/ruby/rspec_probe.rb", "ruby", [
    "require \"rspec\"",
    "PointerProbe = RSpec.configuration",
  ]),
  c("Flutter installed", "frameworks/dart/flutter_probe.dart", "dart", [
    "import 'package:flutter/widgets.dart';",
    "class PointerProbe extends StatelessWidget { const PointerProbe({super.key}); Widget build(context) => const Text('ok'); }",
  ]),
  c("Vapor installed", "frameworks/swift/VaporProbe.swift", "swift", [
    "import Vapor",
    "struct PointerProbe {}",
  ]),
];

type DependencyStateCase = {
  label: string;
  path: string;
  language: string;
  content: string;
  manifestPath: string;
  partialManifest: string;
  installedManifest: string;
  missing: string[];
  present: string[];
};

const dependencyStateCases: DependencyStateCase[] = [
  dep(
    "JavaScript and TypeScript frontend/backend packages",
    "dependencies/js/PackageProbe.tsx",
    "typescript",
    [
      "import React from 'react';",
      "import { NextResponse } from 'next/server';",
      "import { json } from '@remix-run/node';",
      "import { Component } from '@angular/core';",
      "import { QueryClient } from '@tanstack/react-query';",
      "import express from 'express';",
      "import fastify from 'fastify';",
      "import { Controller } from '@nestjs/common';",
      "import plugin from 'tailwindcss/plugin';",
      "export const PointerProbe = [React.version, NextResponse, json, Component, QueryClient, express, fastify, Controller, plugin];",
    ],
    "package.json",
    JSON.stringify({ dependencies: { react: "latest" } }, null, 2),
    JSON.stringify(
      {
        dependencies: {
          "@angular/core": "latest",
          "@nestjs/common": "latest",
          "@remix-run/node": "latest",
          "@tanstack/react-query": "latest",
          express: "latest",
          fastify: "latest",
          next: "latest",
          react: "latest",
          tailwindcss: "latest",
        },
      },
      null,
      2,
    ),
    ["next", "@remix-run/node", "@angular/core", "@tanstack/react-query", "express", "fastify", "@nestjs/common", "tailwindcss"],
    ["react"],
  ),
  dep(
    "Vue Svelte and Astro packages",
    "dependencies/meta/MetaProbe.vue",
    "vue",
    [
      "<script setup lang=\"ts\">",
      "import { ref } from 'vue';",
      "import { tick } from 'svelte';",
      "import { AstroError } from 'astro/errors';",
      "const PointerProbe = [ref(true), tick, AstroError];",
      "</script>",
      "<template><main>{{ PointerProbe.length }}</main></template>",
    ],
    "package.json",
    JSON.stringify({ dependencies: { vue: "latest" } }, null, 2),
    JSON.stringify(
      { dependencies: { astro: "latest", svelte: "latest", vue: "latest" } },
      null,
      2,
    ),
    ["svelte", "astro"],
    ["vue"],
  ),
  dep(
    "Python web and data packages",
    "dependencies/python/package_probe.py",
    "python",
    [
      "from fastapi import FastAPI",
      "import django",
      "import flask",
      "import pandas as pd",
      "import numpy as np",
      "import requests",
      "PointerProbe = [FastAPI, django, flask, pd, np, requests]",
    ],
    "pyproject.toml",
    ["[project]", 'dependencies = ["fastapi>=0.110"]'].join("\n"),
    [
      "[project]",
      'dependencies = ["fastapi>=0.110", "django>=5", "flask>=3", "pandas>=2", "numpy>=2", "requests>=2"]',
    ].join("\n"),
    ["django", "flask", "pandas", "numpy", "requests"],
    ["fastapi"],
  ),
  dep(
    "Rust crates and app frameworks",
    "dependencies/rust/src/package_probe.rs",
    "rust",
    [
      "use serde::Serialize;",
      "use axum::Router;",
      "use tauri::Builder;",
      "use tokio::runtime::Runtime;",
      "use anyhow::Result;",
      "#[derive(Serialize)]",
      "pub struct PointerProbe { ok: bool }",
      "pub fn run() -> Result<()> { let _ = (Router::new(), Builder::default(), Runtime::new()); Ok(()) }",
    ],
    "Cargo.toml",
    ["[package]", 'name = "pointer-deps"', 'version = "0.1.0"', "", "[dependencies]", 'serde = "1"'].join("\n"),
    [
      "[package]",
      'name = "pointer-deps"',
      'version = "0.1.0"',
      "",
      "[dependencies]",
      'anyhow = "1"',
      'axum = "0.7"',
      'serde = "1"',
      'tauri = "2"',
      'tokio = "1"',
    ].join("\n"),
    ["axum", "tauri", "tokio", "anyhow"],
    ["serde"],
  ),
  dep(
    "Go service frameworks",
    "dependencies/go/package_probe.go",
    "go",
    [
      "package main",
      "import (",
      "  \"github.com/gin-gonic/gin\"",
      "  \"github.com/labstack/echo/v4\"",
      "  \"github.com/gofiber/fiber/v2\"",
      ")",
      "func PointerProbe() { _, _, _ = gin.New(), echo.New(), fiber.New() }",
    ],
    "go.mod",
    ["module example.com/pointer-deps", "", "go 1.22", "", "require github.com/gin-gonic/gin v1.10.0"].join("\n"),
    [
      "module example.com/pointer-deps",
      "",
      "go 1.22",
      "",
      "require (",
      "  github.com/gofiber/fiber/v2 v2.52.0",
      "  github.com/gin-gonic/gin v1.10.0",
      "  github.com/labstack/echo/v4 v4.12.0",
      ")",
    ].join("\n"),
    ["github.com/labstack/echo/v4", "github.com/gofiber/fiber/v2"],
    ["github.com/gin-gonic/gin"],
  ),
  dep(
    "JVM frameworks and test packages",
    "dependencies/jvm/PackageProbe.java",
    "java",
    [
      "import org.springframework.boot.SpringApplication;",
      "import org.junit.jupiter.api.Test;",
      "import org.slf4j.Logger;",
      "import org.apache.commons.lang3.StringUtils;",
      "public class PackageProbe { Object PointerProbe = SpringApplication.class; }",
    ],
    "pom.xml",
    [
      "<project><dependencies>",
      "<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot</artifactId><version>3.3.0</version></dependency>",
      "</dependencies></project>",
    ].join("\n"),
    [
      "<project><dependencies>",
      "<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot</artifactId><version>3.3.0</version></dependency>",
      "<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-api</artifactId><version>5.10.0</version></dependency>",
      "<dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.14.0</version></dependency>",
      "<dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.0</version></dependency>",
      "</dependencies></project>",
    ].join("\n"),
    ["org.junit.jupiter", "org.slf4j", "org.apache.commons.lang3"],
    ["org.springframework.boot"],
  ),
  dep(
    ".NET packages",
    "dependencies/dotnet/PackageProbe.cs",
    "csharp",
    [
      "using Newtonsoft.Json;",
      "using Dapper;",
      "using Serilog;",
      "public class PointerProbe { }",
    ],
    "PackageProbe.csproj",
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '<ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>',
      "</Project>",
    ].join("\n"),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "<ItemGroup>",
      '<PackageReference Include="Dapper" Version="2.1.35" />',
      '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
      '<PackageReference Include="Serilog" Version="3.1.1" />',
      "</ItemGroup>",
      "</Project>",
    ].join("\n"),
    ["Dapper", "Serilog"],
    ["Newtonsoft"],
  ),
  dep(
    "PHP packages and frameworks",
    "dependencies/php/package_probe.php",
    "php",
    [
      "<?php",
      "use Monolog\\Logger;",
      "use GuzzleHttp\\Client;",
      "use Illuminate\\Support\\Collection;",
      "use Symfony\\Component\\HttpFoundation\\Response;",
      "class PointerProbe {}",
    ],
    "composer.json",
    JSON.stringify(
      {
        require: { "monolog/monolog": "^3.0" },
        autoload: { "psr-4": { "Monolog\\": "vendor/monolog/" } },
      },
      null,
      2,
    ),
    JSON.stringify(
      {
        require: {
          "guzzlehttp/guzzle": "^7.0",
          "laravel/framework": "^11.0",
          "monolog/monolog": "^3.0",
          "symfony/http-foundation": "^7.0",
        },
        autoload: {
          "psr-4": {
            "GuzzleHttp\\": "vendor/guzzlehttp/",
            "Illuminate\\": "vendor/laravel/framework/src/Illuminate/",
            "Monolog\\": "vendor/monolog/",
            "Symfony\\": "vendor/symfony/",
          },
        },
      },
      null,
      2,
    ),
    ["GuzzleHttp", "Illuminate", "Symfony"],
    ["Monolog"],
  ),
  dep(
    "Ruby packages and frameworks",
    "dependencies/ruby/package_probe.rb",
    "ruby",
    [
      "require \"faraday\"",
      "require \"rails\"",
      "require \"rspec\"",
      "require \"httparty\"",
      "PointerProbe = Faraday",
    ],
    "Gemfile",
    ['source "https://rubygems.org"', 'gem "faraday"'].join("\n"),
    ['source "https://rubygems.org"', 'gem "faraday"', 'gem "httparty"', 'gem "rails"', 'gem "rspec"'].join("\n"),
    ["rails", "rspec", "httparty"],
    ["faraday"],
  ),
  dep(
    "Dart and Flutter packages",
    "dependencies/dart/lib/package_probe.dart",
    "dart",
    [
      "import 'package:http/http.dart';",
      "import 'package:flutter/widgets.dart';",
      "import 'package:riverpod/riverpod.dart';",
      "final PointerProbe = [Client, Widget, ProviderContainer];",
    ],
    "pubspec.yaml",
    ["name: pointer_deps", "dependencies:", "  http: ^1.2.0"].join("\n"),
    ["name: pointer_deps", "dependencies:", "  flutter:", "    sdk: flutter", "  http: ^1.2.0", "  riverpod: ^2.5.0"].join("\n"),
    ["flutter", "riverpod"],
    ["http"],
  ),
  dep(
    "Swift packages",
    "dependencies/swift/PackageProbe.swift",
    "swift",
    [
      "import Alamofire",
      "import Vapor",
      "import ArgumentParser",
      "struct PointerProbe {}",
    ],
    "Package.swift",
    [
      "// swift-tools-version: 5.9",
      "import PackageDescription",
      "let package = Package(name: \"PointerDeps\", dependencies: [.package(name: \"Alamofire\", url: \"https://github.com/Alamofire/Alamofire.git\", from: \"5.8.0\")], targets: [.target(name: \"PointerDeps\", dependencies: [.product(name: \"Alamofire\", package: \"Alamofire\")])])",
    ].join("\n"),
    [
      "// swift-tools-version: 5.9",
      "import PackageDescription",
      "let package = Package(name: \"PointerDeps\", dependencies: [.package(name: \"Alamofire\", url: \"https://github.com/Alamofire/Alamofire.git\", from: \"5.8.0\"), .package(name: \"Vapor\", url: \"https://github.com/vapor/vapor.git\", from: \"4.0.0\"), .package(name: \"ArgumentParser\", url: \"https://github.com/apple/swift-argument-parser.git\", from: \"1.0.0\")], targets: [.target(name: \"PointerDeps\", dependencies: [.product(name: \"Alamofire\", package: \"Alamofire\"), .product(name: \"Vapor\", package: \"Vapor\"), .product(name: \"ArgumentParser\", package: \"ArgumentParser\")])])",
    ].join("\n"),
    ["Vapor", "ArgumentParser"],
    ["Alamofire"],
  ),
];

const navigationCases = [
  nav("TypeScript path alias", "navigation/ts/consumer.ts", "navigation/ts/shared.ts", "PointerAliasTarget", [
    "import { PointerAliasTarget } from '@app/shared';",
    "export const PointerProbe = PointerAliasTarget();",
  ], [
    "export function PointerAliasTarget() {",
    "  return 'ok';",
    "}",
  ], "typescript"),
  nav("Package declaration", "navigation/pkg/consumer.ts", "navigation/pkg/node_modules/@scope/tool/index.d.ts", "PointerPackageApi", [
    "import { PointerPackageApi } from '@scope/tool';",
    "export const PointerProbe = PointerPackageApi();",
  ], [
    "export declare function PointerPackageApi(): string;",
  ], "typescript"),
  nav("Python module", "navigation/python/consumer.py", "navigation/python/service.py", "PointerPythonService", [
    "from service import PointerPythonService",
    "PointerProbe = PointerPythonService()",
  ], [
    "class PointerPythonService:",
    "    pass",
  ], "python"),
  nav("Rust module", "navigation/rust/src/main.rs", "navigation/rust/src/service.rs", "PointerRustService", [
    "mod service;",
    "fn main() { let _ = service::PointerRustService; }",
  ], [
    "pub struct PointerRustService;",
  ], "rust"),
  nav("Go package", "navigation/go/main.go", "navigation/go/service.go", "PointerGoService", [
    "package main",
    "func main() { _ = PointerGoService() }",
  ], [
    "package main",
    "func PointerGoService() bool { return true }",
  ], "go"),
  nav("Java package", "navigation/java/App.java", "navigation/java/PointerJavaService.java", "PointerJavaService", [
    "package app;",
    "class App { Object probe = new PointerJavaService(); }",
  ], [
    "package app;",
    "public class PointerJavaService {}",
  ], "java"),
  nav("C# namespace", "navigation/dotnet/App.cs", "navigation/dotnet/PointerDotnetService.cs", "PointerDotnetService", [
    "namespace App;",
    "class App { object probe = new PointerDotnetService(); }",
  ], [
    "namespace App;",
    "public class PointerDotnetService {}",
  ], "csharp"),
  nav("PHP namespace", "navigation/php/App.php", "navigation/php/PointerPhpService.php", "PointerPhpService", [
    "<?php",
    "$probe = new PointerPhpService();",
  ], [
    "<?php",
    "class PointerPhpService {}",
  ], "php"),
  nav("Ruby require", "navigation/ruby/app.rb", "navigation/ruby/pointer_ruby_service.rb", "PointerRubyService", [
    "require './pointer_ruby_service'",
    "PointerProbe = PointerRubyService.new",
  ], [
    "class PointerRubyService",
    "end",
  ], "ruby"),
  nav("Swift module", "navigation/swift/App.swift", "navigation/swift/PointerSwiftService.swift", "PointerSwiftService", [
    "let PointerProbe = PointerSwiftService()",
  ], [
    "struct PointerSwiftService {}",
  ], "swift"),
];

const dependencyNavigationCases = [
  nav("React package symbol", "navigation/deps/react/App.tsx", "navigation/deps/react/node_modules/react/index.d.ts", "PointerReactDependency", [
    "import { PointerReactDependency } from 'react';",
    "export const PointerProbe = PointerReactDependency();",
  ], [
    "export declare function PointerReactDependency(): string;",
  ], "typescript"),
  nav("Next package symbol", "navigation/deps/next/route.ts", "navigation/deps/next/node_modules/next/server.d.ts", "PointerNextDependency", [
    "import { PointerNextDependency } from 'next/server';",
    "export const GET = () => PointerNextDependency();",
  ], [
    "export declare function PointerNextDependency(): Response;",
  ], "typescript"),
  nav("Vue package symbol", "navigation/deps/vue/App.vue", "navigation/deps/vue/node_modules/vue/index.d.ts", "PointerVueDependency", [
    "<script setup lang=\"ts\">",
    "import { PointerVueDependency } from 'vue';",
    "const PointerProbe = PointerVueDependency();",
    "</script>",
  ], [
    "export declare function PointerVueDependency(): unknown;",
  ], "vue"),
  nav("Python package symbol", "navigation/deps/python/app.py", "navigation/deps/python/site-packages/fastapi/__init__.py", "PointerFastApiDependency", [
    "from fastapi import PointerFastApiDependency",
    "PointerProbe = PointerFastApiDependency()",
  ], [
    "class PointerFastApiDependency:",
    "    pass",
  ], "python"),
  nav("Rust crate symbol", "navigation/deps/rust/src/main.rs", "navigation/deps/rust/cargo/registry/src/pointer_dep/lib.rs", "PointerRustDependency", [
    "use pointer_dep::PointerRustDependency;",
    "fn main() { let _ = PointerRustDependency; }",
  ], [
    "pub struct PointerRustDependency;",
  ], "rust"),
  nav("Go module symbol", "navigation/deps/go/main.go", "navigation/deps/go/pkg/mod/example.com/pointerdep/service.go", "PointerGoDependency", [
    "package main",
    "import pointerdep \"example.com/pointerdep\"",
    "func main() { _ = pointerdep.PointerGoDependency() }",
  ], [
    "package pointerdep",
    "func PointerGoDependency() bool { return true }",
  ], "go"),
  nav("Java package symbol", "navigation/deps/java/App.java", "navigation/deps/java/.m2/repository/org/pointer/dep/PointerJavaDependency.java", "PointerJavaDependency", [
    "package app;",
    "import org.pointer.dep.PointerJavaDependency;",
    "class App { Object probe = new PointerJavaDependency(); }",
  ], [
    "package org.pointer.dep;",
    "public class PointerJavaDependency {}",
  ], "java"),
  nav("Kotlin package symbol", "navigation/deps/kotlin/App.kt", "navigation/deps/kotlin/.gradle/caches/modules/PointerKotlinDependency.kt", "PointerKotlinDependency", [
    "import org.pointer.dep.PointerKotlinDependency",
    "val PointerProbe = PointerKotlinDependency()",
  ], [
    "class PointerKotlinDependency",
  ], "kotlin"),
  nav("C# package symbol", "navigation/deps/dotnet/App.cs", "navigation/deps/dotnet/.nuget/packages/pointerdep/PointerDotnetDependency.cs", "PointerDotnetDependency", [
    "using Pointer.Dep;",
    "var probe = new PointerDotnetDependency();",
  ], [
    "namespace Pointer.Dep;",
    "public class PointerDotnetDependency {}",
  ], "csharp"),
  nav("PHP package symbol", "navigation/deps/php/App.php", "navigation/deps/php/vendor/pointer/dep/PointerPhpDependency.php", "PointerPhpDependency", [
    "<?php",
    "use Pointer\\Dep\\PointerPhpDependency;",
    "$probe = new PointerPhpDependency();",
  ], [
    "<?php",
    "namespace Pointer\\Dep;",
    "class PointerPhpDependency {}",
  ], "php"),
  nav("Ruby gem symbol", "navigation/deps/ruby/app.rb", "navigation/deps/ruby/gems/pointer_dep/lib/pointer_dep.rb", "PointerRubyDependency", [
    "require 'pointer_dep'",
    "PointerProbe = PointerRubyDependency.new",
  ], [
    "class PointerRubyDependency",
    "end",
  ], "ruby"),
  nav("Dart package symbol", "navigation/deps/dart/lib/app.dart", "navigation/deps/dart/.pub-cache/hosted/pub.dev/pointer_dep/lib/pointer_dep.dart", "PointerDartDependency", [
    "import 'package:pointer_dep/pointer_dep.dart';",
    "final PointerProbe = PointerDartDependency();",
  ], [
    "class PointerDartDependency {}",
  ], "dart"),
  nav("Swift package symbol", "navigation/deps/swift/App.swift", "navigation/deps/swift/.build/checkouts/pointer-dep/Sources/PointerDep/PointerSwiftDependency.swift", "PointerSwiftDependency", [
    "import PointerDep",
    "let PointerProbe = PointerSwiftDependency()",
  ], [
    "public struct PointerSwiftDependency {}",
  ], "swift"),
];

const lintMatrix = [
  ["TypeScript ESLint", "typescript", "eslint"],
  ["React TSX TypeScript", "typescript", "typescript"],
  ["Python Ruff", "python", "ruff"],
  ["Python Pyright", "python", "pyright"],
  ["Rust clippy", "rust", "clippy"],
  ["Go gopls", "go", "gopls"],
  ["Java Checkstyle", "java", "checkstyle"],
  ["Kotlin ktlint", "kotlin", "ktlint"],
  ["C# Roslyn", "csharp", "roslyn"],
  ["PHP PHPStan", "php", "phpstan"],
  ["Ruby RuboCop", "ruby", "rubocop"],
  ["SwiftLint", "swift", "swiftlint"],
  ["CSS Stylelint", "css", "stylelint"],
  ["ShellCheck", "shell", "shellcheck"],
  ["Dockerfile Hadolint", "dockerfile", "hadolint"],
] as const;

test.describe("editor polyglot corpus", () => {
  test.setTimeout(180_000);

  test("opens every supported language and framework style with syntax tokens, LSP plumbing, and visual captures", async ({
    appPage: page,
  }, testInfo) => {
    for (const [index, item] of syntaxCorpus.entries()) {
      await writeE2EFile(page, item.path, item.content);
      await openE2EFile(page, item.path);
      await expect.poll(() => editorLanguage(page)).toBe(item.language);
      await expect
        .poll(
          () => tokenDiversity(page),
          { message: `${item.label} should render highlighted tokens` },
        )
        .toBeGreaterThan(1);
      await expectRenderedColorQuality(page, item.label, 2);
      const position = positionOf(item.content, item.hoverToken ?? "PointerProbe");
      const token = item.hoverToken ?? "PointerProbe";
      const hover = await page.evaluate(
        async ({ line, column }) =>
          window.__POINTER_E2E__?.editor?.hoverAt?.(line, column),
        position,
      );
      expect(JSON.stringify(hover), `${item.label} should answer hover`).toContain(token);
      await expect
        .poll(
          () => didHover(page, item.path),
          { message: `${item.label} should route hover through LSP IPC` },
        )
        .toBe(true);
      const symbols = await page.evaluate(
        () => window.__POINTER_E2E__?.editor?.documentSymbols?.() ?? [],
      );
      expect(
        JSON.stringify(symbols),
        `${item.label} should expose document symbols`,
      ).toContain(token);
      const completions = await page.evaluate(
        async ({ line, column }) =>
          window.__POINTER_E2E__?.editor?.completionItemsAt?.(line, column),
        position,
      );
      expect(
        JSON.stringify(completions),
        `${item.label} should expose completion items`,
      ).toContain(token);
      const references = await page.evaluate(
        async ({ line, column }) =>
          window.__POINTER_E2E__?.editor?.referencesAt?.(line, column),
        position,
      );
      expect(references.length, `${item.label} should expose references`).toBeGreaterThan(0);
      const highlights = await page.evaluate(
        async ({ line, column }) =>
          window.__POINTER_E2E__?.editor?.documentHighlightsAt?.(line, column),
        position,
      );
      expect(highlights.length, `${item.label} should expose document highlights`).toBeGreaterThan(0);
      const totalLines = item.content.split(/\r?\n/).length;
      const hints = await page.evaluate(
        async ({ totalLines }) =>
          window.__POINTER_E2E__?.editor?.inlayHintsAt?.(1, 1, totalLines, 200),
        { totalLines },
      );
      expect(hints.length, `${item.label} should expose inlay/type hints`).toBeGreaterThan(0);
      const renameEdits = await page.evaluate(
        async ({ line, column, token }) =>
          window.__POINTER_E2E__?.editor?.renameEditsAt?.(line, column, `${token}Renamed`),
        { ...position, token },
      );
      expect(renameEdits.length, `${item.label} should expose rename edits`).toBeGreaterThan(0);
      const visualHover = await page.evaluate(
        async ({ line, column }) =>
          window.__POINTER_E2E__?.editor?.showHoverAt?.(line, column),
        position,
      );
      expect(String(visualHover), `${item.label} should show a hover widget`).toContain(token);
      await captureEditorAudit(page, testInfo, `syntax-${index + 1}-${item.label}`);
      await page.keyboard.press("Escape");
    }
  });

  test("keeps declared major framework imports clean across ecosystems with visual captures", async ({
    appPage: page,
  }, testInfo) => {
    await seedFrameworkManifests(page);

    for (const [index, item] of installedFrameworkCases.entries()) {
      await writeE2EFile(page, item.path, item.content);
      await openE2EFile(page, item.path);
      await expect.poll(() => editorLanguage(page)).toBe(item.language);
      await expect
        .poll(async () => {
          const markers = await page.evaluate(
            () => window.__POINTER_E2E__?.editor?.markers?.() ?? [],
          );
          return JSON.stringify(
            markers.filter((marker: { source?: string }) => marker.source === "pointer-deps"),
          );
        })
        .toBe("[]");
      await captureEditorAudit(page, testInfo, `installed-framework-${index + 1}-${item.label}`);
    }
  });

  test("keeps syntax coloring differentiated across every Pointer theme", async ({
    appPage: page,
  }, testInfo) => {
    const stressPath = `${ROOT}/polyglot/theme-audit/PointerThemeProbe.tsx`;
    const stressContent = [
      "import React, { useMemo } from 'react';",
      "",
      "type Palette = { accent: string; count: number };",
      "const rows = [{ type: 'live', text: 'Ready', trailClass: 'ok', trail: 'now' }];",
      "function TrafficDots() { return <span data-kind=\"traffic\" />; }",
      "",
      "export function PointerThemeProbe({ accent, count }: Palette) {",
      "  const title = useMemo(() => `Pointer ${count + 1}`, [count]);",
      "  const enabled = Boolean(accent.match(/^#[0-9a-f]{6}$/i));",
      "  return (",
      "    <section data-accent={accent} aria-label={title}>",
      "      {/* Nested JSX should stay visibly differentiated */}",
      "      <TrafficDots />",
      "      {rows.map((row, index) => (",
      "        <div key={index} className={`probe-row probe-row-${row.type}`}>",
      "          {row.text}",
      "          {row.trail && <span className={row.trailClass}>{row.trail}</span>}",
      "        </div>",
      "      ))}",
      "      <span data-enabled={enabled}>{enabled ? title : 'off'}</span>",
      "    </section>",
      "  );",
      "}",
    ].join("\n");

    await writeE2EFile(page, stressPath, stressContent);
    await openE2EFile(page, stressPath);
    await page.evaluate(() => window.__POINTER_E2E__?.editor?.setInlayHints?.(false));
    const jsxLines = jsxAuditLines(stressContent);
    const logicLine = findLine(stressContent.split("\n"), "const title = useMemo");

    for (const themeId of POINTER_THEME_IDS) {
      await setPointerTheme(page, themeId);
      await expect.poll(() => editorLanguage(page)).toBe("typescript");
      await expectRenderedColorQuality(page, themeId, logicLine);
      await expectJsxLineColorQuality(page, themeId, jsxLines.section);
      await expectJsxLineColorQuality(page, themeId, jsxLines.templateAttribute);
      await expectJsxLineColorQuality(page, themeId, jsxLines.conditionalChild);
      await expectJsxExpressionColorQuality(page, themeId, jsxLines.expressionOnly);
      await captureEditorAudit(page, testInfo, `theme-syntax-color-${themeId}`);
    }
  });

  test("visually audits dependency installed and uninstalled transitions in a disposable workspace", async ({
    appPage: page,
  }, testInfo) => {
    await prepareDisposableDependencyWorkspace(page);

    for (const [index, item] of dependencyStateCases.entries()) {
      await writeE2EFile(page, item.path, item.content);
      await writeE2EFile(page, item.manifestPath, item.partialManifest);
      await openE2EFile(page, item.path);
      await expect.poll(() => editorLanguage(page)).toBe(item.language);
      await expectPointerDeps(page, item.missing, item.present);
      await expect(page.getByText(/Pointer · Ask: Dependency/).first()).toBeVisible();
      await captureEditorAudit(page, testInfo, `deps-${index + 1}-${item.label}-uninstalled`);

      await writeE2EFile(page, item.manifestPath, item.installedManifest);
      await reloadActiveFileForAudit(page, item.path);
      await expectNoPointerDeps(page, item.missing);
      await expect(page.getByText(/Pointer · Ask: Dependency/)).toHaveCount(0);
      await captureEditorAudit(page, testInfo, `deps-${index + 1}-${item.label}-installed`);
    }
  });

  test("command-clicks local imports and dependency symbols to declarations across language families", async ({
    appPage: page,
  }, testInfo) => {
    const cases = [...navigationCases, ...dependencyNavigationCases];
    for (const [index, item] of cases.entries()) {
      await writeE2EFile(page, item.usePath, item.useContent);
      await writeE2EFile(page, item.defPath, item.defContent);
      await openE2EFile(page, item.usePath);
      await expect.poll(() => editorLanguage(page)).toBe(item.language);
      const position = middlePositionOf(item.useContent, item.symbol);
      await commandClickEditorPosition(page, position.line, position.column);
      const defPosition = positionOf(item.defContent, item.symbol);
      await expect
        .poll(() => activeTab(page), {
          message: `${item.label} should navigate to ${item.defPath}`,
        })
        .toMatchObject({ path: item.defPath });
      await expect
        .poll(() => editorCursor(page), {
          message: `${item.label} should place the cursor at the declaration`,
        })
        .toMatchObject({ line: defPosition.line });
      await captureEditorAudit(page, testInfo, `command-click-${index + 1}-${item.label}`);
    }
  });

  test("surfaces lint diagnostics from local language and framework tooling sources", async ({
    appPage: page,
  }) => {
    for (const [label, language, source] of lintMatrix) {
      const item =
        syntaxCorpus.find((candidate) => candidate.language === language) ??
        syntaxCorpus[0];
      await writeE2EFile(page, item.path, item.content);
      await openE2EFile(page, item.path);
      const message = `${label} local rule violation`;
      await emitLspDiagnostics(page, item.path, [
        {
          message,
          source,
          code: `${source.toUpperCase()}_E2E`,
          severity: 1,
          range: {
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: Math.max(2, item.content.split(/\r?\n/)[0]?.length ?? 2),
          },
        },
      ]);
      await expect
        .poll(async () => JSON.stringify(await editorMarkers(page)), {
          message: `${label} should appear as an editor marker`,
        })
        .toContain(message);
      const markers = await editorMarkers(page);
      expect(JSON.stringify(markers), `${label} should preserve lint source`).toContain(source);
    }
  });
});

function c(
  label: string,
  relativePath: string,
  language: string,
  lines: string[],
  hoverToken?: string,
): CorpusCase {
  return {
    label,
    path: `${ROOT}/polyglot/${relativePath}`,
    language,
    content: lines.join("\n"),
    hoverToken,
  };
}

function nav(
  label: string,
  useRelativePath: string,
  defRelativePath: string,
  symbol: string,
  useLines: string[],
  defLines: string[],
  language: string,
) {
  return {
    label,
    usePath: `${ROOT}/polyglot/${useRelativePath}`,
    defPath: `${ROOT}/polyglot/${defRelativePath}`,
    symbol,
    useContent: useLines.join("\n"),
    defContent: defLines.join("\n"),
    language,
  };
}

function dep(
  label: string,
  relativePath: string,
  language: string,
  lines: string[],
  manifestName: string,
  partialManifest: string,
  installedManifest: string,
  missing: string[],
  present: string[],
): DependencyStateCase {
  const base = `${ROOT}/polyglot-visual/${relativePath.split("/").slice(0, -1).join("/")}`;
  return {
    label,
    path: `${ROOT}/polyglot-visual/${relativePath}`,
    language,
    content: lines.join("\n"),
    manifestPath: `${base}/${manifestName}`,
    partialManifest,
    installedManifest,
    missing,
    present,
  };
}

async function captureEditorAudit(page: Page, testInfo: TestInfo, name: string) {
  await page.locator(".monaco-editor").first().waitFor({ state: "visible" });
  const shotPath = testInfo.outputPath(`editor-visual-${slug(name)}.png`);
  const shot = await page.locator("body").screenshot({
    path: shotPath,
    animations: "disabled",
  });
  expect(shot.length, `${name} visual audit screenshot should not be blank`).toBeGreaterThan(1_000);
  await testInfo.attach(`editor-visual-${name}`, {
    path: shotPath,
    contentType: "image/png",
  });
}

async function prepareDisposableDependencyWorkspace(page: Page) {
  await writeE2EFile(
    page,
    `${ROOT}/package.json`,
    JSON.stringify({ name: "pointer-e2e-disposable", dependencies: {} }, null, 2),
  );
  const disposableRoots = [
    `${ROOT}/polyglot-visual/dependencies/js/package.json`,
    `${ROOT}/polyglot-visual/dependencies/meta/package.json`,
    `${ROOT}/polyglot-visual/dependencies/python/pyproject.toml`,
    `${ROOT}/polyglot-visual/dependencies/rust/Cargo.toml`,
    `${ROOT}/polyglot-visual/dependencies/go/go.mod`,
    `${ROOT}/polyglot-visual/dependencies/jvm/pom.xml`,
    `${ROOT}/polyglot-visual/dependencies/dotnet/PackageProbe.csproj`,
    `${ROOT}/polyglot-visual/dependencies/php/composer.json`,
    `${ROOT}/polyglot-visual/dependencies/ruby/Gemfile`,
    `${ROOT}/polyglot-visual/dependencies/dart/pubspec.yaml`,
    `${ROOT}/polyglot-visual/dependencies/swift/Package.swift`,
  ];
  for (const path of disposableRoots) {
    await deleteE2EPath(page, path);
  }
}

async function reloadActiveFileForAudit(page: Page, path: string) {
  const selectedTab = page.getByRole("tab", { selected: true });
  await selectedTab.getByRole("button", { name: /^Close / }).click();
  await openE2EFile(page, path);
}

async function expectPointerDeps(
  page: Page,
  missing: string[],
  present: string[],
) {
  await expect
    .poll(async () => {
      const text = await pointerDependencyText(page);
      return missing.every((name) => text.includes(name)) &&
        present.every((name) => !text.includes(`Dependency "${name}"`));
    }, { timeout: 20_000 })
    .toBe(true);
}

async function expectNoPointerDeps(page: Page, names: string[]) {
  await expect
    .poll(async () => {
      const text = await pointerDependencyText(page);
      return names.every((name) => !text.includes(name));
    }, { timeout: 20_000 })
    .toBe(true);
}

async function pointerDependencyText(page: Page) {
  const markers = await editorMarkers(page);
  return markers
    .filter((marker: { source?: string }) => marker.source === "pointer-deps")
    .map((marker: { message?: string }) => marker.message ?? "")
    .join("\n");
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

async function tokenDiversity(page: { evaluate: Function }) {
  return page.evaluate(() => {
    const classes = window.__POINTER_E2E__?.editor?.visibleTokenClasses?.() ?? [];
    return new Set(classes.map((item: string) => item.trim()).filter(Boolean)).size;
  });
}

async function setPointerTheme(page: Page, themeId: string) {
  await page.evaluate((id) => {
    window.__POINTER_E2E__?.theme?.setTheme?.(id);
  }, themeId);
  await page.waitForFunction(
    (id) => document.documentElement.dataset.pointerTheme === id,
    themeId,
  );
}

async function expectRenderedColorQuality(page: Page, label: string, minDistinctColors: number) {
  await expect
    .poll(
      async () => {
        const quality = await renderedTokenColorQuality(page);
        return quality.distinctColors >= minDistinctColors &&
          quality.nonDefaultColors >= Math.max(1, minDistinctColors - 1) &&
          quality.visibleTokenCount >= 2;
      },
      { message: `${label} should render enough visually distinct syntax colors` },
    )
    .toBe(true);
}

async function renderedTokenColorQuality(page: Page) {
  return page.evaluate(() => {
    const styles = window.__POINTER_E2E__?.editor?.visibleTokenStyles?.() ?? [];
    const visible = styles.filter(
      (item) =>
        item.text.trim().length > 0 &&
        !item.text.includes(": inferred") &&
        !item.className.toLowerCase().includes("inlay"),
    );
    const colors = visible.map((item) => canonicalColor(item.color)).filter(Boolean);
    const defaultColor = canonicalColor(
      getComputedStyle(document.documentElement).getPropertyValue("--pn-code-fg"),
    );
    return {
      visibleTokenCount: visible.length,
      distinctColors: new Set(colors).size,
      nonDefaultColors: new Set(colors.filter((color) => color !== defaultColor)).size,
    };

    function canonicalColor(value: string): string {
      const raw = value.trim().toLowerCase();
      const rgb = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (rgb) {
        return [rgb[1], rgb[2], rgb[3]]
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("");
      }
      return raw.replace(/^#/, "").slice(0, 6);
    }
  });
}

async function expectJsxLineColorQuality(page: Page, label: string, line: number) {
  await expect
    .poll(
      async () => {
        const quality = await renderedLineColorQuality(page, line);
        return quality.visibleTokenCount >= 8 &&
          quality.distinctColors >= 4 &&
          quality.nonDefaultColors >= 4 &&
          quality.defaultTokenRatio <= 0.48;
      },
      { message: `${label} JSX line should not render mostly default foreground` },
    )
    .toBe(true);
}

async function expectJsxExpressionColorQuality(page: Page, label: string, line: number) {
  await expect
    .poll(
      async () => {
        const quality = await renderedLineColorQuality(page, line);
        return quality.visibleTokenCount >= 5 &&
          quality.distinctColors >= 2 &&
          quality.nonDefaultColors >= 2 &&
          quality.defaultTokenRatio <= 0.25;
      },
      { message: `${label} JSX expression line should not collapse to default foreground` },
    )
    .toBe(true);
}

function jsxAuditLines(content: string) {
  const lines = content.split("\n");
  return {
    section: findLine(lines, "<section data-accent"),
    templateAttribute: findLine(lines, "className={`probe-row"),
    expressionOnly: findLine(lines, "{row.text}"),
    conditionalChild: findLine(lines, "row.trail && <span"),
  };
}

function findLine(lines: string[], needle: string): number {
  const index = lines.findIndex((line) => line.includes(needle));
  expect(index, `missing JSX audit line for ${needle}`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

async function renderedLineColorQuality(page: Page, line: number) {
  return page.evaluate((line) => {
    const styles = window.__POINTER_E2E__?.editor?.tokenStylesForLine?.(line) ?? [];
    const visible = styles.filter((item) => item.text.trim().length > 0);
    const colors = visible.map((item) => canonicalColor(item.color)).filter(Boolean);
    const defaultColor = canonicalColor(
      getComputedStyle(document.documentElement).getPropertyValue("--pn-code-fg"),
    );
    const defaultTokenCount = colors.filter((color) => color === defaultColor).length;
    return {
      visibleTokenCount: visible.length,
      distinctColors: new Set(colors).size,
      nonDefaultColors: new Set(colors.filter((color) => color !== defaultColor)).size,
      defaultTokenRatio: colors.length === 0 ? 1 : defaultTokenCount / colors.length,
      text: visible.map((item) => item.text).join(""),
    };

    function canonicalColor(value: string): string {
      const raw = value.trim().toLowerCase();
      const rgb = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (rgb) {
        return [rgb[1], rgb[2], rgb[3]]
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("");
      }
      return raw.replace(/^#/, "").slice(0, 6);
    }
  }, line);
}

async function didHover(page: { evaluate: Function }, path: string) {
  return page.evaluate(
    (targetPath: string) =>
      window.__POINTER_E2E__?.commandLog?.some(
        (entry) =>
          entry.command === "lsp_hover" &&
          (entry.args as { req?: { path?: string } })?.req?.path === targetPath,
      ) ?? false,
    path,
  );
}

function positionOf(content: string, token: string): { line: number; column: number } {
  const index = content.indexOf(token);
  if (index < 0) return { line: 1, column: 1 };
  const before = content.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line, column: index - lineStart + 1 };
}

function middlePositionOf(content: string, token: string): { line: number; column: number } {
  const start = positionOf(content, token);
  return {
    line: start.line,
    column: start.column + Math.max(0, Math.floor(token.length / 2)),
  };
}

async function commandClickEditorPosition(page: Page, line: number, column: number) {
  const point = await page.evaluate(
    async ({ line, column }) =>
      window.__POINTER_E2E__?.editor?.clientPointForPosition?.(line, column),
    { line, column },
  );
  expect(point, `editor position ${line}:${column} should have a visible click point`).toBeTruthy();
  await page.keyboard.down("Meta");
  await page.mouse.click(point!.x, point!.y);
  await page.keyboard.up("Meta");
}

async function seedFrameworkManifests(page: { evaluate: Function }) {
  const files: Array<[string, string]> = [
    [
      `${ROOT}/polyglot/frameworks/package.json`,
      JSON.stringify(
        {
          dependencies: {
            "@angular/core": "latest",
            "@nestjs/common": "latest",
            "@remix-run/node": "latest",
            astro: "latest",
            express: "latest",
            fastify: "latest",
            next: "latest",
            react: "latest",
            "react-native": "latest",
            svelte: "latest",
            tailwindcss: "latest",
            vite: "latest",
            vue: "latest",
          },
        },
        null,
        2,
      ),
    ],
    [
      `${ROOT}/polyglot/frameworks/python/pyproject.toml`,
      [
        "[project]",
        'dependencies = ["fastapi>=0.110", "django>=5", "flask>=3", "pandas>=2", "numpy>=2"]',
      ].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/rust/Cargo.toml`,
      [
        "[package]",
        'name = "pointer-frameworks"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[dependencies]",
        'axum = "0.7"',
        'tauri = "2"',
        'tokio = "1"',
      ].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/go/go.mod`,
      [
        "module example.com/pointer-frameworks",
        "",
        "go 1.22",
        "",
        "require (",
        "  github.com/gofiber/fiber/v2 v2.52.0",
        "  github.com/gin-gonic/gin v1.10.0",
        "  github.com/labstack/echo/v4 v4.12.0",
        ")",
      ].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/java/pom.xml`,
      [
        "<project>",
        "  <dependencies>",
        "    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot</artifactId><version>3.3.0</version></dependency>",
        "    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-api</artifactId><version>5.10.0</version></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/kotlin/build.gradle.kts`,
      'dependencies { implementation("io.ktor:ktor-server-core:2.3.0") }',
    ],
    [
      `${ROOT}/polyglot/frameworks/dotnet/PointerFrameworks.csproj`,
      [
        '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "  <ItemGroup>",
        '    <PackageReference Include="Microsoft.AspNetCore.App" Version="8.0.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/php/composer.json`,
      JSON.stringify(
        {
          require: {
            "laravel/framework": "^11.0",
            "symfony/http-foundation": "^7.0",
          },
          autoload: {
            "psr-4": {
              "Illuminate\\": "vendor/laravel/framework/src/Illuminate/",
              "Symfony\\": "vendor/symfony/",
            },
          },
        },
        null,
        2,
      ),
    ],
    [
      `${ROOT}/polyglot/frameworks/ruby/Gemfile`,
      ['source "https://rubygems.org"', 'gem "rails"', 'gem "rspec"'].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/dart/pubspec.yaml`,
      ["name: pointer_frameworks", "dependencies:", "  flutter:", "    sdk: flutter"].join("\n"),
    ],
    [
      `${ROOT}/polyglot/frameworks/swift/Package.swift`,
      [
        "// swift-tools-version: 5.9",
        "import PackageDescription",
        "let package = Package(",
        '  name: "PointerFrameworks",',
        '  dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")],',
        '  targets: [.target(name: "PointerFrameworks", dependencies: [.product(name: "Vapor", package: "vapor")])]',
        ")",
      ].join("\n"),
    ],
  ];

  for (const [path, content] of files) {
    await writeE2EFile(page as any, path, content);
  }
}
