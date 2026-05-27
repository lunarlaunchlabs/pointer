#!/usr/bin/env node
// Terminal workbench for Pointer's Ask / Plan / Agent flows.
//
// This is intentionally not a toy prompt runner. It reuses the live Ollama
// chat path plus the same agent system prompt, XML tool parser, and tool
// semantics used by the existing quality evaluator. The extra layer here is
// what the GUI normally owns: repo context, implicit file references, active
// editor file grounding, plan execution, and approval prompts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { MODEL, QUALITY_NUM_CTX, bar, emoji } from "./lib.mjs";
import { VirtualFs } from "./evalAgent.mjs";

const DEFAULT_REPO =
  fs.existsSync("/Users/sameer/express") ? "/Users/sameer/express" : process.cwd();

const IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".codegraph",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
  "target",
  "vendor",
]);

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".cxx",
  ".editorconfig",
  ".env",
  ".fish",
  ".go",
  ".gradle",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".lock",
  ".m",
  ".md",
  ".mdx",
  ".mjs",
  ".mm",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const ALWAYS_TEXT = new Set([
  "Dockerfile",
  "Makefile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "LICENSE",
]);

const FILE_EXTENSIONS = [
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cxx",
  "env",
  "fish",
  "go",
  "gradle",
  "h",
  "hh",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "m",
  "md",
  "mdx",
  "mjs",
  "mm",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
];

const FILE_MENTION_RE = new RegExp(
  "(?:^|[\\s([{\\\"'`])((?:~?\\.{0,2}/|/)?(?:[A-Za-z0-9_@+()[\\].-]+/)*[A-Za-z0-9_@+()[\\].-]+\\.(" +
    FILE_EXTENSIONS.join("|") +
    "))(?:$|[\\s)\\]}\\\",'`:;.!?])",
  "gi",
);

const MUTATING_TOOLS = new Set([
  "edit_file",
  "rename_symbol",
  "write_file",
  "apply_diff",
  "delete_path",
  "rename_path",
]);

const REVIEW_TOOLS = new Set([
  ...MUTATING_TOOLS,
  "run_shell",
  "run_check",
]);

const DIRECT_EDIT_RE =
  /\b(change|edit|fix|add|remove|delete|rename|rewrite|implement|create|modify|update|patch)\b/i;

class PointerTerminal {
  constructor({
    repo = DEFAULT_REPO,
    approval = "interactive",
    maxFiles = 5000,
    maxBytes = 24 * 1024 * 1024,
    maxFileBytes = 768 * 1024,
    verbose = true,
  } = {}) {
    this.mode = "ask";
    this.root = null;
    this.repoLabel = null;
    this.fs_ = new VirtualFs({});
    this.baseline = new Map();
    this.openTabs = [];
    this.activeFile = null;
    this.refs = [];
    this.askMessages = [];
    this.lastPlan = "";
    this.lastResult = null;
    this.approval = approval;
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.maxFileBytes = maxFileBytes;
    this.verbose = verbose;
    this.repoLoadWarnings = [];
    if (repo) this.loadRepo(repo);
  }

  loadRepo(repoPath) {
    const root = path.resolve(expandHome(repoPath));
    const snap = loadRepoSnapshot(root, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      maxFileBytes: this.maxFileBytes,
    });
    this.root = root;
    this.repoLabel = path.basename(root);
    this.fs_ = new VirtualFs(snap.files);
    this.baseline = this.fs_.snapshot();
    this.openTabs = [];
    this.activeFile = guessActiveFile(snap.files);
    this.refs = [];
    this.askMessages = [];
    this.lastPlan = "";
    this.lastResult = null;
    this.repoLoadWarnings = snap.warnings;
    if (this.verbose) {
      console.log(
        `Loaded ${root} (${Object.keys(snap.files).length} text files, ${formatBytes(
          snap.totalBytes,
        )})`,
      );
      if (this.activeFile) console.log(`Active file: ${this.activeFile}`);
      for (const warning of snap.warnings.slice(0, 4)) console.log(`warning: ${warning}`);
    }
  }

  setMode(mode) {
    if (!["ask", "chat", "plan", "agent", "agent-ask"].includes(mode)) {
      throw new Error(`unknown mode: ${mode}`);
    }
    this.mode = mode;
    console.log(`Mode: ${mode}`);
  }

  setActiveFile(filePath) {
    const p = this.resolveFile(filePath);
    if (!p) throw new Error(`No matching file for ${filePath}`);
    this.activeFile = p;
    if (!this.openTabs.includes(p)) this.openTabs.unshift(p);
    this.openTabs = this.openTabs.slice(0, 12);
    console.log(`Active file: ${p}`);
  }

  addRef(filePath) {
    const p = this.resolveFile(filePath);
    if (!p) throw new Error(`No matching file for ${filePath}`);
    if (!this.refs.includes(p)) this.refs.push(p);
    console.log(`Attached: ${p}`);
  }

  clearRefs() {
    this.refs = [];
    console.log("Attached refs cleared.");
  }

  status() {
    const changed = this.changedFiles();
    console.log(bar("Pointer terminal"));
    console.log(`model: ${MODEL}`);
    console.log(`ctx: ${QUALITY_NUM_CTX}`);
    console.log(`mode: ${this.mode}`);
    console.log(`repo: ${this.root ?? "(none)"}`);
    console.log(`active: ${this.activeFile ?? "(none)"}`);
    console.log(`tabs: ${this.openTabs.length ? this.openTabs.join(", ") : "(none)"}`);
    console.log(`refs: ${this.refs.length ? this.refs.join(", ") : "(none)"}`);
    console.log(`changed files: ${changed.length ? changed.join(", ") : "(none)"}`);
  }

  async send(prompt, opts = {}) {
    const mode = opts.mode ?? this.mode;
    if (mode === "ask" || mode === "chat") {
      return this.ask(prompt, opts);
    }
    if (mode === "plan") return this.plan(prompt, opts);
    if (mode === "agent" || mode === "agent-ask") return this.agent(prompt, opts);
    throw new Error(`unknown mode: ${mode}`);
  }

  async ask(prompt, opts = {}) {
    if (isDirectAskEditRequest(prompt)) {
      const response = ASK_EDIT_REDIRECT;
      this.askMessages.push({ role: "user", content: prompt });
      this.askMessages.push({ role: "assistant", content: response });
      this.lastResult = { mode: "ask", prompt, response, contextFiles: [] };
      console.log(response);
      return this.lastResult;
    }
    const context = this.buildAskContext(prompt);
    const messages = [...this.askMessages, { role: "user", content: prompt }];
    const opencodePrompt = renderAskRunPrompt({ messages });
    if (this.verbose) {
      console.log(bar("Ask"));
      console.log(`context files: ${context.files.join(", ") || "(current file only or none)"}`);
    }
    const run = await runOpenCode({
      repo: this.root,
      model: opts.model ?? MODEL,
      mode: "ask",
      prompt: opencodePrompt,
      title: "Pointer Ask",
      files: context.attachFiles,
    });
    const response = run.text;
    this.askMessages.push({ role: "user", content: prompt });
    this.askMessages.push({ role: "assistant", content: response });
    this.lastResult = { mode: "ask", prompt, response, contextFiles: context.files, trace: run.events };
    console.log(response.trim());
    return this.lastResult;
  }

  async plan(prompt, opts = {}) {
    if (this.verbose) console.log(bar("Plan"));
    const run = await runOpenCode({
      repo: this.root,
      model: opts.model ?? MODEL,
      mode: "plan",
      prompt: renderAgentRunPrompt({
        workspace: this.root,
        mode: "plan",
        goal: prompt,
        openTabs: this.openTabs,
        activeFile: this.activeFile,
      }),
      title: "Pointer Plan",
      files: this.buildAskContext(prompt).attachFiles,
    });
    const result = { mode: "plan", prompt, terminated: "final", trace: run.events, text: run.text };
    this.lastResult = result;
    this.lastPlan = run.text.trim();
    printOpenCodeTrace(run);
    if (this.lastPlan) {
      console.log(bar("Executable plan"));
      console.log(this.lastPlan);
      console.log("Use /execute to carry this plan into Agent mode.");
    }
    return this.lastResult;
  }

  async executeLastPlan(opts = {}) {
    if (!this.lastPlan.trim()) throw new Error("No plan is available to execute.");
    const goal = `Execute the following plan:\n\n${this.lastPlan}`;
    return this.agent(goal, { ...opts, mode: "agent" });
  }

  async agent(prompt, opts = {}) {
    const mode = opts.mode ?? this.mode;
    if (this.verbose) console.log(bar(mode === "agent-ask" ? "Agent with approvals" : "Agent"));
    const run = await runOpenCode({
      repo: this.root,
      model: opts.model ?? MODEL,
      mode: "agent",
      prompt: renderAgentRunPrompt({
        workspace: this.root,
        mode: "agent",
        goal: prompt,
        openTabs: this.openTabs,
        activeFile: this.activeFile,
      }),
      title: "Pointer Agent",
      dangerous: true,
      files: this.buildAskContext(prompt).attachFiles,
    });
    const result = { mode, prompt, terminated: "final", trace: run.events, text: run.text };
    this.lastResult = result;
    printOpenCodeTrace(run);
    return this.lastResult;
  }

  resolveFile(token) {
    if (!token) return null;
    const raw = normalizePath(stripQuotes(token));
    const rel = this.toRepoRelative(raw);
    if (rel && this.fs_.has(rel)) return rel;
    const candidates = [...this.fs_.files.keys()];
    const picked = pickFileCandidate(raw, [
      this.activeFile,
      ...this.openTabs,
      ...candidates,
    ].filter(Boolean));
    return picked;
  }

  buildAskContext(prompt) {
    const implicit = inferImplicitFileReferences(prompt, {
      files: [...this.fs_.files.keys()],
      activePath: this.activeFile,
      openTabs: this.openTabs,
      existingRefs: this.refs,
      maxFiles: 3,
    });
    const files = mergeUnique([...this.refs, ...implicit]);
    const attachFiles = mergeUnique([
      ...files,
      this.activeFile,
      ...this.openTabs.slice(0, 3),
    ]).filter((p) => p && this.fs_.has(p));
    const blocks = [];
    for (const p of files) {
      if (this.fs_.has(p)) blocks.push(fileBlock(p, this.fs_.read(p)));
    }
    if (this.activeFile && !files.includes(this.activeFile) && this.fs_.has(this.activeFile)) {
      blocks.push(fileBlock(this.activeFile, this.fs_.read(this.activeFile)));
    }
    const text = blocks.join("\n\n");
    return { text, files, attachFiles };
  }

  workspaceBrief() {
    const files = [...this.fs_.files.keys()];
    const top = files
      .filter((p) => !p.includes("/"))
      .slice(0, 40)
      .join(", ");
    const manifests = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]
      .filter((p) => this.fs_.has(p))
      .map((p) => summarizeManifest(p, this.fs_.read(p)))
      .filter(Boolean)
      .join("\n");
    return [
      `Workspace: ${this.root ?? "."}`,
      top ? `Top-level files: ${top}` : "",
      manifests,
      this.activeFile ? `Active editor file: ${this.activeFile}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  toRepoRelative(token) {
    if (!this.root) return token;
    const abs = path.isAbsolute(token) ? token : path.resolve(this.root, token);
    if (!abs.startsWith(this.root)) return token;
    return normalizePath(path.relative(this.root, abs));
  }

  changedFiles() {
    const paths = new Set([...this.baseline.keys(), ...this.fs_.files.keys()]);
    return [...paths].filter((p) => {
      const before = this.baseline.get(p);
      const after = this.fs_.has(p) ? this.fs_.files.get(p) : undefined;
      return before !== after;
    });
  }

  printDiff({ maxFiles = 8 } = {}) {
    const changed = this.changedFiles();
    if (!changed.length) {
      console.log("(no VFS changes)");
      return;
    }
    for (const p of changed.slice(0, maxFiles)) {
      console.log(bar(`diff ${p}`));
      const before = this.baseline.get(p) ?? "";
      const after = this.fs_.has(p) ? this.fs_.read(p) : "";
      console.log(simpleDiff(before, after).slice(0, 8000));
    }
    if (changed.length > maxFiles) {
      console.log(`... ${changed.length - maxFiles} more changed files`);
    }
  }

  async approveTool(call) {
    if (this.approval === "auto") return true;
    if (this.approval === "reject") return false;
    const rl = readline.createInterface({ input, output });
    try {
      console.log(bar(`Approval: ${call.tool}`));
      console.log(formatToolCall(call));
      const answer = await rl.question("Approve? [y]es / [n]o / [e]xplain: ");
      if (/^y/i.test(answer.trim())) return true;
      if (/^e/i.test(answer.trim())) {
        const note = await rl.question("Rejection note for the agent: ");
        return { approved: false, note: note.trim() || "User rejected this tool call." };
      }
      return false;
    } finally {
      rl.close();
    }
  }
}

function askSystemPrompt(brief) {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

You are in ASK mode - answer questions and explain code. Do NOT
emit edit blocks, tool tags, shell commands, or triple-backtick code
fences. If the user asks you to change code, do not provide a patch or
replacement implementation in Ask mode; briefly tell them to switch to
Plan mode for an implementation plan or Agent mode to apply the edit.

ASK MODE OUTPUT CONTRACT:
- Prose only. The literal string \`\`\` is forbidden.
- Inline code spans like \`profile.name\` are OK; multi-line code examples are not.
- If the context includes a <file> block for a named file, answer from that
  file. Do not claim you lack access to it.
- For "tell me about <file>" style questions, answer with the file's purpose,
  important imports/exports, state or data flow, and any notable risks or
  neighboring files worth checking. Prefer a tight, skimmable explanation.
- When a provided file defines object/property methods such as \`app.handle\`,
  \`app.use\`, \`defaultConfiguration\`, or \`request.subdomains\`, include the
  literal identifier names from the file. Do not paraphrase dotted assignments
  into generic method names.
- Preserve camelCase and dotted assignment names exactly: \`app.defaultConfiguration
  = function defaultConfiguration()\` should be discussed as
  \`app.defaultConfiguration\` / \`defaultConfiguration\`, not "default
  configuration".
- Include a compact "Key identifiers" sentence when explaining a file, naming
  4-8 concrete symbols or setting keys that are actually visible in the
  provided context.
- This is mandatory, not optional: when strings like \`app.defaultConfiguration\`,
  \`defaultConfiguration\`, \`trust proxy\`, \`query parser\`, \`etag\`, or
  \`request.subdomains\` are visible in the supplied file, include those exact
  strings in the answer.
- When explaining core framework/runtime files, name concrete configuration
  defaults, compatibility hooks, and routing/middleware paths visible in the
  file instead of smoothing them into generic summaries.
- Name important top-level functions and methods by their literal identifiers
  (for example \`app.handle\`, \`app.use\`, \`defaultConfiguration\`) when they
  are central to the file.
- Do not compress literal setting names into "configuration"; if keys such as
  \`trust proxy\`, \`etag\`, or \`query parser\` appear in the file, name them.
- For direct edit requests ("change this file", "fix this", "add X"),
  your ENTIRE response must be exactly:
  "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first."
  Do not show the changed code. Do not explain the change.

${
    brief && brief.trim().length
      ? "Workspace brief - a compact snapshot of the project the user has open. Use it for orientation; if you need more, ask.\n\n" +
        brief +
        "\n"
      : ""
  }`;
}

function renderAskRunPrompt({ messages }) {
  const out = ["Conversation:"];
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
    out.push(`${role}: ${m.content.trim()}`);
  }
  out.push(
    "Answer the latest user message. For file explanation questions, center the answer on the named or attached file and include a compact Key identifiers sentence with exact identifiers, dotted method names, and configuration keys visible in that file. For object methods, preserve their dotted form such as app.handle or app.use.",
  );
  return out.join("\n\n");
}

function renderAgentRunPrompt({ workspace, mode, goal, openTabs, activeFile }) {
  const out = [
    `Workspace: ${workspace ?? "."}`,
    `Mode: ${mode}`,
  ];
  if (activeFile) out.push(`Active editor file:\n${activeFile}`);
  if (openTabs?.length) out.push(`Open tabs:\n${openTabs.slice(0, 20).map((t) => `- ${t}`).join("\n")}`);
  out.push(`User goal:\n${goal.trim()}`);
  if (mode === "plan") {
    out.push(
      "Final response: provide a concrete executable plan with exact files and verification. If investigation shows no code change is warranted, say that directly and include the exact files/tests that prove it.",
    );
  }
  return out.join("\n\n");
}

async function runOpenCode({ repo, model, mode, prompt, title, dangerous = false, files = [] }) {
  const cwd = path.resolve(expandHome(repo ?? process.cwd()));
  if (!fs.existsSync(cwd)) throw new Error(`opencode cwd does not exist: ${cwd}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-opencode-"));
  const configPath = path.join(root, "opencode.json");
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const cacheDir = path.join(root, "cache");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(opencodeConfig(model), null, 2));
  const bin = resolveOpenCodeBin();
  const args = [
    "run",
    "--pure",
    "--model",
    opencodeModelArg(model),
    "--agent",
    mode === "ask" ? "pointer-ask" : mode === "agent" ? "build" : "plan",
    "--format",
    "json",
    "--title",
    title ?? `Pointer ${mode}`,
    prompt,
  ];
  for (const file of mergeUnique(files)) {
    args.push(`--file=${file}`);
  }
  if (dangerous) args.push("--dangerously-skip-permissions");

  const events = [];
  let fullText = "";
  let textSinceTool = "";
  try {
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        PWD: cwd,
        OPENCODE_CONFIG: configPath,
        XDG_DATA_HOME: dataDir,
        XDG_STATE_HOME: stateDir,
        XDG_CACHE_HOME: cacheDir,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "pointer-local",
        OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || "pointer-local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const event = parseOpenCodeLine(line);
        if (!event) continue;
        events.push(event);
        if (event.type === "text") {
          const t = event.part?.text ?? "";
          fullText += t;
          textSinceTool += t;
        } else if (event.type === "tool_use") {
          textSinceTool = "";
          console.log(formatOpenCodeToolEvent(event, events.length, cwd));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (stdoutBuf.trim()) {
      const event = parseOpenCodeLine(stdoutBuf);
      if (event) {
        events.push(event);
        if (event.type === "text") {
          const t = event.part?.text ?? "";
          fullText += t;
          textSinceTool += t;
        } else if (event.type === "tool_use") {
          textSinceTool = "";
        }
      }
    }
    if (code !== 0) {
      throw new Error(stripAnsi(stderrBuf).trim() || `opencode exited ${code}`);
    }
    return { text: (textSinceTool.trim() ? textSinceTool : fullText), fullText, events, cwd };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function opencodeConfig(model) {
  const modelId = opencodeModelId(model);
  const modelRef = `ollama/${modelId}`;
  return {
    $schema: "https://opencode.ai/config.json",
    model: modelRef,
    small_model: modelRef,
    share: "disabled",
    autoupdate: false,
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (local)",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
        models: {
          [modelId]: {
            name: modelId,
            limit: { context: 32768, output: 4096 },
          },
        },
      },
    },
    agent: {
      "pointer-ask": {
        model: modelRef,
        description: "Pointer Ask mode",
        prompt:
          "Answer questions about the current codebase using read-only repository context. If the user asks about a named or attached file, read that file first and center the answer on that file rather than giving a broad repository overview. Include a compact Key identifiers sentence with exact identifiers, dotted method names, and configuration keys visible in the file. For object methods, preserve their dotted form such as app.handle or app.use. Do not modify files.",
        tools: {
          edit: false,
          write: false,
          bash: false,
          task: false,
          webfetch: false,
          websearch: false,
        },
      },
    },
  };
}

function resolveOpenCodeBin() {
  if (process.env.POINTER_OPENCODE_BIN && fs.existsSync(process.env.POINTER_OPENCODE_BIN)) {
    return process.env.POINTER_OPENCODE_BIN;
  }
  const local = path.resolve("node_modules/.bin/opencode");
  if (fs.existsSync(local)) return local;
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "opencode");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("opencode is required. Run npm install in the Pointer repo or set POINTER_OPENCODE_BIN.");
}

function opencodeModelId(model) {
  return String(model).trim().replace(/^ollama\//, "");
}

function opencodeModelArg(model) {
  const trimmed = String(model).trim();
  return trimmed.includes("/") ? trimmed : `ollama/${trimmed}`;
}

function parseOpenCodeLine(line) {
  const clean = stripAnsi(line).trim();
  if (!clean.startsWith("{")) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function loadRepoSnapshot(root, { maxFiles, maxBytes, maxFileBytes }) {
  if (!fs.existsSync(root)) throw new Error(`repo does not exist: ${root}`);
  const files = {};
  const warnings = [];
  let totalBytes = 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`could not read ${dir}: ${error.message}`);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = normalizePath(path.relative(root, full));
      if (!rel || shouldIgnore(rel, ent)) continue;
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (count >= maxFiles) {
        warnings.push(`file cap reached at ${maxFiles}; remaining files skipped`);
        return { files, totalBytes, warnings };
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) {
        warnings.push(`${rel} skipped (${formatBytes(stat.size)} > ${formatBytes(maxFileBytes)})`);
        continue;
      }
      if (totalBytes + stat.size > maxBytes) {
        warnings.push(`byte cap reached at ${formatBytes(maxBytes)}; remaining files skipped`);
        return { files, totalBytes, warnings };
      }
      if (!looksTextual(full, ent.name)) continue;
      let text;
      try {
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue;
        text = buf.toString("utf-8");
      } catch {
        continue;
      }
      files[rel] = text;
      totalBytes += Buffer.byteLength(text);
      count += 1;
    }
  }
  return { files, totalBytes, warnings };
}

function shouldIgnore(rel, ent) {
  const parts = rel.split("/");
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  if (ent.isDirectory()) return false;
  const name = parts.at(-1) ?? "";
  if (/\.map$/i.test(name)) return true;
  if (/\.min\.(js|css)$/i.test(name)) return true;
  if (/\.(png|jpg|jpeg|gif|webp|ico|icns|pdf|zip|tar|gz|tgz|wasm|woff2?|ttf|otf|mp4|mov|mp3)$/i.test(name)) {
    return true;
  }
  return false;
}

function looksTextual(full, name) {
  if (ALWAYS_TEXT.has(name)) return true;
  const ext = path.extname(name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (/^(README|CHANGELOG|CONTRIBUTING|LICENSE)(\..*)?$/i.test(name)) return true;
  try {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

function guessActiveFile(files) {
  const keys = Object.keys(files);
  return (
    keys.find((p) => /^src\/App\.(tsx|jsx|vue|svelte)$/.test(p)) ||
    keys.find((p) => /^src\/main\.(ts|tsx|js|jsx|vue)$/.test(p)) ||
    keys.find((p) => /^lib\/application\.js$/.test(p)) ||
    keys.find((p) => /^src\/components\/MyVditor\.vue$/.test(p)) ||
    keys.find((p) => /^package\.json$/.test(p)) ||
    keys[0] ||
    null
  );
}

function extractFileMentions(text) {
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(FILE_MENTION_RE)) {
    const raw = match[1]?.trim();
    if (!raw || /^https?:\/\//i.test(raw)) continue;
    const token = stripQuotes(raw);
    const key = normalizePath(token).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function inferImplicitFileReferences(text, opts) {
  const mentions = extractFileMentions(text);
  if (!mentions.length) return [];
  const existing = new Set((opts.existingRefs ?? []).map((p) => normalizePath(p).toLowerCase()));
  const out = [];
  const emitted = new Set();
  const candidates = [opts.activePath, ...(opts.openTabs ?? []), ...(opts.files ?? [])].filter(Boolean);
  for (const mention of mentions) {
    if (out.length >= (opts.maxFiles ?? 3)) break;
    const picked = pickFileCandidate(mention, candidates);
    if (!picked) continue;
    const key = normalizePath(picked).toLowerCase();
    if (existing.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    out.push(picked);
  }
  return out;
}

function pickFileCandidate(mention, candidates) {
  const token = normalizePath(stripQuotes(mention)).replace(/^\.\//, "").toLowerCase();
  const tokenBase = basename(token);
  const hasDir = token.includes("/");
  const matches = mergeUnique(candidates).filter((p) => {
    const normalized = normalizePath(p).toLowerCase();
    if (hasDir) return normalized === token || normalized.endsWith(`/${token}`);
    return basename(normalized) === tokenBase;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const exact = matches.find((p) => normalizePath(p).toLowerCase() === token);
  if (exact) return exact;
  const shortest = [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return shortest ?? null;
}

function fileBlock(filePath, contents) {
  return `<file path="${filePath}">\n\`\`\`${languageForPath(filePath)}\n${contents}\n\`\`\`\n</file>`;
}

function languageForPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "vue") return "vue";
  if (ext === "rs") return "rust";
  if (ext === "js" || ext === "cjs" || ext === "mjs") return "javascript";
  if (ext === "ts") return "typescript";
  if (ext === "tsx") return "tsx";
  if (ext === "jsx") return "jsx";
  if (ext === "py") return "python";
  if (ext === "md" || ext === "mdx") return "markdown";
  return ext;
}

function summarizeManifest(p, text) {
  if (p === "package.json") {
    try {
      const pkg = JSON.parse(text);
      const scripts = Object.entries(pkg.scripts ?? {})
        .slice(0, 8)
        .map(([name, cmd]) => `${name}: ${cmd}`)
        .join("; ");
      return `package.json: ${pkg.name ?? "(unnamed)"}${scripts ? `; scripts: ${scripts}` : ""}`;
    } catch {
      return "package.json present";
    }
  }
  if (p === "Cargo.toml") return "Cargo.toml present";
  if (p === "pyproject.toml") return "pyproject.toml present";
  if (p === "go.mod") return "go.mod present";
  return "";
}

function extractLatestBlock(trace, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const blocks = [];
  for (const turn of trace ?? []) {
    const text = turn.sanitized ?? turn.response ?? "";
    for (const match of text.matchAll(re)) blocks.push(match[1].trim());
  }
  return blocks.at(-1) ?? "";
}

function printOpenCodeTrace(run) {
  const toolEvents = run.events.filter((event) => event.type === "tool_use");
  console.log(bar(`OpenCode trace: ${run.cwd ?? process.cwd()}`));
  if (toolEvents.length) console.log(`${toolEvents.length} tool events streamed above.`);
  console.log(bar("OpenCode final"));
  console.log(run.text.trim());
}

function formatOpenCodeToolEvent(event, idx, workspace) {
  const tool = event.part?.tool ?? "tool";
  const state = event.part?.state ?? {};
  const status = state.status ?? "";
  const input = state.input ?? {};
  const target = describeOpenCodeToolTarget(input, workspace);
  return `T${idx}: ${tool} ${status}${target ? ` ${target}` : ""}`.trim();
}

function describeOpenCodeToolTarget(input, workspace) {
  const refs = collectInputPathRefs(input, workspace);
  if (refs.length) return refs.slice(0, 2).join(", ");
  if (typeof input?.command === "string") return shellOneLine(input.command).slice(0, 120);
  if (typeof input?.pattern === "string") return input.pattern.slice(0, 120);
  return "";
}

function shellOneLine(command) {
  return command.replace(/\s+/g, " ").trim();
}

function printAgentTrace(result) {
  for (const [idx, turn] of result.trace.entries()) {
    const ms = typeof turn.ms === "number" ? ` ${turn.ms}ms` : "";
    if (turn.call) {
      console.log(
        `T${idx + 1}${ms}: ${turn.call.tool} ${JSON.stringify(turn.call.attrs ?? {})}`,
      );
    } else if (turn.final) {
      console.log(`T${idx + 1}${ms}: final`);
    } else if (turn.clarify) {
      console.log(`T${idx + 1}${ms}: clarify`);
    } else {
      console.log(`T${idx + 1}${ms}: model response`);
    }
    if (turn.result) {
      console.log(`  -> ${turn.result.status}: ${(turn.result.text ?? "").slice(0, 220).replace(/\n/g, " ")}`);
    }
  }
  const final = result.trace.at(-1)?.final;
  const clarify = result.trace.at(-1)?.clarify;
  console.log(bar(`Terminated: ${result.terminated}`));
  if (final) console.log(final);
  if (clarify) console.log(clarify);
}

function evaluateAsk(result, expect = {}) {
  const failures = [];
  const text = result.response ?? "";
  if (/```/.test(text)) failures.push("Ask emitted a fenced code block.");
  if (/<(?:read_file|apply_diff|tool_result|plan|final|clarify)\b/i.test(text)) {
    failures.push("Ask emitted agent/tool protocol tags.");
  }
  if (result.contextFiles?.length && /\b(don't|do not)\s+have\s+access\b|\bshare (?:the )?(?:contents|file)\b/i.test(text)) {
    failures.push("Ask claimed it lacked file access despite attached file context.");
  }
  if (expect.directEditRedirect && text.trim() !== ASK_EDIT_REDIRECT) {
    failures.push("Ask did not use the exact edit-mode redirect.");
  }
  for (const needle of expect.includes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (!ok) failures.push(`Ask response missing ${needle}`);
  }
  for (const needle of expect.excludes ?? []) {
    const hit = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (hit) failures.push(`Ask response unexpectedly included ${needle}`);
  }
  failures.push(...workspaceTraceFailures(result, expect));
  return { pass: failures.length === 0, failures };
}

function evaluatePlan(result, expect = {}) {
  const failures = [];
  if (result.terminated !== "final") failures.push(`Plan terminated by ${result.terminated}.`);
  const plan = result.text ?? extractLatestBlock(result.trace, "plan");
  if (!plan.trim()) failures.push("Plan did not emit a <plan> block.");
  if (/\b(plan to (?:make|create|write) a plan|create a plan\b|plan the plan)\b/i.test(plan)) {
    failures.push("Plan is meta-planning instead of executable implementation planning.");
  }
  const mutators = result.trace
    .filter(
      (t) =>
        (t.call && MUTATING_TOOLS.has(t.call.tool) && t.result?.status === "ok") ||
        (t.type === "tool_use" &&
          MUTATING_TOOLS.has(opencodeToolName(t)) &&
          opencodeToolStatus(t) === "completed"),
    )
    .map((t) => t.call?.tool ?? opencodeToolName(t));
  if (mutators.length) failures.push(`Plan mutated files: ${mutators.join(", ")}`);
  for (const needle of expect.includes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(plan) : plan.includes(needle);
    if (!ok) failures.push(`Plan missing ${needle}`);
  }
  const refs = collectToolReferences(result.trace ?? [], expect.workspace ?? result.cwd);
  const refText = refs.map((r) => r.raw).join("\n");
  for (const needle of expect.toolIncludes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(refText) : refText.includes(needle);
    if (!ok) failures.push(`Plan tool trace missing ${needle}`);
  }
  failures.push(...workspaceTraceFailures(result, expect));
  return { pass: failures.length === 0, failures, plan };
}

function evaluateAgent(result, terminal, expect = {}) {
  const failures = [];
  if (expect.finalRequired !== false && result.terminated !== "final") {
    failures.push(`Agent terminated by ${result.terminated}.`);
  }
  const changed = terminal.changedFiles();
  if (expect.changed?.length) {
    for (const p of expect.changed) {
      if (!changed.includes(p)) failures.push(`Expected ${p} to change.`);
    }
  }
  if (expect.unchanged?.length) {
    for (const p of expect.unchanged) {
      if (changed.includes(p)) failures.push(`Expected ${p} to remain unchanged.`);
    }
  }
  for (const [filePath, needle] of Object.entries(expect.fileContains ?? {})) {
    const text = terminal.fs_.has(filePath) ? terminal.fs_.read(filePath) : "";
    const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (!ok) failures.push(`${filePath} missing ${needle}`);
  }
  failures.push(...workspaceTraceFailures(result, expect));
  return { pass: failures.length === 0, failures, changed };
}

function workspaceTraceFailures(result, expect = {}) {
  const workspace = expect.workspace ?? result.cwd;
  if (!workspace) return [];
  const failures = [];
  const root = path.resolve(expandHome(workspace));
  const refs = collectToolReferences(result.trace ?? [], root);
  const outside = refs
    .filter((ref) => ref.absolute && !isInsidePath(ref.absolute, root))
    .map((ref) => `${ref.tool}: ${ref.raw}`)
    .slice(0, 8);
  if (outside.length) {
    failures.push(`OpenCode touched paths outside ${root}: ${outside.join("; ")}`);
  }
  const text = [result.text, result.response].filter(Boolean).join("\n");
  if (text.includes("/Users/sameer/pointer") && root !== "/Users/sameer/pointer") {
    failures.push("Output referenced the Pointer repo while evaluating a different workspace.");
  }
  return failures;
}

function collectToolReferences(events, workspace) {
  const out = [];
  for (const event of events ?? []) {
    if (event.type !== "tool_use") continue;
    const tool = opencodeToolName(event);
    const input = event.part?.state?.input ?? {};
    for (const ref of collectInputPathRefs(input, workspace)) {
      out.push({ tool, raw: ref, absolute: absoluteToolPath(ref, workspace) });
    }
  }
  return out;
}

function collectInputPathRefs(input, workspace) {
  const out = [];
  if (!input || typeof input !== "object") return out;
  for (const key of ["filePath", "path", "cwd"]) {
    const v = input[key];
    if (typeof v === "string" && looksPathLike(v)) out.push(normalizePath(v));
  }
  const command = typeof input.command === "string" ? input.command : "";
  if (command && /\/Users\/sameer\/(?:pointer|express|tauri-markdown|Blog-and-Portfolio)\b/.test(command)) {
    for (const match of command.matchAll(/\/Users\/sameer\/[^\s"'`|;&)]+/g)) {
      out.push(normalizePath(match[0]));
    }
  }
  return mergeUnique(out).map((ref) => displayToolPath(ref, workspace));
}

function displayToolPath(ref, workspace) {
  const normalized = normalizePath(ref);
  const root = workspace ? normalizePath(path.resolve(expandHome(workspace))) : "";
  if (path.isAbsolute(normalized) && root && isInsidePath(normalized, root)) {
    return normalizePath(path.relative(root, normalized)) || ".";
  }
  return normalized;
}

function absoluteToolPath(ref, workspace) {
  if (!workspace || !looksPathLike(ref)) return null;
  const root = path.resolve(expandHome(workspace));
  const raw = normalizePath(ref);
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (isGlobPattern(raw)) return null;
  return path.resolve(root, raw);
}

function isInsidePath(candidate, root) {
  if (!candidate) return true;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function looksPathLike(value) {
  if (!value || typeof value !== "string") return false;
  if (/^https?:\/\//i.test(value)) return false;
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    /\.[A-Za-z0-9]{1,8}$/.test(value)
  );
}

function isGlobPattern(value) {
  return /[*?[\]{}]/.test(value);
}

function opencodeToolName(event) {
  return event.part?.tool ?? "tool";
}

function opencodeToolStatus(event) {
  return event.part?.state?.status ?? "";
}

const ASK_EDIT_REDIRECT =
  "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first.";

function isDirectAskEditRequest(text) {
  const trimmed = String(text).trim().replace(/\s+/g, " ").toLowerCase();
  if (!trimmed) return false;
  if (/\bhow\b|\bwhy\b|\bwhat\b|\bexplain\b|\btell me\b|\bplan\b/.test(trimmed)) {
    return false;
  }
  return DIRECT_EDIT_RE.test(trimmed);
}

const SCENARIOS = [
  {
    id: "express-ask-application",
    mode: "ask",
    repo: "/Users/sameer/express",
    activeFile: "lib/application.js",
    prompt: "Tell me about application.js",
    expect: {
      includes: [
        /defaultConfiguration/,
        /app\.handle/,
        /app\.use/,
        /trust proxy/,
        /query parser/,
      ],
    },
  },
  {
    id: "express-ask-edit-redirect",
    mode: "ask",
    repo: "/Users/sameer/express",
    activeFile: "lib/request.js",
    prompt: "Fix lib/request.js so req.subdomains handles offset better",
    expect: { directEditRedirect: true },
  },
  {
    id: "express-plan-subdomains",
    mode: "plan",
    repo: "/Users/sameer/express",
    activeFile: "lib/request.js",
    prompt:
      "Plan how you would investigate and fix a bug where req.subdomains returns the wrong array when a custom subdomain offset is set. Produce an executable plan only after reading the relevant source and test context.",
    expect: {
      includes: [
        /lib\/request\.js/,
        /test\/req\.subdomains\.js/,
        /subdomain offset/,
        /(npm test -- --grep|mocha .*req\.subdomains|test\/req\.subdomains\.js)/,
      ],
      toolIncludes: [/test\/req\.subdomains\.js/],
    },
  },
  {
    id: "tauri-ask-vditor",
    mode: "ask",
    repo: "/Users/sameer/tauri-markdown",
    activeFile: "src/components/MyVditor.vue",
    prompt: "Tell me about MyVditor.vue",
    expect: {
      includes: [/dragDropManager|drop-overlay/, /Vditor/, /upload|image/i],
    },
  },
  {
    id: "tauri-plan-drag-overlay",
    mode: "plan",
    repo: "/Users/sameer/tauri-markdown",
    activeFile: "src/components/MyVditor.vue",
    prompt:
      "Plan a fix for a UI bug where the drag-and-drop overlay can remain visible after dropping an unsupported file. Read the relevant Vue component, composable, CSS, and existing tests before proposing the executable plan.",
    expect: {
      includes: [
        /src\/components\/MyVditor\.vue/,
        /src\/composables\/useDragDrop\.js/,
        /src\/composables\/__tests__\/useDragDrop\.test\.js/,
        /(npm run test:run -- src\/composables\/__tests__\/useDragDrop\.test\.js|npx vitest run src\/composables\/__tests__\/useDragDrop\.test\.js|vitest run src\/composables\/__tests__\/useDragDrop\.test\.js)/,
      ],
      toolIncludes: [
        /src\/composables\/useDragDrop\.js/,
        /src\/composables\/__tests__\/useDragDrop\.test\.js/,
      ],
    },
  },
];

async function runScenarioSuite({ suite = "smoke", repoOverride = null, approval = "auto" } = {}) {
  console.log(bar(`Pointer terminal suite: ${suite}`));
  console.log(`model: ${MODEL}`);
  const selected =
    suite === "smoke"
      ? SCENARIOS.filter((s) => ["express-ask-application", "express-ask-edit-redirect"].includes(s.id))
      : suite === "real"
        ? SCENARIOS
        : SCENARIOS.filter((s) => s.id === suite || s.mode === suite);
  if (!selected.length) throw new Error(`No terminal scenario matched ${suite}`);
  const results = [];
  for (const scenario of selected) {
    const repo = repoOverride ?? scenario.repo;
    if (!fs.existsSync(repo)) {
      results.push({ scenario, pass: false, failures: [`repo not found: ${repo}`] });
      console.log(`  ${emoji(false)} ${scenario.id} - repo not found`);
      continue;
    }
    const terminal = new PointerTerminal({ repo, approval, verbose: false });
    if (scenario.activeFile) terminal.setActiveFile(scenario.activeFile);
    const t0 = Date.now();
    let run;
    let verdict;
    try {
      run = await terminal.send(scenario.prompt, {
        mode: scenario.mode,
        approval,
        maxTurns: scenario.maxTurns ?? 12,
      });
      const expect = { ...(scenario.expect ?? {}), workspace: repo };
      if (scenario.mode === "ask") verdict = evaluateAsk(run, expect);
      else if (scenario.mode === "plan") verdict = evaluatePlan(run, expect);
      else verdict = evaluateAgent(run, terminal, expect);
    } catch (error) {
      verdict = { pass: false, failures: [`runtime: ${error.message}`] };
    }
    const ms = Date.now() - t0;
    results.push({ scenario, ms, ...verdict });
    console.log(`  ${emoji(verdict.pass)} ${scenario.id} (${ms}ms)`);
    for (const failure of verdict.failures ?? []) console.log(`     - ${failure}`);
  }
  const passes = results.filter((r) => r.pass).length;
  console.log(`\nTerminal suite total: ${passes}/${results.length} passed`);
  return results;
}

function selectedScenarios(suite = "real") {
  if (suite === "smoke") {
    return SCENARIOS.filter((s) =>
      ["express-ask-application", "express-ask-edit-redirect"].includes(s.id),
    );
  }
  if (suite === "real") return SCENARIOS;
  return SCENARIOS.filter((s) => s.id === suite || s.mode === suite);
}

function exportScenarios({ suite = "real", format = "jsonl" } = {}) {
  const scenarios = selectedScenarios(suite).map((s) => ({
    id: s.id,
    mode: s.mode,
    repo: s.repo,
    activeFile: s.activeFile ?? null,
    prompt: s.prompt,
    expectations: describeExpectations(s.expect ?? {}),
    pointerCommand:
      `node scripts/quality/pointerTerminal.mjs --repo=${JSON.stringify(s.repo).slice(1, -1)} ` +
      `--mode=${s.mode} --active=${JSON.stringify(s.activeFile ?? "").slice(1, -1)} ` +
      `--prompt=${JSON.stringify(s.prompt).slice(1, -1)}`,
  }));
  if (format === "json") {
    console.log(JSON.stringify(scenarios, null, 2));
    return;
  }
  for (const s of scenarios) console.log(JSON.stringify(s));
}

function describeExpectations(expect) {
  const out = {};
  if (expect.directEditRedirect) out.directEditRedirect = true;
  if (expect.includes) out.includes = expect.includes.map(String);
  if (expect.excludes) out.excludes = expect.excludes.map(String);
  if (expect.changed) out.changed = expect.changed;
  if (expect.unchanged) out.unchanged = expect.unchanged;
  if (expect.fileContains) {
    out.fileContains = Object.fromEntries(
      Object.entries(expect.fileContains).map(([k, v]) => [k, String(v)]),
    );
  }
  return out;
}

async function runSelfTest() {
  const fixture = new PointerTerminal({ repo: null, verbose: false });
  fixture.root = os.tmpdir();
  fixture.fs_ = new VirtualFs({
    "src/App.jsx": "export default function App() { return <main /> }\n",
    "src/components/Card.tsx": "export function Card() { return null }\n",
    "README.md": "# Demo\n",
  });
  fixture.baseline = fixture.fs_.snapshot();
  fixture.activeFile = "src/App.jsx";
  const mentions = inferImplicitFileReferences("Tell me about App.jsx and Card.tsx", {
    files: [...fixture.fs_.files.keys()],
    activePath: fixture.activeFile,
    openTabs: ["src/components/Card.tsx"],
    existingRefs: [],
  });
  const ok = mentions.includes("src/App.jsx") && mentions.includes("src/components/Card.tsx");
  console.log(`${emoji(ok)} implicit file reference resolution`);
  if (!ok) throw new Error(`self-test failed: ${mentions.join(", ")}`);
}

async function runInteractive(repo) {
  const terminal = new PointerTerminal({ repo, approval: "interactive" });
  console.log(bar("Interactive commands"));
  console.log("/mode ask|chat|plan|agent|agent-ask");
  console.log("/repo /path/to/repo");
  console.log("/open path/to/file");
  console.log("/ref path/to/file  |  /refs clear");
  console.log("/send your prompt");
  console.log("/execute");
  console.log("/diff");
  console.log("/status");
  console.log("/suite smoke|real|ask|plan|scenario-id");
  console.log("/quit");

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const line = await rl.question(`pointer:${terminal.mode}> `);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "/quit" || trimmed === "/exit") break;
      try {
        if (trimmed.startsWith("/mode ")) {
          terminal.setMode(trimmed.slice(6).trim());
        } else if (trimmed.startsWith("/repo ")) {
          terminal.loadRepo(trimmed.slice(6).trim());
        } else if (trimmed.startsWith("/open ")) {
          terminal.setActiveFile(trimmed.slice(6).trim());
        } else if (trimmed.startsWith("/ref ")) {
          terminal.addRef(trimmed.slice(5).trim());
        } else if (trimmed === "/refs clear") {
          terminal.clearRefs();
        } else if (trimmed === "/status") {
          terminal.status();
        } else if (trimmed === "/diff") {
          terminal.printDiff();
        } else if (trimmed === "/execute") {
          await terminal.executeLastPlan();
        } else if (trimmed.startsWith("/suite")) {
          const suite = trimmed.split(/\s+/)[1] ?? "smoke";
          await runScenarioSuite({ suite, approval: "auto" });
        } else if (trimmed.startsWith("/send ")) {
          await terminal.send(trimmed.slice(6));
        } else {
          await terminal.send(trimmed);
        }
      } catch (error) {
        console.error(`error: ${error.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

function formatToolCall(call) {
  const attrs = Object.keys(call.attrs ?? {}).length ? ` ${JSON.stringify(call.attrs)}` : "";
  const body = (call.body ?? "").trim();
  return `<${call.tool}${attrs}>${body ? `\n${body.slice(0, 2000)}\n` : ""}</${call.tool}>`;
}

function simpleDiff(before, after) {
  if (before === after) return "(unchanged)";
  const a = before.split("\n");
  const b = after.split("\n");
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const nextA = b[j] != null ? a.indexOf(b[j], i + 1) : -1;
    const nextB = a[i] != null ? b.indexOf(a[i], j + 1) : -1;
    if (nextA !== -1 && (nextB === -1 || nextA - i <= nextB - j)) {
      for (; i < nextA; i++) out.push(`- ${a[i]}`);
    } else if (nextB !== -1) {
      for (; j < nextB; j++) out.push(`+ ${b[j]}`);
    } else {
      if (i < a.length) out.push(`- ${a[i++]}`);
      if (j < b.length) out.push(`+ ${b[j++]}`);
    }
    if (out.length > 240) {
      out.push("... diff truncated ...");
      break;
    }
  }
  return out.join("\n") || "(changed)";
}

function stripQuotes(s) {
  return String(s).trim().replace(/^[`'"]+|[`'"]+$/g, "");
}

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function basename(p) {
  const normalized = normalizePath(p);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizePath(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+/g, "/");
}

function mergeUnique(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    const key = normalizePath(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1] ?? "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  if (hasFlag("--self-test")) {
    await runSelfTest();
    return;
  }
  const suite = argValue("--suite");
  const exportFormat = argValue("--export");
  const repo = argValue("--repo") ?? DEFAULT_REPO;
  const approval = argValue("--approval") ?? "auto";
  const prompt = argValue("--prompt");
  const mode = argValue("--mode") ?? "ask";
  if (exportFormat) {
    exportScenarios({ suite: suite ?? "real", format: exportFormat || "jsonl" });
    return;
  }
  if (suite) {
    const results = await runScenarioSuite({ suite, repoOverride: argValue("--repo"), approval });
    process.exit(results.every((r) => r.pass) ? 0 : 1);
  }
  if (prompt) {
    const terminal = new PointerTerminal({ repo, approval, verbose: true });
    const active = argValue("--active");
    if (active) terminal.setActiveFile(active);
    const result = await terminal.send(prompt, { mode, approval });
    if (mode === "ask" || mode === "chat") {
      const verdict = evaluateAsk(result, DIRECT_EDIT_RE.test(prompt) ? { directEditRedirect: true } : {});
      if (!verdict.pass) {
        console.error(verdict.failures.join("\n"));
        process.exit(1);
      }
    }
    return;
  }
  await runInteractive(repo);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

export {
  PointerTerminal,
  evaluateAgent,
  evaluateAsk,
  evaluatePlan,
  inferImplicitFileReferences,
  loadRepoSnapshot,
  runScenarioSuite,
};
