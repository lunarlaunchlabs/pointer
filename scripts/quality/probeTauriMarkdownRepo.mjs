#!/usr/bin/env node
// Real Tauri Markdown repo probe for Pointer's Ask, Plan, and Agent flows.
//
// This uses /Users/sameer/tauri-markdown as a Vue/Tauri/Markdown domain
// contrast to the Express probe. It copies the repo to a temp directory,
// injects realistic regressions, and then drives the live local model through
// Ask, Plan, and Agent modes against the temp copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chat, MODEL, bar } from "./lib.mjs";
import {
  applyDiffBody,
  blockingCommandRefusal,
  driveAgent,
  extractDefinitions,
  globToRegExp,
  pathMatchesGlob,
} from "./evalAgent.mjs";

const SOURCE_REPO = process.env.TAURI_MARKDOWN_REPO || "/Users/sameer/tauri-markdown";
const TARGETED_I18N_TEST = "npm run test:run -- src/utils/__tests__/i18n-helper.test.js";
const TARGETED_DRAG_TEST = "npm run test:run -- src/composables/__tests__/useDragDrop.overlay-regression.test.js";

const PLAN_FORBIDDEN = new Set([
  "edit_file",
  "rename_symbol",
  "write_file",
  "apply_diff",
  "delete_path",
  "rename_path",
  "task",
  "run_shell",
  "run_check",
  "mcp_call",
]);

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".vite",
  ".cache",
  "coverage",
]);

const TEXT_EXTS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".vue",
  ".yaml",
  ".yml",
]);

const TEXT_NAMES = new Set(["LICENSE", "README", "README.md", "package.json"]);

function askSystem(brief) {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

You are in ASK mode - answer questions and explain code. Do NOT emit edit blocks, tool tags, shell commands, or triple-backtick code fences.

ASK MODE OUTPUT CONTRACT:
- Prose only. The literal string \`\`\` is forbidden.
- Inline code spans are OK; multi-line code examples are not.
- If the context includes a <file> block for a named file, answer from that file. Do not claim you lack access to it.
- For "tell me about <file>" style questions, answer with the file's purpose, important imports/exports, state or data flow, and notable risks or neighboring files worth checking.
- For framework integration files, name concrete lifecycle hooks, external APIs, cleanup paths, and user-visible failure modes visible in the file.

Workspace brief:
${brief}`;
}

function workspaceBrief(root) {
  return [
    `- root: ${root}`,
    "- project: Tauri Markdown, a Vue 3 + Vite + Tauri desktop Markdown editor",
    "- key source files: src/App.vue, src/components/MyVditor.vue, src/composables/useDragDrop.js, src/utils/i18n-helper.js",
    "- tests: Vitest under src/**/__tests__",
    `- targeted verification commands for this probe: ${TARGETED_I18N_TEST}; ${TARGETED_DRAG_TEST}`,
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertMatches(label, response, required, rejected = []) {
  const failures = [];
  for (const re of required) {
    if (!re.test(response)) failures.push(`missing ${re}`);
  }
  for (const re of rejected) {
    if (re.test(response)) failures.push(`rejected phrase ${re}`);
  }
  if (failures.length) {
    throw new Error(`${label}: ${failures.join("; ")}\n\nResponse:\n${response}`);
  }
}

function command(root, cmd, { timeoutMs = 600000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, {
    cwd: root,
    shell: true,
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer,
  });
  return {
    code: r.status ?? -1,
    signal: r.signal ?? null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ?? null,
  };
}

function compact(s, max = 2200) {
  const text = String(s ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (${text.length - max} chars truncated)`;
}

function sourceStatus() {
  const r = command(SOURCE_REPO, "git status --short", { timeoutMs: 30000 });
  return r.code === 0 ? r.stdout.trim() : "(git status unavailable)";
}

function copyRepoToTemp() {
  assert(fs.existsSync(SOURCE_REPO), `Tauri Markdown repo not found: ${SOURCE_REPO}`);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-tauri-markdown-"));
  const dest = path.join(parent, "tauri-markdown");
  fs.cpSync(SOURCE_REPO, dest, {
    recursive: true,
    filter(src) {
      const rel = path.relative(SOURCE_REPO, src);
      if (!rel) return true;
      return !rel.split(path.sep).some((part) => IGNORED_DIRS.has(part));
    },
  });
  return dest;
}

function installDeps(root) {
  const cmd = fs.existsSync(path.join(root, "package-lock.json"))
    ? "npm ci --ignore-scripts --no-audit --fund=false"
    : "npm install --ignore-scripts --no-audit --fund=false";
  const r = command(root, cmd, { timeoutMs: 600000 });
  if (r.code !== 0) {
    throw new Error(`dependency install failed: ${cmd}\n${compact(r.stdout)}\n${compact(r.stderr)}`);
  }
  return cmd;
}

function introduceI18nRegression(root) {
  const file = path.join(root, "src/utils/i18n-helper.js");
  const original = fs.readFileSync(file, "utf-8");
  const good = `  if (fallbackLang && fallbackLang !== lang) {`;
  const bad = `  if (false && fallbackLang && fallbackLang !== lang) {`;
  assert(original.includes(good), "Could not find the expected getI18nText fallback branch");
  fs.writeFileSync(file, original.replace(good, bad));
}

function addDragOverlayRegressionTest(root) {
  const file = path.join(root, "src/composables/__tests__/useDragDrop.overlay-regression.test.js");
  const body = `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useDragDrop } from '../useDragDrop.js'

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn()
}))

vi.mock('element-plus', () => ({
  ElNotification: vi.fn()
}))

vi.mock('../../utils/i18n-helper.js', () => ({
  getI18nText: vi.fn((lang, key) => \`\${lang}:\${key}\`)
}))

import { getCurrentWebview } from '@tauri-apps/api/webview'
import { ElNotification } from 'element-plus'

describe('useDragDrop overlay state', () => {
  let mockWebview
  let onFileDrop
  let langRef

  beforeEach(() => {
    vi.clearAllMocks()
    mockWebview = {
      onDragDropEvent: vi.fn().mockResolvedValue(vi.fn())
    }
    getCurrentWebview.mockResolvedValue(mockWebview)
    onFileDrop = vi.fn()
    langRef = ref('en_US')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function createManager() {
    const manager = useDragDrop(onFileDrop, langRef)
    await manager.setupDragDrop()
    const callback = mockWebview.onDragDropEvent.mock.calls[0][0]
    return {
      manager,
      emit(type, paths = []) {
        callback({ payload: { type, paths } })
      }
    }
  }

  it('hides the overlay after a valid markdown drop', async () => {
    const drag = await createManager()

    drag.emit('over')
    expect(drag.manager.showDropOverlay.value).toBe(true)

    drag.emit('drop', ['/tmp/readme.md'])

    expect(onFileDrop).toHaveBeenCalledWith('/tmp/readme.md')
    expect(drag.manager.showDropOverlay.value).toBe(false)
  })

  it('hides the overlay after an unsupported drop', async () => {
    const drag = await createManager()

    drag.emit('over')
    expect(drag.manager.showDropOverlay.value).toBe(true)

    drag.emit('drop', ['/tmp/screenshot.png'])

    expect(onFileDrop).not.toHaveBeenCalled()
    expect(ElNotification).toHaveBeenCalled()
    expect(drag.manager.showDropOverlay.value).toBe(false)
  })

  it('hides the overlay when a drag leaves or is cancelled', async () => {
    const drag = await createManager()

    drag.emit('over')
    expect(drag.manager.showDropOverlay.value).toBe(true)
    drag.emit('leave')
    expect(drag.manager.showDropOverlay.value).toBe(false)

    drag.emit('over')
    expect(drag.manager.showDropOverlay.value).toBe(true)
    drag.emit('cancel')
    expect(drag.manager.showDropOverlay.value).toBe(false)
  })
})
`;
  fs.writeFileSync(file, body);
}

function introduceDragOverlayRegression(root) {
  const file = path.join(root, "src/composables/useDragDrop.js");
  const original = fs.readFileSync(file, "utf-8");
  const good = `        if (type === 'drop') {
          // 文件已拖放 - 隐藏遮罩
          showDropOverlay.value = false`;
  const bad = `        if (type === 'drop') {
          // BUG: overlay remains visible after drop events.
          showDropOverlay.value = true`;
  assert(original.includes(good), "Could not find the expected drop overlay reset branch");
  fs.writeFileSync(file, original.replace(good, bad));
}

function isTextPath(p) {
  const name = path.basename(p);
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTS.has(ext) || TEXT_NAMES.has(name);
}

function extractKeywords(query) {
  const stop = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "of",
    "to",
    "for",
    "in",
    "on",
    "and",
    "or",
    "with",
    "by",
    "from",
    "this",
    "that",
    "where",
    "what",
    "which",
    "how",
    "does",
    "about",
    "into",
    "code",
    "file",
    "files",
    "function",
    "class",
    "use",
    "uses",
    "using",
    "find",
    "fix",
    "regression",
  ]);
  return [
    ...new Set(
      String(query)
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 2 && !stop.has(t)),
    ),
  ].slice(0, 8);
}

class DiskRepo {
  constructor(root) {
    this.root = root;
  }

  rel(p = ".") {
    const input = String(p || ".").replaceAll("\\", "/");
    const full = path.isAbsolute(input)
      ? path.normalize(input)
      : path.normalize(path.join(this.root, input));
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }

  abs(p = ".") {
    const rel = this.rel(p);
    return rel === "." ? this.root : path.join(this.root, rel);
  }

  has(p) {
    return fs.existsSync(this.abs(p));
  }

  read(p) {
    const full = this.abs(p);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`${this.rel(p)} is not a file`);
    if (st.size > 768 * 1024) throw new Error(`${this.rel(p)} is too large to read`);
    return fs.readFileSync(full, "utf-8");
  }

  write(p, content) {
    const full = this.abs(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  delete(p) {
    fs.rmSync(this.abs(p), { recursive: true, force: true });
  }

  rename(from, to) {
    const src = this.abs(from);
    const dest = this.abs(to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }

  list(dir = ".") {
    const full = this.abs(dir);
    if (!fs.existsSync(full)) throw new Error(`no such directory: ${this.rel(dir)}`);
    if (!fs.statSync(full).isDirectory()) throw new Error(`${this.rel(dir)} is not a directory`);
    return fs
      .readdirSync(full, { withFileTypes: true })
      .filter((ent) => !IGNORED_DIRS.has(ent.name))
      .map((ent) => (ent.isDirectory() ? `${ent.name}/` : ent.name))
      .sort((a, b) => a.localeCompare(b));
  }

  files() {
    const out = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = path.relative(this.root, full).split(path.sep).join("/");
        if (!isTextPath(rel)) continue;
        const st = fs.statSync(full);
        if (st.size > 512 * 1024) continue;
        out.push(rel);
      }
    };
    walk(this.root);
    return out.sort((a, b) => a.localeCompare(b));
  }
}

function numberedFile(raw, offsetAttr, limitAttr) {
  const offset = Math.max(0, Number(offsetAttr ?? 0) || 0);
  const limit = Math.max(1, Number(limitAttr ?? Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER);
  const lines = raw.split("\n");
  const from = Math.min(offset, lines.length);
  const to = Math.min(from + limit, lines.length);
  let text = lines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(5)}|${line}`)
    .join("\n");
  if (to < lines.length) text += `\n... (${lines.length - to} more lines truncated)`;
  return text;
}

function searchFiles(repo, query, { glob = null, maxHits = 80 } = {}) {
  const needle = String(query ?? "");
  let test;
  try {
    const re = new RegExp(needle, "m");
    test = (line) => re.test(line);
  } catch {
    test = (line) => line.includes(needle);
  }

  const hits = [];
  for (const file of repo.files()) {
    if (glob && !pathMatchesGlob(file, glob)) continue;
    const lines = repo.read(file).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!test(lines[i])) continue;
      hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
      if (hits.length >= maxHits) return hits;
    }
  }
  return hits;
}

async function diskToolRunner(repo, call, mode) {
  const { tool, attrs, body } = call;
  if (mode === "plan" && PLAN_FORBIDDEN.has(tool)) {
    return {
      status: "rejected",
      text: `Plan mode: ${tool} is not allowed (read-only tools + <plan>/<final> only).`,
    };
  }

  try {
    if (tool === "read_file") {
      const p = attrs.path;
      if (!p) return { status: "error", text: "missing path attribute" };
      return { status: "ok", text: numberedFile(repo.read(p), attrs.offset, attrs.limit) };
    }

    if (tool === "list_dir") {
      return { status: "ok", text: repo.list(attrs.path ?? ".").join("\n") || "(empty)" };
    }

    if (tool === "glob") {
      const pattern = body.trim();
      const re = globToRegExp(pattern);
      const matches = repo.files().filter((file) => re.test(file));
      return { status: "ok", text: matches.join("\n") || "(no matches)" };
    }

    if (tool === "grep") {
      const hits = searchFiles(repo, body, { glob: attrs.glob ?? null });
      return { status: "ok", text: hits.join("\n") || "(no matches)" };
    }

    if (tool === "search_codebase") {
      const terms = extractKeywords(body);
      if (terms.length === 0) return { status: "ok", text: "(no usable search terms)" };
      const hits = [];
      for (const file of repo.files()) {
        const lower = repo.read(file).toLowerCase();
        if (terms.some((term) => lower.includes(term))) hits.push(file);
        if (hits.length >= 80) break;
      }
      return {
        status: "ok",
        text: hits.length
          ? `# keyword fallback (no embedder)\nterms: ${terms.join(", ")}\n${hits.join("\n")}`
          : "(no matches)",
      };
    }

    if (tool === "list_code_definition_names") {
      const target = repo.rel(attrs.path ?? body.trim() ?? ".");
      const prefix = target === "." ? "" : target.endsWith("/") ? target : `${target}/`;
      const lines = [];
      let filesScanned = 0;
      let totalDefs = 0;
      for (const file of repo.files()) {
        if (prefix && !file.startsWith(prefix)) continue;
        const ext = path.extname(file).slice(1).toLowerCase();
        const defs = extractDefinitions(repo.read(file), ext);
        if (defs === null) continue;
        filesScanned += 1;
        if (defs.length) lines.push(`\n${file}`);
        for (const [kind, name, line] of defs) {
          lines.push(`  ${kind} ${name}  (L${line})`);
          totalDefs += 1;
        }
        if (filesScanned >= 100) {
          lines.push("\n... (truncated at 100 files)");
          break;
        }
      }
      return {
        status: "ok",
        text: totalDefs ? lines.join("\n").trimEnd() : `(no recognised definitions under ${target})`,
      };
    }

    if (tool === "discover") {
      const terms = extractKeywords(body);
      if (terms.length === 0) return { status: "error", text: "discover: no usable search terms" };
      const scored = [];
      for (const file of repo.files()) {
        const text = repo.read(file);
        const lower = text.toLowerCase();
        const snippets = [];
        let score = 0;
        for (const term of terms) {
          const idx = lower.indexOf(term);
          if (idx === -1) continue;
          score += 10;
          const lineNo = text.slice(0, idx).split("\n").length;
          const line = text.split("\n")[lineNo - 1]?.trim().slice(0, 180) ?? "";
          snippets.push(`${file}:${lineNo}: ${line}`);
        }
        if (score > 0) scored.push({ file, score, snippets });
      }
      scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
      const top = scored.slice(0, 15);
      if (top.length === 0) return { status: "ok", text: `discover: no files mention any of: ${terms.join(", ")}` };
      const lines = [
        `discover: topic=\`${body.trim()}\`, keywords=[${terms.join(", ")}]`,
        "",
        `Top files (${top.length}):`,
      ];
      for (const hit of top) {
        lines.push(`  ${hit.file}  (score ${hit.score})`);
        for (const snippet of hit.snippets.slice(0, 3)) lines.push(`    > ${snippet}`);
      }
      return { status: "ok", text: lines.join("\n").slice(0, 9000) };
    }

    if (tool === "apply_diff" || tool === "edit_file") {
      const p = attrs.path;
      if (!p) return { status: "error", text: "missing path attribute" };
      if (!repo.has(p)) return { status: "error", text: `apply_diff: file \`${p}\` does not exist` };
      const result = applyDiffBody(body, repo.read(p));
      if (!result.ok) {
        const detail = result.missed?.length ? `\n${result.missed.join("\n")}` : "";
        return { status: "error", text: `${result.error}${detail}` };
      }
      repo.write(p, result.text);
      const skipped =
        result.appliedCount < result.totalHunks
          ? ` (${result.totalHunks - result.appliedCount} skipped: ${result.missed.join("; ")})`
          : "";
      return {
        status: "ok",
        text: `Applied ${result.appliedCount}/${result.totalHunks} hunks to ${repo.rel(p)}${skipped}`,
      };
    }

    if (tool === "write_file") {
      const p = attrs.path;
      if (!p) return { status: "error", text: "missing path attribute" };
      repo.write(p, body);
      return { status: "ok", text: `wrote ${repo.rel(p)} (${body.length}B)` };
    }

    if (tool === "delete_path") {
      const p = attrs.path;
      if (!p) return { status: "error", text: "missing path attribute" };
      repo.delete(p);
      return { status: "ok", text: `deleted ${repo.rel(p)}` };
    }

    if (tool === "rename_path") {
      const from = attrs.from;
      const to = attrs.to;
      if (!from || !to) return { status: "error", text: "missing from/to attribute" };
      repo.rename(from, to);
      return { status: "ok", text: `renamed ${repo.rel(from)} -> ${repo.rel(to)}` };
    }

    if (tool === "run_check") {
      return {
        status: "error",
        text:
          "run_check is intentionally generic. Use the exact one-shot verification command requested by the user with <run_shell>.",
      };
    }

    if (tool === "run_shell") {
      const cmd = body.trim();
      if (!cmd) return { status: "error", text: "empty shell command" };
      const refusal = blockingCommandRefusal(cmd);
      if (refusal) return { status: "error", text: refusal };
      const timeoutMs = Number(attrs.timeout_ms ?? 180000);
      const r = command(repo.root, cmd, { timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      const status = r.code === 0 ? "ok" : "error";
      const text =
        `exit ${r.code}${r.signal ? ` signal=${r.signal}` : ""}\n` +
        (r.stdout ? `stdout:\n${compact(r.stdout, 2400)}\n` : "") +
        (r.stderr ? `stderr:\n${compact(r.stderr, 2400)}\n` : "");
      return { status, text: text.trim() };
    }

    return { status: "error", text: `unsupported tool: ${tool}` };
  } catch (e) {
    return { status: "error", text: e.message };
  }
}

function extractPlan(trace) {
  const plans = [];
  for (const turn of trace) {
    const text = turn.sanitized ?? turn.response ?? "";
    for (const m of text.matchAll(/<plan>([\s\S]*?)<\/plan>/g)) {
      if (m[1]?.trim()) plans.push(m[1].trim());
    }
  }
  return plans.at(-1) ?? "";
}

function extractFinal(trace) {
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i].final?.trim()) return trace[i].final.trim();
    const text = trace[i].sanitized ?? trace[i].response ?? "";
    const m = /<final>([\s\S]*?)<\/final>/.exec(text);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return "";
}

function toolPath(trace) {
  return trace
    .filter((turn) => turn.call)
    .map((turn) => {
      const attrs = turn.call.attrs ?? {};
      const target = attrs.path ?? attrs.from ?? "";
      return target ? `${turn.call.tool}:${target}` : turn.call.tool;
    })
    .join(" -> ");
}

function usedContextTools(trace) {
  return trace.some((turn) =>
    ["discover", "read_file", "grep", "glob", "search_codebase", "list_code_definition_names"].includes(
      turn.call?.tool,
    ),
  );
}

function mutationCalls(trace) {
  return trace.filter((turn) =>
    ["edit_file", "write_file", "apply_diff", "delete_path", "rename_path"].includes(turn.call?.tool),
  );
}

async function runAskProbe(root) {
  const dragDrop = fs.readFileSync(path.join(root, "src/composables/useDragDrop.js"), "utf-8");
  const response = await chat({
    system: askSystem(workspaceBrief(root)),
    messages: [
      {
        role: "user",
        content: `<file path="src/composables/useDragDrop.js">\n\`\`\`js\n${dragDrop}\n\`\`\`\n</file>\n\nTell me about src/composables/useDragDrop.js in this Tauri Markdown app as if I am reviewing drag-and-drop behavior.`,
      },
    ],
    options: { temperature: 0.2, num_predict: 900 },
  });
  assertMatches(
    "Ask useDragDrop.js",
    response,
    [
      /getCurrentWebview|webview|Tauri/i,
      /onDragDropEvent|drag/i,
      /showDropOverlay|overlay/i,
      /\.md|\.markdown|\.txt|Markdown/i,
      /ElNotification|notification|unsupported/i,
      /getI18nText|i18n|language/i,
      /cleanup|unlisten/i,
    ],
    [/do(?:n't| not) have access/i, /share (?:the )?contents/i, /switch to Agent mode/i, /```/],
  );
  return response.trim();
}

async function runPlanProbe(root) {
  const repo = new DiskRepo(root);
  const goal = [
    "This is a real Vue 3 + Tauri Markdown editor checkout.",
    "Plan how to fix the regression where getI18nText no longer falls back to the fallback language when the requested language or translation path is missing.",
    "Gather source and test context yourself. Name exact files, exact behavior, and exact verification command.",
    "PLAN MODE ONLY: do not edit files and do not run tests.",
  ].join("\n");
  const run = await driveAgent({
    goal,
    fs_: repo,
    maxTurns: 12,
    mode: "plan",
    workspace: root,
    openTabs: ["src/utils/i18n-helper.js", "src/utils/__tests__/i18n-helper.test.js"],
    activeFile: "src/utils/i18n-helper.js",
    toolRunner: diskToolRunner,
  });
  const plan = extractPlan(run.trace);
  assert(run.terminated === "final", `Plan probe did not terminate cleanly: ${run.terminated}`);
  assert(usedContextTools(run.trace), "Plan probe did not gather codebase context with tools");
  assert(mutationCalls(run.trace).length === 0, "Plan probe attempted to mutate files");
  assertMatches(
    "Plan i18n deep-merge regression",
    plan,
    [
      /src\/utils\/i18n-helper\.js/,
      /src\/utils\/__tests__\/i18n-helper\.test\.js/,
      /getI18nText/,
      /fallback|fallbackLang|回退/i,
      /npm run test:run -- src\/utils\/__tests__\/i18n-helper\.test\.js|npx vitest run src\/utils\/__tests__\/i18n-helper\.test\.js/,
    ],
    [/create a plan to create a plan/i, /edit\s+src\/utils\/__tests__\/i18n-helper\.test\.js|update\s+src\/utils\/__tests__\/i18n-helper\.test\.js/i],
  );
  return { run, plan };
}

async function runDragOverlayPlanProbe(root) {
  const repo = new DiskRepo(root);
  const goal = [
    "This is a real Vue 3 + Tauri Markdown editor checkout.",
    "Plan how to fix a UI bug where the drag-and-drop overlay can remain visible and block the editor after a file drop, an invalid drop, or a window leave/cancel event.",
    "Gather source, render, and test context yourself. Name exact files, exact behavior, and exact verification command.",
    "The executable plan must replace the broken drop-state assignment and remove stale bug text, not add compensating code later in the same branch.",
    "PLAN MODE ONLY: do not edit files and do not run tests.",
  ].join("\n");
  const run = await driveAgent({
    goal,
    fs_: repo,
    maxTurns: 22,
    mode: "plan",
    workspace: root,
    openTabs: ["src/composables/useDragDrop.js", "src/components/MyVditor.vue"],
    activeFile: "src/composables/useDragDrop.js",
    toolRunner: diskToolRunner,
  });
  const plan = extractPlan(run.trace);
  assert(run.terminated === "final", `Drag overlay plan probe did not terminate cleanly: ${run.terminated}`);
  assert(usedContextTools(run.trace), "Drag overlay plan probe did not gather codebase context with tools");
  assert(mutationCalls(run.trace).length === 0, "Drag overlay plan probe attempted to mutate files");
  assertMatches(
    "Plan drag/drop overlay UI regression",
    plan,
    [
      /src\/composables\/useDragDrop\.js/,
      /src\/components\/MyVditor\.vue|drop-overlay/,
      /showDropOverlay/,
      /over|drop|leave|cancel/i,
      /src\/composables\/__tests__\/useDragDrop.*\.test\.js/,
      /npm run test:run -- src\/composables\/__tests__\/useDragDrop\.overlay-regression\.test\.js|npx vitest run src\/composables\/__tests__\/useDragDrop\.overlay-regression\.test\.js/,
    ],
    [/create a plan to create a plan/i, /edit\s+src\/composables\/__tests__\/useDragDrop/i, /add\s+`?showDropOverlay\.value\s*=\s*false`?\s+after/i],
  );
  return { run, plan };
}

async function runAgentProbe(root) {
  const repo = new DiskRepo(root);
  const beforeTest = fs.readFileSync(path.join(root, "src/utils/__tests__/i18n-helper.test.js"), "utf-8");
  const goal = [
    "This is a real Vue 3 + Tauri Markdown editor checkout.",
    "A regression in src/utils/i18n-helper.js makes getI18nText skip fallback language lookup when the requested language or translation path is missing.",
    "Find the right source and test context yourself, fix the source only, do not edit tests, and verify with this exact command:",
    TARGETED_I18N_TEST,
  ].join("\n");
  const run = await driveAgent({
    goal,
    fs_: repo,
    maxTurns: 18,
    mode: "auto",
    workspace: root,
    openTabs: ["src/utils/i18n-helper.js", "src/utils/__tests__/i18n-helper.test.js"],
    activeFile: "src/utils/i18n-helper.js",
    toolRunner: diskToolRunner,
  });
  const sourceFile = fs.readFileSync(path.join(root, "src/utils/i18n-helper.js"), "utf-8");
  const afterTest = fs.readFileSync(path.join(root, "src/utils/__tests__/i18n-helper.test.js"), "utf-8");
  const runShells = run.trace.filter((turn) => turn.call?.tool === "run_shell");
  assert(run.terminated === "final", `Agent probe did not terminate cleanly: ${run.terminated}`);
  assert(usedContextTools(run.trace), "Agent probe did not gather source/test context with tools");
  assert(
    mutationCalls(run.trace).some((turn) => turn.call.attrs.path === "src/utils/i18n-helper.js"),
    "Agent did not edit src/utils/i18n-helper.js",
  );
  assert(afterTest === beforeTest, "Agent edited i18n-helper.test.js despite being asked not to");
  assert(/if\s*\(\s*fallbackLang\s*&&\s*fallbackLang\s*!==\s*lang\s*\)/.test(sourceFile), "Agent did not restore getI18nText fallback branch");
  assert(runShells.some((turn) => /i18n-helper\.test\.js|test:run|vitest/.test(turn.call.body)), "Agent did not run targeted Vitest verification");
  const finalTest = command(root, TARGETED_I18N_TEST, { timeoutMs: 180000 });
  assert(finalTest.code === 0, `Targeted i18n test still fails after agent fix:\n${compact(finalTest.stdout)}\n${compact(finalTest.stderr)}`);
  return { run, final: extractFinal(run.trace), finalTest };
}

async function runDragOverlayAgentProbe(root) {
  const repo = new DiskRepo(root);
  const testPath = path.join(root, "src/composables/__tests__/useDragDrop.overlay-regression.test.js");
  const beforeTest = fs.readFileSync(testPath, "utf-8");
  const goal = [
    "This is a real Vue 3 + Tauri Markdown editor checkout.",
    "A UI regression leaves the drag-and-drop overlay visible after drop events, including invalid file drops, so it can block the editor.",
    "Find the source, render, and test context yourself. Fix the source only, do not edit tests. Replace the broken drop-state assignment/comment rather than adding compensating code later in the same branch. Verify with this exact command:",
    TARGETED_DRAG_TEST,
  ].join("\n");
  const run = await driveAgent({
    goal,
    fs_: repo,
    maxTurns: 20,
    mode: "auto",
    workspace: root,
    openTabs: [
      "src/composables/useDragDrop.js",
      "src/components/MyVditor.vue",
      "src/composables/__tests__/useDragDrop.overlay-regression.test.js",
    ],
    activeFile: "src/composables/useDragDrop.js",
    toolRunner: diskToolRunner,
  });
  const sourceFile = fs.readFileSync(path.join(root, "src/composables/useDragDrop.js"), "utf-8");
  const afterTest = fs.readFileSync(testPath, "utf-8");
  const runShells = run.trace.filter((turn) => turn.call?.tool === "run_shell");
  assert(run.terminated === "final", `Drag overlay agent probe did not terminate cleanly: ${run.terminated}`);
  assert(usedContextTools(run.trace), "Drag overlay agent probe did not gather source/test context with tools");
  assert(
    mutationCalls(run.trace).some((turn) => turn.call.attrs.path === "src/composables/useDragDrop.js"),
    "Agent did not edit src/composables/useDragDrop.js",
  );
  assert(afterTest === beforeTest, "Agent edited drag/drop overlay regression test despite being asked not to");
  const dropBranch = /if\s*\(\s*type\s*===\s*'drop'\s*\)\s*\{([\s\S]*?)\n        \}/.exec(sourceFile)?.[1] ?? "";
  assert(/showDropOverlay\.value\s*=\s*false/.test(dropBranch), "Agent did not restore overlay reset in the drop branch");
  assert(!/BUG|showDropOverlay\.value\s*=\s*true/.test(dropBranch), "Agent left contradictory or stale buggy overlay code in the drop branch");
  assert(runShells.some((turn) => /useDragDrop\.overlay-regression\.test\.js|test:run|vitest/.test(turn.call.body)), "Agent did not run targeted drag/drop overlay verification");
  const finalTest = command(root, TARGETED_DRAG_TEST, { timeoutMs: 180000 });
  assert(finalTest.code === 0, `Targeted drag/drop overlay test still fails after agent fix:\n${compact(finalTest.stdout)}\n${compact(finalTest.stderr)}`);
  return { run, final: extractFinal(run.trace), finalTest };
}

console.log(bar("Tauri Markdown real-repo Pointer probe"));
console.log(`Model: ${MODEL}`);
console.log(`Source repo: ${SOURCE_REPO}`);
const sourceStatusBefore = sourceStatus();
if (sourceStatusBefore) {
  console.log(`Source repo initial status:\n${sourceStatusBefore}`);
}

const tempRoot = copyRepoToTemp();
console.log(`Temp repo: ${tempRoot}`);

const install = installDeps(tempRoot);
console.log(`Installed dependencies with: ${install}`);

introduceI18nRegression(tempRoot);
const failing = command(tempRoot, TARGETED_I18N_TEST, { timeoutMs: 180000 });
assert(
  failing.code !== 0,
  `Injected i18n regression did not fail the targeted test. Output:\n${compact(failing.stdout)}\n${compact(failing.stderr)}`,
);

console.log("\nFAILING TEST BEFORE AGENT");
console.log(compact(`${failing.stdout}\n${failing.stderr}`, 1800));

const askResponse = await runAskProbe(tempRoot);
console.log("\nASK RESPONSE - useDragDrop.js");
console.log(askResponse);

const planProbe = await runPlanProbe(tempRoot);
console.log("\nPLAN RESPONSE - i18n fallback regression");
console.log(planProbe.plan);
console.log(`Tool path: ${toolPath(planProbe.run.trace)}`);

const agentProbe = await runAgentProbe(tempRoot);
console.log("\nAGENT FINAL - i18n fallback regression");
console.log(agentProbe.final || "(final block was empty)");
console.log(`Tool path: ${toolPath(agentProbe.run.trace)}`);

console.log("\nTARGETED TEST AFTER AGENT");
console.log(compact(`${agentProbe.finalTest.stdout}\n${agentProbe.finalTest.stderr}`, 1800));

addDragOverlayRegressionTest(tempRoot);
introduceDragOverlayRegression(tempRoot);
const failingDrag = command(tempRoot, TARGETED_DRAG_TEST, { timeoutMs: 180000 });
assert(
  failingDrag.code !== 0,
  `Injected drag/drop overlay regression did not fail the targeted test. Output:\n${compact(failingDrag.stdout)}\n${compact(failingDrag.stderr)}`,
);

console.log("\nFAILING DRAG/DROP OVERLAY TEST BEFORE AGENT");
console.log(compact(`${failingDrag.stdout}\n${failingDrag.stderr}`, 1800));

const dragPlanProbe = await runDragOverlayPlanProbe(tempRoot);
console.log("\nPLAN RESPONSE - drag/drop overlay UI regression");
console.log(dragPlanProbe.plan);
console.log(`Tool path: ${toolPath(dragPlanProbe.run.trace)}`);

const dragAgentProbe = await runDragOverlayAgentProbe(tempRoot);
console.log("\nAGENT FINAL - drag/drop overlay UI regression");
console.log(dragAgentProbe.final || "(final block was empty)");
console.log(`Tool path: ${toolPath(dragAgentProbe.run.trace)}`);

console.log("\nTARGETED DRAG/DROP OVERLAY TEST AFTER AGENT");
console.log(compact(`${dragAgentProbe.finalTest.stdout}\n${dragAgentProbe.finalTest.stderr}`, 1800));

const sourceStatusAfter = sourceStatus();
assert(
  sourceStatusAfter === sourceStatusBefore,
  `Original Tauri Markdown repo status changed.\nBefore:\n${sourceStatusBefore || "(clean)"}\nAfter:\n${sourceStatusAfter || "(clean)"}`,
);

console.log("\nTauri Markdown real-repo Pointer probe passed.");
console.log(`Original repo status was unchanged. Temp repo retained for inspection: ${tempRoot}`);
