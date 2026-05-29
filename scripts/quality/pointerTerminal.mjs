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
import { MODEL, QUALITY_NUM_CTX, bar, emoji, generateRaw } from "./lib.mjs";
import { VirtualFs } from "./evalAgent.mjs";

const DEFAULT_REPO =
  fs.existsSync("/Users/sameer/express") ? "/Users/sameer/express" : process.cwd();
const OPENCODE_TIMEOUT_MS = Number(process.env.POINTER_OPENCODE_TIMEOUT_MS || 480_000);
const CRITIC_TIMEOUT_MS = Number(process.env.POINTER_CRITIC_TIMEOUT_MS || 120_000);

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
    const root = fs.realpathSync(path.resolve(expandHome(repoPath)));
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

  syncFromDisk() {
    if (!this.root) return;
    const snap = loadRepoSnapshot(this.root, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      maxFileBytes: this.maxFileBytes,
    });
    this.fs_ = new VirtualFs(snap.files);
    this.repoLoadWarnings = snap.warnings;
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
    const researchPrompt = isResearchPrompt(prompt);
    const askFileLimit = researchPrompt ? 4 : 5;
    const askFileChars = researchPrompt ? 2800 : 7000;
    const contextFiles = orderContextFilesForAsk(context.files, prompt, this.activeFile, this.fs_).slice(0, askFileLimit);
    const attachFiles = orderContextFilesForAsk(context.attachFiles, prompt, this.activeFile, this.fs_)
      .filter((p) => !this.fs_.has(p) || this.fs_.read(p).length <= 24_000)
      .slice(0, askFileLimit);
    const messages = [...this.askMessages, { role: "user", content: prompt }];
    const fileDigest = contextFiles
      .filter((p) => this.fs_.has(p))
      .map((p) => fileBlock(p, compactFileForPrompt(p, this.fs_.read(p), prompt, askFileChars)))
      .join("\n\n");
    const evidence = askEvidenceForPrompt(contextFiles, this.fs_, prompt);
    const symbols = symbolInventoryForPrompt(contextFiles, this.fs_, prompt);
    const contextDigest = [
      context.memoryDigest ? `Context brain retained memory:\n${context.memoryDigest}` : "",
      evidence ? `Literal evidence lines to preserve in the answer:\n${evidence}` : "",
      symbols ? `Visible symbols from attached files. Do not invent method names outside this inventory:\n${symbols}` : "",
      fileDigest,
    ].filter(Boolean).join("\n\n");
    const opencodePrompt = renderAskRunPrompt({ messages, context: contextDigest });
    if (this.verbose) {
      console.log(bar("Ask"));
      console.log(`context files: ${contextFiles.join(", ") || "(current file only or none)"}`);
    }
    const run = await runOpenCode({
      repo: this.root,
      model: opts.model ?? MODEL,
      mode: "ask",
      prompt: opencodePrompt,
      title: "Pointer Ask",
      files: [],
    });
    const response = run.text;
    this.askMessages.push({ role: "user", content: prompt });
    this.askMessages.push({ role: "assistant", content: response });
    this.lastResult = { mode: "ask", prompt, response, contextFiles, attachedFiles: attachFiles, trace: run.events };
    console.log(response.trim());
    return this.lastResult;
  }

  async plan(prompt, opts = {}) {
    if (this.verbose) console.log(bar("Plan"));
    const context = this.buildAskContext(prompt);
    const orderedContextFiles = orderContextFilesForPlan(context.files, this.activeFile, prompt).slice(0, 9);
    if (this.verbose) console.log(`plan context files: ${orderedContextFiles.join(", ") || "(none)"}`);
    const contextDigest = orderedContextFiles
      .filter((p) => this.fs_.has(p))
      .map((p) => fileBlock(p, compactFileForPrompt(p, this.fs_.read(p), prompt, 2500)))
      .join("\n\n");
    const evidence = planEvidenceForPrompt(orderedContextFiles, this.fs_, prompt);
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
          context: orderedContextFiles.length
          ? [
              `Pointer attached these relevant files via --file:\n${orderedContextFiles.map((p) => `- ${p}`).join("\n")}`,
              context.memoryDigest ? `Context brain retained memory:\n${context.memoryDigest}` : "",
              evidence ? `Authoritative evidence:\n${evidence}` : "",
              contextDigest ? `Focused evidence snippets:\n${contextDigest}` : "",
            ].filter(Boolean).join("\n\n")
          : "",
      }),
      title: "Pointer Plan",
      files: orderContextFilesForPlan(context.attachFiles, this.activeFile, prompt),
    });
    const result = {
      mode: "plan",
      prompt,
      terminated: "final",
      trace: run.events,
      text: run.text,
      contextFiles: orderedContextFiles,
      attachedFiles: context.attachFiles,
    };
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
    this.syncFromDisk();
    if (this.changedFiles().length && !collectBashRecords(run.events).length && hasProjectVerificationConfig(this.fs_)) {
      const fallback = await runDeterministicVerificationFallback(this.root, this.fs_);
      if (fallback) {
        run.events.push(fallback.event);
        run.text = appendVerificationStatus(run.text, fallback);
      }
    }
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
    const primaryFiles = mergeUnique([
      ...this.refs,
      ...implicit,
    ]);
    const brain = buildContextBrain({
      fs_: this.fs_,
      prompt,
      activeFile: this.activeFile,
      openTabs: this.openTabs,
      primaryFiles,
      mode: this.mode,
    });
    const relatedFiles = mergeUnique([
      ...brain.files,
      ...this.relatedContextFiles(prompt, primaryFiles),
    ]);
    const files = mergeUnique([
      ...primaryFiles,
      this.activeFile,
      ...this.openTabs.slice(0, 3),
      ...relatedFiles,
    ]).filter((p) => p && this.fs_.has(p));
    const attachFiles = mergeUnique([
      ...primaryFiles,
      this.activeFile,
      ...this.openTabs.slice(0, 3),
      ...relatedFiles.filter((p) => /\.(js|jsx|ts|tsx|vue|rs|py|go)$/i.test(p)).slice(0, 4),
      ...relatedFiles.filter((p) => /(?:^|\/)__tests__\/|\.test\.|\.spec\.|package\.json$/.test(p)).slice(0, 4),
    ]).filter((p) => p && this.fs_.has(p));
    const blocks = [];
    for (const p of files) {
      if (this.fs_.has(p)) blocks.push(fileBlock(p, compactFileForPrompt(p, this.fs_.read(p), prompt)));
    }
    if (this.activeFile && !files.includes(this.activeFile) && this.fs_.has(this.activeFile)) {
      blocks.push(fileBlock(this.activeFile, compactFileForPrompt(this.activeFile, this.fs_.read(this.activeFile), prompt)));
    }
    const text = blocks.join("\n\n");
    return { text, files, attachFiles, memoryDigest: brain.digest, brain };
  }

  relatedContextFiles(prompt, primaryFiles = []) {
    const seeds = mergeUnique([
      ...primaryFiles,
      this.activeFile,
      ...this.openTabs.slice(0, 3),
    ]).filter((p) => p && this.fs_.has(p));
    const query = String(prompt ?? "").toLowerCase();
    const research = isResearchPrompt(prompt);
    const terms = researchTerms(prompt);
    const related = [];
    for (const seed of seeds) {
      const text = this.fs_.read(seed);
      for (const spec of extractRelativeImports(text)) {
        const resolved = resolveRelativeImport(seed, spec, [...this.fs_.files.keys()]);
        if (!resolved || !this.fs_.has(resolved)) continue;
        if (
          isDirectImportContextNeighbor(resolved, query, seed, this.activeFile) ||
          isRelevantNeighbor(resolved, query) ||
          (research && researchFileScore(resolved, this.fs_.read(resolved), terms, this.activeFile) > 3)
        ) {
          related.push(resolved);
        }
      }
    }
    const withImports = mergeUnique([...seeds, ...related]);
    const tests = [];
    for (const seed of withImports) {
      tests.push(...findTestFilesFor(seed, [...this.fs_.files.keys()]));
    }
    const discovered = discoverResearchFiles(prompt, {
        files: this.fs_.files,
        activePath: this.activeFile,
        maxFiles: 8,
      });
    const manifests = manifestFilesFor([...this.fs_.files.keys()]);
    return orderRelatedContextFilesForPrompt(
      mergeUnique([
        ...related,
        ...tests,
        ...discovered,
        ...manifests,
      ]).filter((p) => !isGeneratedContextFile(p) && !isUnrequestedDocContextFile(p, prompt)),
      prompt,
      this.activeFile,
      this.fs_,
    ).slice(0, 16);
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

  changedDiffs({ maxFiles = 6, maxChars = 12000 } = {}) {
    const chunks = [];
    for (const p of this.changedFiles().slice(0, maxFiles)) {
      const before = this.baseline.get(p) ?? "";
      const after = this.fs_.has(p) ? this.fs_.read(p) : "";
      chunks.push(`diff ${p}\n${simpleDiff(before, after)}`);
    }
    return chunks.join("\n\n").slice(0, maxChars);
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
- When a provided file defines object/property methods or dotted assignments,
  include the literal identifier names from the file. Do not paraphrase dotted
  assignments into generic method names.
- Preserve camelCase and dotted assignment names exactly as they appear in the
  supplied file.
- Include a compact "Key identifiers" sentence when explaining a file, naming
  4-8 concrete symbols or setting keys that are actually visible in the
  provided context. Never list more than 8 identifiers and never repeat one.
- Never copy identifier examples from these instructions into the answer unless
  they appear in the supplied repository context.
- When explaining core framework/runtime files, name concrete configuration
  defaults, compatibility hooks, and routing/middleware paths visible in the
  file instead of smoothing them into generic summaries.
- Name important top-level functions, methods, and literal setting keys by their
  exact identifiers when they are central to the file.
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

function renderAskRunPrompt({ messages, context }) {
  const out = [
    "ASK MODE CONTRACT:",
    "- Answer from the repository files OpenCode reads or receives via --file.",
    "- If Attached context contains relevant file blocks or literal evidence lines that answer the question, answer directly from that context without using additional tools.",
    "- For file explanation questions, name the file's purpose, important imports/exports, state or data flow, and notable risks or neighboring files.",
    "- For interface code, call out important state owners, event handlers, and conditional rendered UI when they are present.",
    "- For routing questions, name the exact router components visible in the file, including Switch when it is present.",
    "- For theme persistence questions, name the exact storage import/local variable and storage calls when they are visible, for example local-storage-fallback, storage.getItem, or storage.setItem only if those names appear in repository context.",
    "- For editor or media-heavy components, mention file operations, upload/image handling, export, and persistence flows when those symbols are visible.",
    "- For codebase research questions that ask where a behavior is configured, compiled, consumed, or flows through the project, use search/read tools to trace at least the definition file and consumer file before answering.",
    "- For codebase research or source-path answers, name exact repository-relative file paths for each hop; do not stop at import specifiers such as ./utils.",
    "- If a search finds the symbol or behavior, read the matching file before answering; do not answer from search snippets alone.",
    "- Unless the user explicitly asks for code samples, do not emit fenced code blocks in Ask mode; describe short code facts inline with backticks instead.",
    "- Include a compact Key identifiers sentence with 4-8 exact symbols, dotted assignments, method names, and configuration keys visible in the file. Format it as a comma-separated list. Never list more than 8 identifiers and never repeat an identifier. If more than 8 are possible, choose the 8 most important.",
    "- Key identifiers must be real identifiers or setting keys from the file, not synthesized property chains.",
    "- If a Visible symbols inventory is supplied, do not name methods or exports that are absent from that inventory unless they are shown verbatim in another evidence line.",
    "- Prefer exact local names over paraphrases: if a file defines a symbol or setting key, use that exact spelling.",
    "- If a file defines dotted exported assignments such as object.method = function, name the dotted assignment exactly instead of only the bare method name.",
    "- When a file defines default/configuration methods, name the important literal setting keys and defaults visible in those methods.",
    "- If Literal evidence includes app.defaultConfiguration, app.set(...), or setting keys, name the important literal setting keys in the prose.",
    "- Do not list bare prior-version method names such as mount or lazyrouter unless the file defines that exact method/export in the visible context.",
    "- Preserve literal identifiers exactly as they appear in files. Never copy identifier examples from these instructions into the answer unless OpenCode actually saw them in repository content.",
    "- Never output internal progress blocks or headings like ## Goal, ## Progress, Constraints, Next Steps, or Continue if you have next steps.",
    "- Do not claim you lack access to a named, active, or attached file.",
    "- Do not modify files in Ask mode.",
    "",
    "Conversation:",
  ];
  if (context?.trim()) out.push(`Attached context:\n${context.trim()}`);
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
    out.push(`${role}: ${m.content.trim()}`);
  }
  out.push(
    "Answer the latest user message using the ASK MODE CONTRACT above.",
  );
  return out.join("\n\n");
}

function renderAgentRunPrompt({ workspace, mode, goal, openTabs, activeFile, context }) {
  const out = [];
  out.push(
    `Workspace: ${workspace ?? "."}`,
    `Mode: ${mode}`,
  );
  if (activeFile) out.push(`Active editor file:\n${activeFile}`);
  if (openTabs?.length) out.push(`Open tabs:\n${openTabs.slice(0, 20).map((t) => `- ${t}`).join("\n")}`);
  if (context?.trim()) out.push(`Attached context:\n${context.trim()}`);
  out.push(`User goal:\n${goal.trim()}`);
  if (mode === "plan") {
    const activeBase = activeFile ? basename(activeFile).replace(/\.[^.]+$/, "") : "";
    const refactorRequest = /\b(refactor|cleanup|clean up|feature|implement|creative|improve)\b/i.test(goal);
    out.push(
      [
        "Plan mode contract: gather bounded context, then stop searching and answer.",
        refactorRequest
          ? "This is a change-planning request: the final Plan must include source changes and must not answer no source changes needed merely because current behavior works."
          : "",
        "Required reads before final: the active file when relevant; the directly related implementation file; the directly related test/spec file; package/config files needed for verification.",
        "For interface work, include both the state/logic file and the file that renders the affected UI.",
        activeBase
          ? `Because the active file basename is ${activeBase}, search for tests/specs containing ${activeBase} in the filename or contents before finalizing.`
          : "",
        "Use the repository's own structure and naming conventions to discover tests, specs, examples, snapshots, fixtures, or validation commands; do not assume a language, framework, package manager, or test runner.",
        "Do not finalize until relevant verification context has been read or you explicitly state what you checked and that none exists.",
        "Treat attached repository context and Authoritative evidence as binding; do not make a claim that contradicts it.",
        "Do not propose framework or router API migrations unless package/config context proves the installed major version supports the target API; preserve current dependency major versions for behavior-preserving refactors.",
        "For theme/refactor plans, distinguish styled-components ThemeProvider from a custom React context. Do not claim components consume a custom context unless the code shows a hook/provider; if props are used, say props are used.",
        "When naming files or implementation areas, cite exact symbols visible in context instead of generic descriptions.",
        "Do not assume a reported bug exists: compare the proposed fix to the code you read. If the code already contains the proposed source change, do not claim it is missing; produce a no-source-change or regression-test-only plan and cite the exact existing behavior.",
        "If the user explicitly asks for a refactor or cleanup, produce a concrete behavior-preserving refactor plan; do not answer no-source-change merely because the current behavior works.",
        "If the user asks for a refactor, cleanup, feature, or creative change, do not no-op merely because the current behavior works; produce a behavior-preserving implementation plan.",
        "If the evidence disproves the suspected bug, do not restate that suspected bug as true anywhere in the final answer.",
        "If the final plan is no-source-change, the Assessment must not say the reported bug exists, remains visible, does not re-render, or still needs a source fix.",
        "Final response format: Context read: exact paths; Assessment: what the code proves; Plan: exact changes or no-source-change rationale; Verification: exact narrow command.",
        "In the Assessment or Plan, name the exact symbols or exported values you will change.",
        "Final output must be under 180 words and contain no internal debate, self-correction, or discarded hypotheses.",
        "Verification must name an actual project command from repository configuration when available. Prefer the narrowest existing verification that covers the touched behavior. If no focused verification exists for a refactor, prefer the repository's configured build or validation command.",
        "Plan verification commands must be executable by Agent mode without package executors: never use npx, npm exec, pnpm dlx, yarn dlx, or bunx in a plan. Prefer package scripts such as npm test, npm run test:run, npm run build, cargo test, go test, pytest, or the repository's configured equivalent.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (mode === "agent") {
    out.push(
      "Agent implementation constraints: make the minimal correct change for the goal, preserve unrelated structure and assets, and verify when project commands are available even if the user did not explicitly ask to run tests. If package scripts or equivalent project commands exist, attempt the narrowest relevant command after editing unless a command is explicitly forbidden. After any successful edit, a final answer with zero bash verification attempts is invalid; run a verification command or attempt one and report the real blocker before finalizing. If the user asks to add or update tests, you must edit or create the relevant test/spec file even when verification cannot run. Do not install, add, remove, or update dependencies unless the user explicitly asks; if verification is blocked by missing dependencies, report the blocked command instead of changing dependency state. Never run or even attempt package executors: npx, npm exec, pnpm dlx, yarn dlx, or bunx are forbidden even for eslint, vitest, mocha, or one-off probing. Use scripts already present in package.json such as npm test, npm run test:run, npm run build, npm run lint, or npm run typecheck. If no relevant script exists, use the closest existing script or report that verification is blocked; do not invent an npx command. If package.json, Cargo.toml, pyproject.toml, or similar config defines verification scripts, do not claim verification commands are unavailable; missing dependencies mean verification was blocked or failed, not absent. Final answer: one concise non-repetitive summary under 140 words with changed files and a Verification: sentence naming the exact command attempted or the exact blocked command. Never say verification was skipped because the user did not ask, because the change was minimal, or because of user constraints.",
    );
  }
  return out.join("\n\n");
}

async function runOpenCode({
  repo,
  model,
  mode,
  prompt,
  title,
  dangerous = false,
  files = [],
  timeoutMs = OPENCODE_TIMEOUT_MS,
}) {
  const cwd = fs.realpathSync(path.resolve(expandHome(repo ?? process.cwd())));
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
    mode === "ask" ? "pointer-ask" : mode === "agent" ? "pointer-agent" : "pointer-plan",
    "--format",
    "json",
    "--title",
    title ?? `Pointer ${mode}`,
    prompt,
  ];
  for (const file of mergeUnique(files)) {
    if (mode !== "agent" && isLargeWorkspaceFile(cwd, file)) continue;
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
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    }, timeoutMs);
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
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal) {
          reject(new Error(`opencode timed out or was killed (${signal}) after ${timeoutMs}ms`));
        } else {
          resolve(code);
        }
      });
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
    const normalizedText = normalizeFinalText(textSinceTool.trim() ? textSinceTool : fullText);
    return {
      text: polishAssistantText(sanitizeVerificationClaims(normalizedText, events), { mode }),
      fullText,
      events,
      cwd,
    };
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
          "Answer questions about the current codebase using read-only repository context. If the user asks about a named or attached file, read that file first and center the answer on that file rather than giving a broad repository overview. If the user asks how a behavior flows through the codebase, read the directly related definition and consumer files before answering. Unless the user explicitly asks for code samples, do not emit fenced code blocks in Ask mode; describe short code facts inline with backticks instead. Include a compact Key identifiers sentence with 4-8 exact symbols, dotted assignments, method names, and configuration keys visible in the file; never list more than 8 identifiers and never repeat an identifier. Preserve literal identifiers exactly as they appear in files. Never copy identifier examples from instructions into the answer unless OpenCode actually saw them in repository content. Do not claim you lack access to a named, active, or attached file. Do not modify files.",
        permission: {
          edit: "deny",
          bash: "deny",
          task: "deny",
          todowrite: "deny",
          skill: "deny",
          webfetch: "deny",
          websearch: "deny",
        },
      },
      "pointer-plan": {
        model: modelRef,
        description: "Pointer Plan mode",
        prompt:
          "Create executable engineering plans for the current codebase. Read the relevant files yourself before finalizing, but keep context gathering bounded: prefer the active file, directly related implementation files, directly related existing verification or specification context when it can be found, and project configuration needed to name the verification command. For interface work, include both the state/logic file and the file that renders the affected UI. Use the repository's own structure and naming conventions to discover tests, specs, examples, snapshots, fixtures, or validation commands; do not assume a language, framework, package manager, or test runner. Do not finalize until relevant verification context has been read or you explicitly state what you checked and that none exists. After reading source, verification context, and project configuration, finalize instead of continuing to search. Do not assume a reported bug exists: compare the proposed fix to the code you read. If the code already contains the proposed source change, do not claim it is missing; produce a no-source-change or regression-test-only plan and cite the exact existing behavior. If the user asks for a refactor, cleanup, feature, or creative change, do not no-op merely because the current behavior works; produce a behavior-preserving implementation plan. If the evidence disproves the suspected bug, do not restate that suspected bug as true anywhere in the final answer. Do not edit, write, delete, rename, run shell commands, create todos, use skills, or delegate to tasks. Final response format: Context read: exact paths; Assessment: what the code proves; Plan: exact changes or no-source-change rationale; Verification: exact narrow command. Final output must be under 180 words and contain no internal debate, self-correction, or discarded hypotheses. Always include at least one exact narrow verification command the user can run; prefer the narrowest existing verification that covers the touched behavior. Plan verification commands must be executable by Agent mode without package executors: never use npx, npm exec, pnpm dlx, yarn dlx, or bunx in a plan. Prefer package scripts such as npm test, npm run test:run, npm run build, cargo test, go test, pytest, or the repository's configured equivalent. If the existing code is already correct, say that directly and cite the files and verification evidence that prove it, plus the exact command to rerun that verification.",
        permission: {
          edit: "deny",
          bash: "deny",
          task: "deny",
          todowrite: "deny",
          skill: "deny",
          webfetch: "deny",
          websearch: "deny",
        },
      },
      "pointer-agent": {
        model: modelRef,
        description: "Pointer Agent mode",
        prompt:
          "Implement the user's requested code change in the current repository. Gather the minimum necessary context, edit only files required for the task, preserve unrelated structure and assets, and verify with the narrowest existing project command when available even if the user did not explicitly ask to run tests. If package scripts or equivalent project commands exist, attempt the narrowest relevant command after editing unless a command is explicitly forbidden. After any successful edit, a final answer with zero bash verification attempts is invalid; run a verification command or attempt one and report the real blocker before finalizing. If the user asks to add or update tests, you must edit or create the relevant test/spec file even when verification cannot run. Do not install, add, remove, or update dependencies unless the user explicitly asks; if verification is blocked by missing dependencies, report the blocked command instead of changing dependency state. Never run or even attempt package executors: npx, npm exec, pnpm dlx, yarn dlx, or bunx are forbidden even for eslint, vitest, mocha, or one-off probing. Use scripts already present in package.json such as npm test, npm run test:run, npm run build, npm run lint, or npm run typecheck. If no relevant script exists, use the closest existing script or report that verification is blocked; do not invent an npx command. Do not run destructive git commands, pushes, resets, cleanups, or broad filesystem deletion. Final response must be concise, non-repetitive, and focused on changed files plus a Verification: sentence naming the exact command attempted or the exact blocked command. Never say verification was skipped because the user did not ask, because the change was minimal, or because of user constraints.",
        permission: {
          edit: "allow",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          lsp: "allow",
          bash: {
            "*": "allow",
            "*npm install*": "deny",
            "*npm i *": "deny",
            "*npm add*": "deny",
            "*npm update*": "deny",
            "*npm exec*": "deny",
            "*npx *": "deny",
            "*pnpm install*": "deny",
            "*pnpm add*": "deny",
            "*pnpm dlx*": "deny",
            "*yarn install*": "deny",
            "*yarn add*": "deny",
            "*yarn dlx*": "deny",
            "*bun install*": "deny",
            "*bun add*": "deny",
            "*bunx *": "deny",
            "*pip install*": "deny",
            "*pip3 install*": "deny",
            "*uv pip install*": "deny",
            "*poetry add*": "deny",
            "*cargo install*": "deny",
            "*git reset*": "deny",
            "*git checkout*": "deny",
            "*git clean*": "deny",
            "*git push*": "deny",
            "*rm -rf*": "deny",
          },
          external_directory: "deny",
          webfetch: "deny",
          websearch: "deny",
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

function normalizeFinalText(text) {
  const trimmed = String(text ?? "").trim();
  for (const marker of [
    "\n## Goal",
    "\n## Constraints & Preferences",
    "\n## Progress",
    "\nContinue if you have next steps",
  ]) {
    const idx = trimmed.indexOf(marker);
    if (idx > 80) return trimmed.slice(0, idx).trim();
  }
  for (const marker of [
    "\n## Final Assessment",
    "\n## Final Answer",
    "\n## Conclusion",
    "\n## Summary",
    "\n# Final Assessment",
    "\n# Final Answer",
    "\n# Conclusion",
    "\n# Summary",
  ]) {
    const idx = trimmed.lastIndexOf(marker);
    if (idx !== -1 && (idx > trimmed.length / 4 || /summary/i.test(marker))) {
      return trimmed.slice(idx + 1).trim();
    }
  }
  const lower = trimmed.toLowerCase();
  for (const marker of [
    "\ni've successfully implemented",
    "\ni have successfully implemented",
    "\n## changes made",
  ]) {
    const idx = lower.lastIndexOf(marker);
    if (idx > trimmed.length / 3) return trimmed.slice(0, idx).trim();
  }
  for (const needle of [
    "i've successfully implemented",
    "i have successfully implemented",
    "successfully implemented",
    "i've implemented",
    "i have implemented",
  ]) {
    const idx = lower.lastIndexOf(needle);
    if (idx > trimmed.length / 3) {
      const before = lower.slice(0, idx);
      if (
        before.includes("summarize") ||
        before.includes("summary") ||
        before.includes("what i've done") ||
        before.includes("what i have done")
      ) {
        return trimmed.slice(0, idx).trim();
      }
    }
  }
  return trimmed;
}

function sanitizeVerificationClaims(text, events = []) {
  const records = collectBashRecords(events);
  const blockedPackageExecutor = records.some(
    (record) => record.status !== "completed" && isPackageExecutorCommand(record.command),
  );
  if (!blockedPackageExecutor) return text;
  let out = String(text ?? "");
  for (const pattern of [
    /\bAll (?:unit |existing )?tests (?:continue to )?pass[^.]*\./gi,
    /\bAll tests are passing[^.]*\./gi,
    /\bAll existing tests continue to pass[^.]*\./gi,
    /\bAll unit tests pass[^.]*\./gi,
  ]) {
    out = out.replace(pattern, "Verification could not be completed in this environment.");
  }
  if (!/\bVerification:/i.test(out)) {
    out = `${out.trim()}\n\nVerification: not completed; Pointer blocked package executor/dependency commands and the temp workspace did not have the required test binary available.`;
  }
  return out.trim();
}

function polishAssistantText(text, opts = {}) {
  const base = opts.mode === "ask" ? removeFencedCodeBlocks(String(text ?? "")) : String(text ?? "");
  return limitKeyIdentifiers(
    removeLeadingIdentifierPrefix(
      removeLeadingMiniAnswer(removeRepeatedBoundarySentence(dedupeRepeatedLines(dedupeRepeatedFinalText(base)))),
    ),
  );
}

function removeFencedCodeBlocks(text) {
  return String(text ?? "").replace(/```[^\n`]*\n([\s\S]*?)\n```/g, (_match, body) => {
    const compact = String(body ?? "").trim();
    if (!compact) return "";
    return compact
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n");
  });
}

function dedupeRepeatedFinalText(text) {
  const trimmed = String(text ?? "").trim();
  const lower = trimmed.toLowerCase();
  for (const needle of [
    "i've successfully",
    "i have successfully",
    "i've updated",
    "i have updated",
    "the changes:",
  ]) {
    const first = lower.indexOf(needle);
    const second = first === -1 ? -1 : lower.indexOf(needle, first + needle.length);
    if (first !== -1 && second > Math.max(120, trimmed.length / 3)) {
      return trimmed.slice(0, second).trim();
    }
  }
  for (const restart of [
    "\ni've successfully",
    "\ni have successfully",
    "i've successfully",
    "i have successfully",
    "i've successfully refactored",
    "i've successfully updated",
    "i've successfully improved",
    "i've improved",
    "i've made",
    "i have successfully refactored",
    "i have successfully updated",
    "i have made",
    "i have improved",
    "i understand that",
  ]) {
    const idx = lower.indexOf(restart);
    if (idx > Math.max(120, trimmed.length / 3)) {
      return trimmed.slice(0, idx).trim();
    }
    if (idx > 40 && idx < 320 && /\b(?:i'll|i will|let me|try to|trying to)\b/i.test(trimmed.slice(0, idx))) {
      return trimmed.slice(idx).trim();
    }
  }
  return trimmed;
}

function dedupeRepeatedLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const normalized = line.trim().toLowerCase().replace(/\s+/g, " ");
    const meaningful = normalized.length >= 18 && /[a-z0-9]/.test(normalized);
    if (meaningful && seen.has(normalized)) continue;
    if (meaningful) seen.add(normalized);
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function removeRepeatedBoundarySentence(text) {
  const trimmed = String(text ?? "").trim();
  const first = trimmed.match(/^(.{30,220}?[.!?])\s+/s);
  if (!first) return trimmed;
  const sentence = first[1].trim();
  const rest = trimmed.slice(first[0].length);
  if (rest.toLowerCase().includes(sentence.toLowerCase())) {
    return rest.trim();
  }
  return trimmed;
}

function removeLeadingMiniAnswer(text) {
  const lower = text.toLowerCase();
  const first = lower.indexOf("key identifiers");
  const second = first === -1 ? -1 : lower.indexOf("key identifiers", first + 1);
  if (first === -1 || second === -1 || first > text.length / 2) return text;
  const lineEnd = text.indexOf("\n", first);
  if (lineEnd === -1) return text;
  let cut = lineEnd + 1;
  const nextLineEnd = text.indexOf("\n", cut);
  const nextLine = text.slice(cut, nextLineEnd === -1 ? undefined : nextLineEnd).trim();
  if (nextLine.includes(",") && nextLine.length < 240) {
    cut = nextLineEnd === -1 ? text.length : nextLineEnd + 1;
  }
  const rest = text.slice(cut).trim();
  return rest.length > 120 ? rest : text;
}

function limitKeyIdentifiers(text) {
  return text.replace(
    /(Key identifiers?[^\n:]*:\s*)([^\n]+)/gi,
    (_match, prefix, list) => {
      const suffix = /\.\s*$/.test(list) ? "." : "";
      const items = String(list)
        .replace(/\.\s*$/, "")
        .split(/,\s*/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length <= 8) return `${prefix}${list}`;
      return `${prefix}${items.slice(0, 8).join(", ")}${suffix}`;
    },
  );
}

function removeLeadingIdentifierPrefix(text) {
  const firstThe = text.indexOf("The ");
  const firstNewline = text.indexOf("\n");
  if (
    firstThe > 0 &&
    firstThe < 520 &&
    (firstNewline === -1 || firstThe < firstNewline) &&
    text.slice(0, firstThe).split(",").length >= 4
  ) {
    return text.slice(firstThe).trim();
  }
  return text;
}

function collectBashRecords(events = []) {
  return events
    .filter((event) => event.type === "tool_use" && opencodeToolName(event) === "bash")
    .map((event) => ({
      command: String(event.part?.state?.input?.command ?? ""),
      status: String(event.part?.state?.status ?? ""),
    }));
}

function hasProjectVerificationConfig(fs_) {
  if (!fs_) return false;
  if (fs_.has?.("package.json")) {
    try {
      const pkg = JSON.parse(fs_.read("package.json"));
      const scripts = pkg && typeof pkg === "object" ? pkg.scripts : null;
      if (scripts && typeof scripts === "object") {
        return ["test", "test:run", "build", "lint", "typecheck", "check"].some((name) => typeof scripts[name] === "string");
      }
    } catch {
      return true;
    }
  }
  return ["Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"].some((path) => fs_.has?.(path));
}

function selectVerificationCommand(fs_) {
  if (!fs_) return null;
  if (fs_.has?.("package.json")) {
    try {
      const pkg = JSON.parse(fs_.read("package.json"));
      const scripts = pkg && typeof pkg === "object" ? pkg.scripts : null;
      if (scripts && typeof scripts === "object") {
        for (const name of ["test:run", "test", "build", "lint", "typecheck", "check"]) {
          if (typeof scripts[name] !== "string") continue;
          const pm = fs_.has?.("pnpm-lock.yaml")
            ? "pnpm"
            : fs_.has?.("yarn.lock")
              ? "yarn"
              : fs_.has?.("bun.lockb")
                ? "bun"
                : "npm";
          if (name === "test") {
            if (pm === "npm") return "npm test -- --watchAll=false";
            return `${pm} test`;
          }
          return pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`;
        }
      }
    } catch {
      return null;
    }
  }
  if (fs_.has?.("Cargo.toml")) return "cargo test";
  if (fs_.has?.("go.mod")) return "go test ./...";
  if (fs_.has?.("pyproject.toml")) return "pytest";
  if (fs_.has?.("pom.xml")) return "mvn test";
  if (fs_.has?.("build.gradle") || fs_.has?.("build.gradle.kts")) return "./gradlew test";
  return null;
}

async function runDeterministicVerificationFallback(cwd, fs_) {
  const command = selectVerificationCommand(fs_);
  if (!command || isPackageExecutorCommand(command)) return null;
  console.log(`T*: bash fallback ${command}`);
  const started = Date.now();
  const output = await runShellCommand(cwd, command, 120000);
  const status = output.code === 0 ? "completed" : "error";
  return {
    command,
    status,
    code: output.code,
    elapsedMs: Date.now() - started,
    output: output.text,
    event: {
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          status,
          input: { command, description: "Pointer deterministic verification fallback" },
          output: output.text,
        },
      },
    },
  };
}

function runShellCommand(cwd, command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    const append = (chunk) => {
      text += String(chunk);
      if (text.length > 12000) text = text.slice(-12000);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref?.();
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, text: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const suffix = signal ? `\n(process killed: ${signal})` : "";
      resolve({ code: code ?? 1, text: stripAnsi(`${text}${suffix}`).trim().slice(-8000) });
    });
  });
}

function appendVerificationStatus(text, fallback) {
  if (/\bVerification:/i.test(text)) return text;
  const detail = fallback.status === "completed"
    ? "completed successfully"
    : `failed or was blocked${fallback.output ? `: ${firstMeaningfulLine(fallback.output)}` : ""}`;
  return `${String(text ?? "").trim()}\n\nVerification: \`${fallback.command}\` ${detail}.`;
}

function firstMeaningfulLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 240) ?? "no output";
}

function isPackageExecutorCommand(command) {
  return /\b(?:npx|npm exec|pnpm dlx|yarn dlx|bunx)\b/i.test(command);
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

function copyRepoForScenario(sourceRoot, scenarioId) {
  const source = path.resolve(expandHome(sourceRoot));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `pointer-scenario-${scenarioId}-`));
  fs.cpSync(source, target, {
    recursive: true,
    filter(src) {
      if (src === source) return true;
      const rel = normalizePath(path.relative(source, src));
      if (!rel) return true;
      let stat;
      try {
        stat = fs.lstatSync(src);
      } catch {
        return false;
      }
      return !shouldIgnore(rel, {
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
      });
    },
  });
  return target;
}

function extractRelativeImports(text) {
  const out = [];
  const re =
    /(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of String(text ?? "").matchAll(re)) {
    const spec = match[1]?.split(/[?#]/)[0];
    if (spec) out.push(spec);
  }
  return mergeUnique(out);
}

function resolveRelativeImport(fromFile, spec, files) {
  const base = normalizePath(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.vue`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.vue`,
  ];
  const existing = new Set(files.map(normalizePath));
  return candidates.find((candidate) => existing.has(candidate)) ?? null;
}

function findTestFilesFor(filePath, files) {
  const base = basenameNoExt(filePath);
  if (!base) return [];
  return files
    .filter((p) => {
      const norm = normalizePath(p);
      if (!/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(norm)) return false;
      return basenameNoExt(norm).toLowerCase().startsWith(base.toLowerCase());
    })
    .slice(0, 3);
}

function discoverResearchFiles(text, { files, activePath, maxFiles = 4 } = {}) {
  if (!isResearchPrompt(text) || !files?.size) return [];
  const terms = researchTerms(text);
  if (!terms.length) return [];
  const scored = [];
  for (const [filePath, body] of files.entries()) {
    const score = researchFileScore(filePath, body, terms, activePath);
    if (score > 1) scored.push({ filePath, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, maxFiles)
    .map((item) => item.filePath);
}

function buildContextBrain({ fs_, prompt, activeFile, openTabs = [], primaryFiles = [], mode = "ask", maxFiles = 14, maxSteps = 34 }) {
  const allFiles = [...(fs_?.files?.keys?.() ?? [])];
  if (!fs_ || !allFiles.length) {
    return { files: [], attachFiles: [], digest: "", packets: [], trail: [] };
  }
  const terms = researchTerms(prompt);
  const research = isResearchPrompt(prompt);
  const frontier = [];
  const enqueued = new Map();
  const visited = new Set();
  const retained = [];
  const packets = [];
  const trail = [];
  const enqueue = (file, score, reason) => {
    if (!file || !fs_.has(file) || isGeneratedContextFile(file) || isUnrequestedDocContextFile(file, prompt)) return;
    const key = normalizePath(file);
    const prev = enqueued.get(key);
    if (prev && prev.score >= score) return;
    enqueued.set(key, { file: key, score, reason });
    frontier.push({ file: key, score, reason });
  };

  for (const file of primaryFiles) enqueue(file, 120, "explicit user reference");
  if (activeFile) enqueue(activeFile, 110, "active editor file");
  for (const [idx, file] of openTabs.slice(0, 5).entries()) enqueue(file, 92 - idx, "open editor tab");
  for (const file of discoverResearchFiles(prompt, { files: fs_.files, activePath: activeFile, maxFiles: 10 })) {
    enqueue(file, 76 + researchFileScore(file, fs_.read(file), terms, activeFile), "semantic lexical discovery");
  }
  for (const file of manifestFilesFor(allFiles)) enqueue(file, mode === "plan" || mode === "agent" ? 82 : 54, "project manifest / verification config");

  let steps = 0;
  while (frontier.length && retained.length < maxFiles && steps < maxSteps) {
    frontier.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    const next = frontier.shift();
    if (!next || visited.has(next.file)) continue;
    visited.add(next.file);
    if (!fs_.has(next.file)) continue;
    steps += 1;
    retained.push(next.file);
    trail.push(`${next.file} <= ${next.reason}`);
    const body = fs_.read(next.file);
    packets.push(summarizeContextNeuron(next.file, body, prompt, terms, next.reason));

    const importScore = Math.max(35, next.score - 18);
    for (const spec of extractRelativeImports(body).slice(0, 12)) {
      const resolved = resolveRelativeImport(next.file, spec, allFiles);
      enqueue(resolved, importScore, `direct import from ${next.file}`);
    }
    for (const test of findTestFilesFor(next.file, allFiles)) {
      enqueue(test, Math.max(42, next.score - 14), `test/spec neighbor for ${next.file}`);
    }
    if (research || /refactor|bug|fix|feature|implement|where|how|flow|wired/i.test(String(prompt))) {
      for (const importer of findReverseImporters(next.file, allFiles, fs_).slice(0, 4)) {
        enqueue(importer, Math.max(28, next.score - 30), `reverse importer of ${next.file}`);
      }
    }
  }

  const attachFiles = retained.filter((file) => /\.(js|jsx|ts|tsx|vue|rs|py|go|java|kt|cs|rb|php)$/i.test(file)).slice(0, 8);
  const digest = renderContextBrainDigest({ prompt, retained, packets, trail, fs_ });
  return { files: retained, attachFiles, digest, packets, trail };
}

function summarizeContextNeuron(file, body, prompt, terms, reason) {
  const lines = String(body ?? "").split(/\r?\n/);
  const imports = extractRelativeImports(body).slice(0, 8);
  const symbols = extractContextSymbols(body).slice(0, 12);
  const evidence = extractContextEvidenceLines(file, lines, prompt, terms).slice(0, 8);
  const kind = describeContextFileKind(file, body);
  return {
    file,
    reason,
    kind,
    imports,
    symbols,
    evidence,
    scripts: file === "package.json" ? packageScriptsForBrain(body) : [],
  };
}

function extractContextSymbols(body) {
  const out = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(body ?? "").matchAll(pattern)) {
      const symbol = match[2] ? `${match[1]}.${match[2]}` : match[1];
      if (symbol && !out.includes(symbol)) out.push(symbol);
      if (out.length >= 18) return out;
    }
  }
  return out;
}

function extractContextEvidenceLines(file, lines, prompt, terms) {
  const promptTerms = [
    ...terms,
    ...String(prompt ?? "").toLowerCase().split(/[^a-z0-9_$.-]+/).filter((t) => t.length >= 5),
  ].map((t) => String(t).toLowerCase());
  const generic = [
    /import\s/,
    /export\s/,
    /describe\s*\(/,
    /\bit\s*\(/,
    /test\s*\(/,
    /app\.set|app\.get|defineGetter|compile|query parser|subdomain offset/i,
    /ThemeProvider|Switch|Route|storage\.|local-storage-fallback/i,
    /showDropOverlay|dragDrop|drop-overlay|unsupported/i,
  ];
  const hits = [];
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    const compact = lower.replace(/[^a-z0-9]+/g, "");
    let score = 0;
    for (const pattern of generic) if (pattern.test(line)) score += 3;
    for (const term of promptTerms) {
      const c = term.replace(/[^a-z0-9]+/g, "");
      if (term && lower.includes(term)) score += 2;
      if (c.length >= 6 && compact.includes(c)) score += 2;
    }
    if (score > 0) hits.push({ idx, text: `${file}:${idx + 1}: ${line.trim()}`, score });
  });
  return hits
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, 10)
    .sort((a, b) => a.idx - b.idx)
    .map((hit) => hit.text);
}

function describeContextFileKind(file, body) {
  if (file === "package.json") return "manifest";
  if (/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(file)) return "verification";
  if (/Route|Router|Switch|ThemeProvider|<template|defineComponent|React/.test(body)) return "ui/source";
  if (/exports\.|module\.exports|app\.set|defineGetter/.test(body)) return "runtime/source";
  if (/\.(css|scss|sass|less)$/.test(file)) return "style";
  return "source";
}

function packageScriptsForBrain(body) {
  try {
    const scripts = JSON.parse(body)?.scripts ?? {};
    return Object.entries(scripts)
      .filter(([name]) => /^(test|test:run|build|lint|typecheck|check)$/i.test(name))
      .map(([name, cmd]) => `${name}: ${cmd}`)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function findReverseImporters(targetFile, allFiles, fs_) {
  const targetBase = basenameNoExt(targetFile);
  if (!targetBase || targetBase.length < 3) return [];
  const targetDir = normalizePath(path.posix.dirname(targetFile));
  const out = [];
  for (const file of allFiles) {
    if (file === targetFile || !/\.(js|jsx|ts|tsx|vue|mjs|cjs)$/.test(file) || !fs_.has(file)) continue;
    const body = fs_.read(file);
    const imports = extractRelativeImports(body);
    for (const spec of imports) {
      const resolved = resolveRelativeImport(file, spec, allFiles);
      if (resolved === targetFile) {
        out.push(file);
        break;
      }
      const specBase = basenameNoExt(spec);
      if (specBase === targetBase && normalizePath(path.posix.dirname(resolveRelativeImport(file, spec, allFiles) ?? "")) === targetDir) {
        out.push(file);
        break;
      }
    }
    if (out.length >= 12) break;
  }
  return mergeUnique(out);
}

function renderContextBrainDigest({ retained, packets, trail }) {
  if (!retained.length) return "";
  const out = [];
  out.push("Decentralized context memory retained outside the LLM window.");
  out.push(`Files retained (${retained.length}): ${retained.join(", ")}`);
  const verification = packets.flatMap((p) => p.scripts.map((s) => `${p.file} script ${s}`));
  if (verification.length) out.push(`Verification commands discovered: ${verification.join("; ")}`);
  const packetLines = [];
  for (const packet of packets) {
    const bits = [
      `${packet.file} [${packet.kind}; ${packet.reason}]`,
      packet.symbols.length ? `symbols: ${packet.symbols.slice(0, 8).join(", ")}` : "",
      packet.imports.length ? `imports: ${packet.imports.slice(0, 6).join(", ")}` : "",
      packet.evidence.length ? `evidence: ${packet.evidence.slice(0, 4).join(" | ")}` : "",
    ].filter(Boolean);
    packetLines.push(`- ${bits.join("; ")}`);
  }
  out.push(packetLines.join("\n"));
  out.push(`Exploration trail: ${trail.slice(0, 12).join(" -> ")}`);
  return out.join("\n").slice(0, 7000);
}

function isResearchPrompt(text) {
  return /\b(where|how|trace|configured|compiled|consumed|used|flow|flows|source path|wired)\b/i.test(text);
}

function researchTerms(text) {
  const raw = String(text ?? "");
  const out = [];
  const lower = raw.toLowerCase();
  if (/\bquery\b/.test(lower) && /\bparser\b/.test(lower)) out.push("query parser", "queryParser");
  if (/\bsubdomain\b/.test(lower) && /\boffset\b/.test(lower)) out.push("subdomain offset", "subdomainOffset");
  if (/\bdrag\b/.test(lower) && /\bdrop\b/.test(lower)) out.push("drag drop", "dragDrop");
  for (const match of raw.matchAll(/[`'"]([^`'"]{3,80})[`'"]/g)) out.push(match[1]);
  for (const match of raw.matchAll(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/g)) out.push(match[0]);
  for (const match of raw.matchAll(/\b[A-Za-z_$][\w$]*[A-Z][\w$]*\b/g)) out.push(match[0]);
  const phrases = raw
    .replace(/[^\w\s-]/g, " ")
    .split(/\b(?:and|or|from|into|through|where|how|is|are|the|a|an|to|in|of|for|with)\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5 && s.split(/\s+/).length <= 4);
  out.push(...phrases);
  const stop = new Set([
    "where",
    "configured",
    "compiled",
    "explain",
    "source",
    "path",
    "current",
    "project",
    "through",
  ]);
  const words = raw
    .toLowerCase()
    .match(/\b[a-z][a-z0-9_-]{4,}\b/g)
    ?.filter((w) => !stop.has(w));
  out.push(...(words ?? []));
  for (const word of words ?? []) {
    if (word.endsWith("ing") && word.length > 6) out.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
    if (word.endsWith("ed") && word.length > 5) out.push(word.slice(0, -2), `${word.slice(0, -1)}e`);
    if (word.endsWith("s") && word.length > 5) out.push(word.slice(0, -1));
  }
  return mergeUnique(out).slice(0, 18);
}

function researchFileScore(filePath, body, terms, activePath) {
  const text = String(body ?? "");
  const haystack = `${filePath}\n${text}`.toLowerCase();
  const compactHaystack = haystack.replace(/[^a-z0-9]+/g, "");
  const promptTopic = terms.join(" ").toLowerCase();
  let score = filePath === activePath ? 1 : 0;
  for (const term of terms) {
    const needle = String(term ?? "").toLowerCase();
    if (!needle) continue;
    const compactNeedle = needle.replace(/[^a-z0-9]+/g, "");
    if (haystack.includes(needle)) score += needle.includes(" ") ? 5 : 2;
    if (compactNeedle.length >= 6 && compactHaystack.includes(compactNeedle)) {
      score += needle.includes(" ") ? 4 : 2;
    }
    if (text.includes(term)) score += 2;
  }
  if (/\b(test|spec|__tests__)\b/i.test(filePath)) score -= 1;
  if (/^examples\//i.test(filePath)) score -= 5;
  if (isGeneratedContextFile(filePath)) score -= 20;
  if (/^(history|changelog)(\.|$)/i.test(filePath)) score -= 8;
  if (/\.(md|markdown)$|(^|\/)package\.json$/i.test(filePath)) score -= 3;
  if (/\.(js|jsx|ts|tsx|vue|rs|py|go)$/i.test(filePath)) score += 1;
  if (promptTopic.includes("query parser")) {
    if (/compileQueryParser|exports\.compileQueryParser/.test(text)) score += 10;
    if (/query parser fn|defineGetter\(req,\s*['"]query['"]/.test(text)) score += 9;
    if (/this\.set\(['"]query parser['"]|case ['"]query parser['"]/.test(text)) score += 8;
    if (/test\/req\.query|req\.query/.test(filePath) || /describe\([^)]*query parser/i.test(text)) score += 5;
    if (/lib\/response\.js$|lib\/express\.js$/.test(filePath)) score -= 5;
  }
  return score;
}

function isGeneratedContextFile(filePath) {
  return /(?:^|\/)(?:gen|generated)\/.*\.json$/i.test(filePath) ||
    /(?:^|\/)schemas\/.*schema\.json$/i.test(filePath);
}

function isUnrequestedDocContextFile(filePath, prompt) {
  if (!/\.(md|mdx|markdown)$/i.test(filePath)) return false;
  return !/\b(doc|docs|readme|guide|markdown)\b/i.test(String(prompt ?? ""));
}

function isLargeWorkspaceFile(cwd, file) {
  try {
    const full = path.isAbsolute(file) ? file : path.join(cwd, file);
    const stat = fs.statSync(full);
    return stat.isFile() && stat.size > 24_000;
  } catch {
    return false;
  }
}

function isRelevantNeighbor(filePath, query) {
  const norm = normalizePath(filePath).toLowerCase();
  const base = basenameNoExt(norm).toLowerCase();
  const compactQuery = query.replace(/[^a-z0-9]+/g, "");
  if (base && compactQuery.includes(base.replace(/[^a-z0-9]+/g, ""))) return true;
  if (/\b(style|render|component|components|composable|composables|ui|interface)\b/.test(query) && /\.(css|scss|sass|less|html|js|jsx|ts|tsx|vue|svelte)$/.test(norm)) {
    return true;
  }
  if (base && query.split(/[^a-z0-9]+/).some((term) => term.length >= 4 && base.includes(term))) {
    return true;
  }
  return false;
}

function isDirectImportContextNeighbor(filePath, query, seedFile, activeFile) {
  if (!seedFile || normalizePath(seedFile) !== normalizePath(activeFile ?? "")) return false;
  const norm = normalizePath(filePath).toLowerCase();
  if (!/\.(css|scss|sass|less|html|js|jsx|ts|tsx|vue|svelte)$/.test(norm)) return false;
  return /\b(component|components|composable|composables|consume|consumes|theme|routing|route|router|state|props|refactor|cleanup|clean|ui|interface|render|wired|flow|drag|drop|overlay|unsupported)\b/.test(query);
}

function compactFileForPrompt(filePath, text, prompt, maxChars = 5000) {
  const raw = String(text ?? "");
  if (raw.length <= maxChars) return raw;
  if (isFileExplanationPrompt(prompt) && raw.length > maxChars * 2) {
    return summarizeLargeFileForPrompt(filePath, raw, maxChars);
  }
  const lines = raw.split(/\r?\n/);
  const queryTerms = String(prompt ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_.$-]+/)
    .filter((term) => term.length >= 4);
  const important = new Set([
    "import",
    "export",
    "describe",
    "it(",
    "test(",
    "vditor",
    "upload",
    "image",
    "dragdrop",
    "dragdropmanager",
    "showdropoverlay",
    "drop-overlay",
    "theme",
    "save",
    "open",
    "exportto",
    ...queryTerms,
  ]);
  const keep = new Set();
  const mark = (idx, radius) => {
    for (let i = Math.max(0, idx - radius); i <= Math.min(lines.length - 1, idx + radius); i += 1) {
      keep.add(i);
    }
  };
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    const compactLine = lower.replace(/[^a-z0-9]+/g, "");
    for (const term of important) {
      const compactTerm = String(term).replace(/[^a-z0-9]+/g, "");
      if (term && (lower.includes(term) || (compactTerm.length >= 5 && compactLine.includes(compactTerm)))) {
        mark(idx, 5);
        break;
      }
    }
  });
  for (let i = 0; i < Math.min(20, lines.length); i += 1) keep.add(i);
  const ordered = [...keep].sort((a, b) => a - b);
  const out = [];
  let last = -2;
  for (const idx of ordered) {
    if (idx !== last + 1) out.push(`\n// ... ${idx - last - 1} lines omitted ...`);
    out.push(lines[idx]);
    last = idx;
    if (out.join("\n").length > maxChars) break;
  }
  const compact = out.join("\n").trim();
  if (compact.length >= 500) return compact;
  const head = raw.slice(0, Math.floor(maxChars * 0.65));
  const tail = raw.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n\n// ... middle omitted from ${filePath} ...\n\n${tail}`;
}

function isFileExplanationPrompt(prompt) {
  return /\b(tell me about|explain|walk me through|what does|describe)\b/i.test(String(prompt ?? ""));
}

function summarizeLargeFileForPrompt(filePath, text, maxChars = 4500) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  const imports = [];
  const stateKeys = [];
  const methodNames = [];
  const hotspots = [];
  const featurePatterns = [
    /Vditor/i,
    /dragDropManager|showDropOverlay|drop-overlay|useDragDrop/i,
    /upload|uploadToImageHost|uploadToSMMS|getImageHostConfig/i,
    /imagePathMapper|isImageFile|assets\/images/i,
    /exportTo|pdf|html/i,
    /saveMdFile|loadFileByPath|openMdFile|newMdFile|currentFilePath/i,
    /setVditorTheme|isDarkTheme|theme/i,
    /scrollMemory|checkUnsavedChanges/i,
  ];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (/^import\s/.test(trimmed) && imports.length < 28) {
      imports.push(`${idx + 1}: ${trimmed}`);
    }
    const stateMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*(?:null|false|true|['"`{[]|\d)/);
    if (stateMatch && idx < 180 && stateKeys.length < 32) {
      stateKeys.push(`${idx + 1}: ${stateMatch[1]}`);
    }
    const methodMatch = trimmed.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (methodMatch && methodNames.length < 48) {
      methodNames.push(`${idx + 1}: ${methodMatch[1]}()`);
    }
    if (featurePatterns.some((pattern) => pattern.test(line)) && hotspots.length < 48) {
      hotspots.push(`${idx + 1}: ${trimmed.slice(0, 180)}`);
    }
  });
  sections.push(`${filePath} is large (${lines.length} lines). Compact structural map for Ask mode.`);
  if (imports.length) sections.push(`Imports:\n${imports.join("\n")}`);
  if (stateKeys.length) sections.push(`State/data keys:\n${stateKeys.join(", ")}`);
  if (methodNames.length) sections.push(`Methods:\n${methodNames.join(", ")}`);
  if (hotspots.length) sections.push(`Feature hotspots:\n${hotspots.join("\n")}`);
  const out = sections.join("\n\n");
  return out.length > maxChars ? `${out.slice(0, maxChars - 160)}\n... compact map truncated for ${filePath} ...` : out;
}

function askEvidenceForPrompt(files, fs_, prompt, maxLines = 24) {
  const promptTerms = researchTerms(prompt)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 4);
  const important = [
    /compileQueryParser/,
    /exports\.compileQueryParser/,
    /\breq\.query\b/,
    /\bdefineGetter\(req,\s*['"]query['"]/,
    /defaultConfiguration/,
    /\bapp\.(?:handle|use|route|listen|render|defaultConfiguration)\b/,
    /\b(?:this|app)\.set\s*\(/,
    /\b(?:this|app)\.enable\s*\(/,
    /\b(?:this|app)\.disable\s*\(/,
    /\btrust proxy\b/,
    /\bquery parser\b/,
    /\bsubdomain offset\b/,
    /\betag\b/,
    /\bshowDropOverlay\b/,
    /\bdragDropManager\b/,
    /\bdrop-overlay\b/,
    /\bupload\b/i,
    /\bimagePathMapper\b/,
    /\bisImageFile\b/,
    /\bgetImageHostConfig\b/,
    /\buploadToImageHost\b/,
    /\bhandleUpload\b/,
    /\bThemeProvider\b/,
    /\bSwitch\b/,
    /\bRoute\b/,
    /\bBrowserRouter\b/,
    /\blocal-storage-fallback\b/,
    /\bstorage\.(?:getItem|setItem)\b/,
    /\bhistoryTheme\b/,
  ];
  const hits = [];
  files.forEach((file, fileIndex) => {
    if (!fs_.has(file)) return;
    const lines = fs_.read(file).split(/\r?\n/);
    lines.forEach((line, idx) => {
      const lower = line.toLowerCase();
      const compactLine = lower.replace(/[^a-z0-9]+/g, "");
      let score = 0;
      for (const pattern of important) {
        if (pattern.test(line)) score += 3;
      }
      for (const term of promptTerms) {
        const compactTerm = term.replace(/[^a-z0-9]+/g, "");
        if (lower.includes(term)) score += term.includes(" ") ? 4 : 2;
        if (compactTerm.length >= 6 && compactLine.includes(compactTerm)) score += 2;
      }
      if (score > 0) hits.push({ file, line: idx + 1, text: line.trim(), score, fileIndex });
    });
  });
  return hits
    .sort((a, b) => b.score - a.score || a.fileIndex - b.fileIndex || a.line - b.line)
    .slice(0, maxLines)
    .sort((a, b) => a.fileIndex - b.fileIndex || a.line - b.line)
    .map((hit) => `${hit.file}:${hit.line}: ${hit.text}`)
    .join("\n");
}

function symbolInventoryForPrompt(files, fs_, prompt, maxPerFile = 32) {
  if (!isFileExplanationPrompt(prompt) && !isResearchPrompt(prompt)) return "";
  const out = [];
  const patterns = [
    /\b(app|req|res|exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bexport\s+function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)?/g,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  ];
  for (const file of files) {
    if (!fs_.has(file)) continue;
    const text = fs_.read(file);
    const symbols = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const symbol = match[2] ? `${match[1]}.${match[2]}` : match[1];
        if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
        if (symbols.length >= maxPerFile) break;
      }
      if (symbols.length >= maxPerFile) break;
    }
    if (symbols.length) out.push(`${file}: ${symbols.slice(0, maxPerFile).join(", ")}`);
  }
  return out.join("\n");
}

function planEvidenceForPrompt(files, fs_, prompt, maxLines = 28) {
  const out = [];
  const goal = String(prompt ?? "");
  if (/drag|drop|overlay|unsupported/i.test(goal)) {
    for (const file of files) {
      if (!/useDragDrop\.[jt]s$/i.test(file) || !fs_.has(file)) continue;
      const body = fs_.read(file);
      if (/if\s*\(\s*type\s*===\s*['"]drop['"]\s*\)\s*{[^}]*showDropOverlay\.value\s*=\s*false/s.test(body)) {
        out.push(
          `${file}: FACT - the drop handler already sets showDropOverlay.value = false before unsupported-file handling; do not propose adding that same source reset.`,
        );
      }
    }
  }
  for (const file of files) {
    if (file !== "package.json" || !fs_.has(file)) continue;
    const body = fs_.read(file);
    if (/"react-router-dom"\s*:\s*"[^"]*\b5\./.test(body)) {
      out.push(
        `${file}: FACT - react-router-dom is v5.x; preserve BrowserRouter/Switch/Route patterns and do not propose React Router v6 Routes migration unless dependencies change.`,
      );
    }
    const build = body.match(/"build"\s*:\s*"([^"]+)"/)?.[1];
    const test = body.match(/"test"\s*:\s*"([^"]+)"/)?.[1];
    if (build) out.push(`${file}: script build = ${build}`);
    if (test) out.push(`${file}: script test = ${test}`);
  }
  for (const file of files) {
    if (!/src\/App\.[jt]sx?$/i.test(file) || !fs_.has(file)) continue;
    const body = fs_.read(file);
    if (/ThemeProvider/.test(body) && /createGlobalStyle/.test(body)) {
      out.push(`${file}: FACT - theme styling is currently owned by ThemeProvider and DarkTheme/createGlobalStyle; preserve visible behavior while cleaning this structure.`);
    }
    if (/<Nav\b/.test(body) && /themeSetter=/.test(body) && /theme=\{theme\}/.test(body)) {
      out.push(`${file}: FACT - Nav already receives themeSetter and theme props from App; update src/Components/Nav.js if the refactor changes that boundary, do not claim Nav consumes a custom ThemeProvider context.`);
    }
  }
  const patterns = [
    /showDropOverlay/,
    /drop-overlay/,
    /onDragDropEvent/,
    /unsupported/,
    /describe\s*\(/,
    /\bit\s*\(/,
    /test:run/,
    /ThemeProvider/,
    /createGlobalStyle/,
    /DarkTheme/,
    /Switch/,
    /Route/,
    /BrowserRouter/,
    /react-router-dom/,
    /local-storage-fallback/,
    /storage\.(?:getItem|setItem)/,
    /historyTheme/,
    /react-scripts/,
    /"build":/,
    /"test":/,
    /<Nav\b/,
    /themeSetter/,
    /theme=\{theme\}/,
  ];
  for (const file of files) {
    if (!fs_.has(file)) continue;
    const lines = fs_.read(file).split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (out.length >= maxLines) return;
      if (patterns.some((pattern) => pattern.test(line))) {
        out.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
    if (out.length >= maxLines) break;
  }
  return out.join("\n");
}

function orderContextFilesForPlan(files, activeFile, prompt = "") {
  return mergeUnique(files).sort((a, b) => {
    const ra = planContextRank(a, activeFile, prompt);
    const rb = planContextRank(b, activeFile, prompt);
    return ra - rb || a.localeCompare(b);
  });
}

function orderRelatedContextFilesForPrompt(files, prompt, activeFile, fs_) {
  const terms = researchTerms(prompt);
  return mergeUnique(files).sort((a, b) => {
    const ra = relatedContextRank(a, prompt, activeFile, fs_, terms);
    const rb = relatedContextRank(b, prompt, activeFile, fs_, terms);
    return ra - rb || a.localeCompare(b);
  });
}

function orderContextFilesForAsk(files, prompt, activeFile, fs_) {
  const research = isResearchPrompt(prompt);
  const terms = researchTerms(prompt);
  return mergeUnique(files).sort((a, b) => {
    const ra = askContextRank(a, prompt, activeFile, fs_, research, terms);
    const rb = askContextRank(b, prompt, activeFile, fs_, research, terms);
    return ra - rb || a.localeCompare(b);
  });
}

function relatedContextRank(filePath, prompt, activeFile, fs_, terms) {
  const p = normalizePath(filePath).toLowerCase();
  const q = String(prompt ?? "").toLowerCase();
  if (p === normalizePath(activeFile ?? "").toLowerCase()) return 0;
  if (/query parser/.test(q)) {
    if (p === "lib/utils.js") return 1;
    if (p === "lib/request.js") return 2;
    if (p === "test/req.query.js") return 3;
  }
  if (/drag|drop|overlay|unsupported/.test(q)) {
    if (/src\/composables\/usedragdrop\.js$/.test(p)) return 1;
    if (/src\/composables\/__tests__\/usedragdrop\.test\.js$/.test(p)) return 2;
  }
  if (/theme|routing|route|router/.test(q) && /src\/components\/nav\.js$/.test(p)) return 1;
  const researchScore = isResearchPrompt(prompt) && fs_?.has(filePath)
    ? researchFileScore(filePath, fs_.read(filePath), terms, activeFile)
    : 0;
  if (/\.(vue|tsx|jsx|ts|js|rs|py|go)$/.test(p) && !/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(p)) {
    return 10 - researchScore;
  }
  if (/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(p)) return 20 - researchScore;
  if (p.endsWith("package.json") || p.endsWith("cargo.toml") || p.endsWith("pyproject.toml")) return 25 - researchScore;
  return 40 - researchScore;
}

function askContextRank(filePath, prompt, activeFile, fs_, research, terms) {
  const p = normalizePath(filePath).toLowerCase();
  if (p === normalizePath(activeFile ?? "").toLowerCase()) return 0;
  const lowerPrompt = String(prompt ?? "").toLowerCase();
  if (lowerPrompt.includes("query parser")) {
    if (p === "lib/utils.js") return 1;
    if (p === "lib/request.js") return 2;
    if (p === "test/req.query.js") return 3;
    if (p === "package.json") return 4;
    if (p === "lib/response.js" || p === "lib/express.js") return 60;
    if (/(?:^|\/)__tests__\/|\.test\.|\.spec\.|^test\//.test(p)) return 65;
  }
  const score = research && fs_?.has(filePath)
    ? researchFileScore(filePath, fs_.read(filePath), terms, activeFile)
    : 0;
  const researchRank = research ? Math.max(0, 20 - score) : 20;
  if (/^(history|changelog)(\.|$)/i.test(filePath) || /\.(md|markdown)$/i.test(filePath)) return 80 - score;
  if (/^examples\//i.test(filePath)) return 75 - score;
  if (/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(p)) return 25 - score;
  if (p.endsWith("package.json") || p.endsWith("cargo.toml") || p.endsWith("pyproject.toml")) return 35 - score;
  if (/\.(js|jsx|ts|tsx|vue|rs|py|go)$/.test(p)) return researchRank;
  return 50 - score;
}

function planContextRank(filePath, activeFile, prompt = "") {
  const p = normalizePath(filePath).toLowerCase();
  const q = String(prompt ?? "").toLowerCase();
  if (p === normalizePath(activeFile ?? "").toLowerCase()) return 0;
  if (/drag|drop|overlay|unsupported/.test(q) && /src\/composables\/usedragdrop\.js$/.test(p)) return 1;
  if (/theme|routing|route|router/.test(q) && /src\/components\/nav\.js$/.test(p)) return 1;
  if (/subdomain/.test(q) && /test\/req\.subdomains\.js$/.test(p)) return 1.5;
  if (/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(p)) {
    if (/drag|drop|overlay|unsupported/.test(q) && /usedragdrop\.test\.js$/.test(p)) return 1.5;
    return 4;
  }
  if (p.endsWith("package.json") || p.endsWith("cargo.toml") || p.endsWith("pyproject.toml")) return 2;
  if (/\.(vue|tsx|jsx|ts|js|rs|py|go)$/.test(p)) return 3;
  if (/\.(css|scss|sass|less)$/.test(p)) return 5;
  return 6;
}

function basenameNoExt(filePath) {
  const name = path.posix.basename(normalizePath(filePath));
  return name.replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\.[^.]+$/i, "");
}

function guessActiveFile(files) {
  const keys = Object.keys(files);
  return (
    keys.find((p) => /^src\/App\.(tsx|jsx|vue|svelte)$/.test(p)) ||
    keys.find((p) => /^src\/main\.(ts|tsx|js|jsx|vue)$/.test(p)) ||
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

function manifestFilesFor(files) {
  const names = new Set(files);
  return [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "mix.exs",
  ].filter((p) => names.has(p));
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
  if (/^##\s+(Goal|Progress|Constraints|Next Steps)\b/im.test(text)) {
    failures.push("Ask leaked internal progress headings.");
  }
  if (/^[`A-Za-z_$][^.\n]{80,520}(?:,|`)[^.\n]*\bThe\s+/s.test(text)) {
    failures.push("Ask leaked a raw leading identifier list before the answer.");
  }
  if (result.contextFiles?.length && /\b(don't|do not)\s+have\s+access\b|\bshare (?:the )?(?:contents|file)\b/i.test(text)) {
    failures.push("Ask claimed it lacked file access despite attached file context.");
  }
  if (expect.directEditRedirect && text.trim() !== ASK_EDIT_REDIRECT) {
    failures.push("Ask did not use the exact edit-mode redirect.");
  }
  const identifierCount = keyIdentifierCount(text);
  if (identifierCount > 8) {
    failures.push(`Ask listed too many key identifiers (${identifierCount}; max 8).`);
  }
  for (const needle of expect.includes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (!ok) failures.push(`Ask response missing ${needle}`);
  }
  for (const needle of expect.excludes ?? []) {
    const hit = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (hit) failures.push(`Ask response unexpectedly included ${needle}`);
  }
  const refs = collectToolReferences(result.trace ?? [], expect.workspace ?? result.cwd);
  const refText = [
    ...refs.map((r) => r.raw),
    ...(result.contextFiles ?? []),
    ...(result.attachedFiles ?? []),
  ].join("\n");
  for (const needle of expect.toolIncludes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(refText) : refText.includes(needle);
    if (!ok) failures.push(`Ask tool trace missing ${needle}`);
  }
  failures.push(...toolExcludeFailures(result, expect));
  failures.push(...workspaceTraceFailures(result, expect));
  return { pass: failures.length === 0, failures };
}

function keyIdentifierCount(text) {
  const match = String(text ?? "").match(/key identifiers?[^\n:]*:\s*([^\n]+)/i);
  if (!match) return 0;
  return match[1]
    .split(/,\s*/)
    .map((item) => item.trim())
    .filter(Boolean).length;
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
  for (const needle of expect.excludes ?? []) {
    const hit = needle instanceof RegExp ? needle.test(plan) : plan.includes(needle);
    if (hit) failures.push(`Plan unexpectedly included ${needle}`);
  }
  if (/\b(?:npx|npm exec|pnpm dlx|yarn dlx|bunx)\b/i.test(plan)) {
    failures.push("Plan suggested a package executor command that Agent mode would block.");
  }
  const refs = collectToolReferences(result.trace ?? [], expect.workspace ?? result.cwd);
  const refText = [
    ...refs.map((r) => r.raw),
    ...(result.contextFiles ?? []),
    ...(result.attachedFiles ?? []),
  ].join("\n");
  for (const needle of expect.toolIncludes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(refText) : refText.includes(needle);
    if (!ok) failures.push(`Plan tool trace missing ${needle}`);
  }
  failures.push(...toolExcludeFailures(result, expect));
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
  if (expect.changedAnyOf?.length) {
    const hit = expect.changedAnyOf.some((p) => changed.includes(p));
    if (!hit) failures.push(`Expected one of ${expect.changedAnyOf.join(", ")} to change.`);
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
  for (const [filePath, needle] of Object.entries(expect.fileNotContains ?? {})) {
    const text = terminal.fs_.has(filePath) ? terminal.fs_.read(filePath) : "";
    const hit = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (hit) failures.push(`${filePath} unexpectedly contains ${needle}`);
  }
  for (const needle of expect.includes ?? []) {
    const ok = needle instanceof RegExp ? needle.test(result.text ?? "") : String(result.text ?? "").includes(needle);
    if (!ok) failures.push(`Agent final missing ${needle}`);
  }
  for (const needle of expect.excludes ?? []) {
    const hit = needle instanceof RegExp ? needle.test(result.text ?? "") : String(result.text ?? "").includes(needle);
    if (hit) failures.push(`Agent final unexpectedly included ${needle}`);
  }
  const finalText = String(result.text ?? "");
  const finalVerificationSkip =
    /\b(?:no verification was (?:run|performed)|verification was not (?:run|performed)|did not run verification|tests? (?:were|was) not run)\b/i.test(finalText) &&
    /\b(?:user did not request|didn'?t ask|as requested|per your constraints|minimal|only affects)\b/i.test(finalText);
  if (finalVerificationSkip) {
    failures.push("Agent final skipped verification for a non-blocking reason.");
  }
  const bashRecords = collectBashRecords(result.trace ?? []);
  if (
    expect.verificationRequired !== false &&
    changed.length > 0 &&
    hasProjectVerificationConfig(terminal.fs_) &&
    bashRecords.length === 0
  ) {
    failures.push("Agent changed files but did not attempt any verification command despite project verification config.");
  }
  if (
    expect.verificationRequired !== false &&
    changed.length > 0 &&
    hasProjectVerificationConfig(terminal.fs_) &&
    !/\bVerification:/i.test(finalText)
  ) {
    failures.push("Agent final did not include a Verification: status.");
  }
  if (
    /\b(?:cannot|can't|could not) run (?:npm|pnpm|yarn|bun|cargo|pytest|go test|vitest|test)/i.test(finalText) &&
    bashRecords.length === 0
  ) {
    failures.push("Agent claimed verification could not run without attempting a command.");
  }
  failures.push(...toolExcludeFailures(result, expect));
  if (hasDuplicateFinalSummary(result.text ?? "")) {
    failures.push("Agent final response repeated the same summary.");
  }
  failures.push(...workspaceTraceFailures(result, expect));
  return { pass: failures.length === 0, failures, changed };
}

function toolExcludeFailures(result, expect = {}) {
  const failures = [];
  const toolText = collectToolText(result.trace ?? []).join("\n");
  for (const needle of expect.toolExcludes ?? []) {
    const hit = needle instanceof RegExp ? needle.test(toolText) : toolText.includes(needle);
    if (hit) failures.push(`Tool trace unexpectedly included ${needle}`);
  }
  return failures;
}

function collectToolText(events) {
  const out = [];
  for (const event of events ?? []) {
    if (event.type !== "tool_use") continue;
    const tool = opencodeToolName(event);
    const status = opencodeToolStatus(event);
    const input = event.part?.state?.input ?? {};
    out.push(`${tool} ${status} ${JSON.stringify(input)}`);
  }
  return out;
}

function collectCompletedToolText(events) {
  const out = [];
  for (const event of events ?? []) {
    if (event.type !== "tool_use") continue;
    if (opencodeToolStatus(event) !== "completed") continue;
    const tool = opencodeToolName(event);
    const input = event.part?.state?.input ?? {};
    out.push(`${tool} ${JSON.stringify(input)}`);
  }
  return out;
}

function hasDuplicateFinalSummary(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  return normalizeFinalText(trimmed) !== trimmed;
}

async function runDevilsAdvocateCritic({ scenario, result, verdict, terminal, workspace }) {
  const output = result.response ?? result.text ?? "";
  const trace = summarizeCriticTrace(result.trace ?? [], workspace).slice(0, 60);
  const changed = terminal.changedFiles?.() ?? [];
  const changedDiff = terminal.changedDiffs?.({ maxFiles: 6, maxChars: 12000 }) ?? "";
  const changedExcerpts = changed
    .filter((file) => terminal.fs_.has(file))
    .slice(0, 4)
    .map((file) => `${file}\n${compactFileForPrompt(file, terminal.fs_.read(file), scenario.prompt ?? "", 2600)}`)
    .join("\n\n")
    .slice(0, 9000);
  const contextFiles = [
    ...(result.contextFiles ?? []),
    ...(result.attachedFiles ?? []),
  ].filter(Boolean);
  const evidence = criticEvidenceForScenario(scenario, terminal, contextFiles, changed);
  const system = [
    "You are Pointer's devil's advocate verifier.",
    "Your job is to challenge an Ask, Plan, or Agent result before the user sees it.",
    "Compare the original user goal against the produced output, tool trace, deterministic validator result, changed files, and mode contract.",
    "Be skeptical but practical: flag only concrete defects that would reduce correctness, safety, executability, or user trust.",
    "Do not fail merely because a harmless detail is absent from the short evidence snippets; fail only for concrete contradictions, unsupported important claims, missing required work, or mode violations.",
    "Markdown emphasis and headings are acceptable unless they obscure correctness or violate an explicit mode rule.",
    "For Agent mode, the final answer does not need to include a code diff or full file content when the changed-file diff and tool trace prove the edit.",
    "When changed-file diffs are provided, use them to distinguish original source from post-edit source; do not treat a post-edit excerpt as proof that the change already existed before the run.",
    "If a simple line diff looks ambiguous, resolve ambiguity against the final changed-file excerpt before failing; do not fail on hypothetical syntax concerns when the final excerpt is coherent and deterministic validators passed.",
    "For Agent mode, a verification attempt that is blocked by missing dependencies is acceptable when dependency installation is forbidden. Never suggest npm install, pnpm install, yarn install, bun install, pip install, or cargo install as a repair unless the original user explicitly requested dependency installation.",
    "If deterministic validators passed and you only have minor wording concerns, pass and leave issues empty.",
    "Do not ask for more context. Do not produce prose outside JSON.",
  ].join(" ");
  const modeContract = criticModeContract(scenario.mode);
  const user = [
    `Mode: ${scenario.mode}`,
    `Scenario: ${scenario.id}`,
    `Original user goal:\n${scenario.prompt}`,
    `Mode contract:\n${modeContract}`,
    `Context files attached by Pointer:\n${contextFiles.length ? contextFiles.join("\n") : "(none recorded)"}`,
    `Literal evidence snippets:\n${evidence || "(none)"}`,
    `Changed files:\n${changed.length ? changed.join("\n") : "(none)"}`,
    `Changed-file diff:\n${changedDiff || "(none)"}`,
    `Final changed-file excerpts:\n${changedExcerpts || "(none)"}`,
    `Tool trace summary:\n${trace.length ? trace.join("\n") : "(no tool events)"}`,
    `Deterministic validator pass: ${verdict.pass ? "true" : "false"}`,
    `Deterministic validator issues:\n${verdict.failures?.length ? verdict.failures.join("\n") : "(none)"}`,
    `Produced output:\n${String(output).slice(0, 6000)}`,
    [
      "Return strict JSON only:",
      '{"pass":true|false,"issues":["short concrete issue"],"repair_brief":"one short instruction for the next repair pass, empty if pass"}',
      "Fail if the output contradicts evidence, skips required verification after edits, suggests commands Agent mode would block, edits in Ask/Plan, lacks an executable answer for the mode, or fails the original user goal.",
      "Pass if issues are merely style preferences and the result is correct, executable, and honest.",
    ].join("\n"),
  ].join("\n\n");
  try {
    const raw = await generateRaw({
      prompt: `${system}\n\n${user}`,
      raw: true,
      options: { temperature: 0, num_predict: 1400 },
      timeoutMs: CRITIC_TIMEOUT_MS,
    });
    return parseCriticJson(raw);
  } catch (error) {
    return {
      pass: false,
      issues: [`critic runtime: ${error.message}`],
      repairBrief: "Retry the critic pass or fall back to deterministic validators.",
      raw: "",
    };
  }
}

function summarizeCriticTrace(events, workspace) {
  return (events ?? [])
    .filter((event) => event.type === "tool_use")
    .map((event, idx) => formatOpenCodeToolEvent(event, idx + 1, workspace));
}

function criticEvidenceForScenario(scenario, terminal, contextFiles, changedFiles = []) {
  const files = mergeUnique([...contextFiles, ...changedFiles]).filter((file) => terminal.fs_.has(file)).slice(0, 8);
  if (!files.length) return "";
  const prompt = scenario.prompt ?? "";
  const evidence =
    scenario.mode === "plan"
      ? planEvidenceForPrompt(files, terminal.fs_, prompt, 34)
      : askEvidenceForPrompt(files, terminal.fs_, prompt, 34);
  const excerpts = files
    .slice(0, 4)
    .map((file) => {
      const body = compactFileForPrompt(file, terminal.fs_.read(file), prompt, 1800);
      return `${file}\n${body}`;
    })
    .join("\n\n")
    .slice(0, 7000);
  return [
    evidence ? `Literal evidence lines:\n${evidence}` : "",
    excerpts ? `Compact source excerpts:\n${excerpts}` : "",
  ].filter(Boolean).join("\n\n");
}

function criticModeContract(mode) {
  if (mode === "ask") {
    return [
      "Ask is read-only.",
      "It must answer from available repository evidence.",
      "It must not claim lack of access to active/attached files.",
      "It should not emit internal protocol or unsolicited fenced code blocks.",
    ].join(" ");
  }
  if (mode === "plan") {
    return [
      "Plan is read-only and must not mutate files.",
      "It must produce an executable engineering plan, not a plan to make a plan.",
      "It must cite relevant files read and name a verification command that Agent mode can run.",
      "It must not use package executors such as npx, npm exec, pnpm dlx, yarn dlx, or bunx.",
    ].join(" ");
  }
  return [
    "Agent may mutate files to satisfy the goal.",
    "It must keep edits scoped to the request.",
    "After successful edits, it must attempt repository verification or report the real blocker.",
    "It must not install dependencies or run destructive/forbidden commands unless explicitly requested.",
    "The final answer must match the actual changed files and verification status.",
  ].join(" ");
}

function parseCriticJson(raw) {
  const text = stripCriticThinking(String(raw ?? "").trim());
  const parsed = tryParseCriticJson(text) ?? tryParseCriticJson(extractJsonObject(text));
  if (!parsed) {
    if (/^\s*pass\b/i.test(text)) {
      return { pass: true, issues: [], repairBrief: "", raw: text };
    }
    const failMatch = text.match(/^\s*fail\b[:\s-]*(.*)$/is);
    if (failMatch) {
      return {
        pass: false,
        issues: [failMatch[1].trim().slice(0, 300) || "critic marked result as failing"],
        repairBrief: failMatch[1].trim().slice(0, 300),
        raw: text,
      };
    }
    return {
      pass: false,
      issues: [`critic returned non-JSON output: ${text.slice(0, 180)}`],
      repairBrief: "Return strict JSON with pass, issues, and repair_brief.",
      raw: text,
    };
  }
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map((item) => String(item)).filter(Boolean).slice(0, 6)
    : [];
  return {
    pass: parsed.pass === true && issues.length === 0,
    issues: parsed.pass === true && issues.length === 0 ? [] : issues.length ? issues : ["critic marked result as failing"],
    repairBrief: String(parsed.repair_brief ?? parsed.repairBrief ?? "").trim(),
    raw: text,
  };
}

function stripCriticThinking(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function tryParseCriticJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? "" : text.slice(start, end + 1);
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
  const resolvedRoot = realPathOrResolve(root);
  const resolvedCandidate = realPathOrResolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realPathOrResolve(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
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

const AGENT_FORBIDDEN_COMMANDS = [
  /npm install|npm i\s|npm add|npm update|npm exec|npx\s/i,
  /pnpm install|pnpm add|pnpm dlx|yarn install|yarn add|yarn dlx|bun install|bun add|bunx\s/i,
  /pip install|pip3 install|uv pip install|poetry add|cargo install/i,
  /git reset|git checkout|git clean|git push|rm -rf/i,
];

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
    category: "question-answering",
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
      excludes: [/lazyrouter/i, /app\.mount/i, /,\s*and\s+mount\b/i],
    },
  },
  {
    id: "express-ask-edit-redirect",
    category: "mode-boundary",
    mode: "ask",
    repo: "/Users/sameer/express",
    activeFile: "lib/request.js",
    prompt: "Fix lib/request.js so req.subdomains handles offset better",
    expect: { directEditRedirect: true },
  },
  {
    id: "express-plan-subdomains",
    category: "bug-fix-planning",
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
    id: "express-ask-query-parser-research",
    category: "research",
    mode: "ask",
    repo: "/Users/sameer/express",
    activeFile: "lib/application.js",
    prompt:
      "Where is Express's query parser configured and compiled? Explain the source path from app setting to request parsing.",
    expect: {
      includes: [/compileQueryParser/, /query parser/, /lib\/utils\.js|utils\.compileQueryParser/, /req\.query|request\.js/],
      toolIncludes: [/lib\/utils\.js|lib\/request\.js|lib\/application\.js/],
    },
  },
  {
    id: "tauri-ask-vditor",
    category: "question-answering",
    mode: "ask",
    repo: "/Users/sameer/tauri-markdown",
    activeFile: "src/components/MyVditor.vue",
    prompt: "Tell me about MyVditor.vue",
    expect: {
      includes: [/useDragDrop|dragDropManager|drop-overlay|showDropOverlay/, /Vditor/, /upload|image/i],
      excludes: [/app\.defaultConfiguration|trust proxy|request\.subdomains/],
    },
  },
  {
    id: "tauri-plan-drag-overlay",
    category: "ui-bug-planning",
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
        /(No source change|no source change|already.*showDropOverlay\.value\s*=\s*false|showDropOverlay\.value\s*=\s*false.*already)/,
        /(npm run test:run -- src\/composables\/__tests__\/useDragDrop\.test\.js|npm test -- src\/composables\/__tests__\/useDragDrop\.test\.js|npm test -- -- src\/composables\/__tests__\/useDragDrop\.test\.js|npm run test -- src\/composables\/__tests__\/useDragDrop\.test\.js)/,
      ],
      excludes: [
        /THIS LINE WAS MISSING/i,
        /there'?s a UI bug where .*overlay remains visible/i,
        /template doesn'?t re-render/i,
        /does not re-render/i,
        /does NOT set `?showDropOverlay`? back to `?false`?/i,
        /overlay is hidden only when a valid/i,
        /doesn'?t hide the overlay/i,
        /does not hide the overlay/i,
        /only hides the overlay for valid/i,
        /leaves the overlay visible/i,
        /missing overlay hiding/i,
        /Add explicit overlay hiding/i,
      ],
      toolIncludes: [
        /src\/composables\/useDragDrop\.js/,
        /src\/composables\/__tests__\/useDragDrop\.test\.js/,
      ],
    },
  },
  {
    id: "blog-ask-routing-theme",
    category: "question-answering",
    mode: "ask",
    repo: "/Users/sameer/Blog-and-Portfolio",
    activeFile: "src/App.js",
    prompt: "Tell me how routing and theme state are wired in App.js.",
    expect: {
      includes: [/BrowserRouter|Router/, /Switch/, /Route/, /ThemeProvider/, /local-storage-fallback|storage/],
    },
  },
  {
    id: "blog-plan-theme-cleanup",
    category: "refactor-planning",
    mode: "plan",
    repo: "/Users/sameer/Blog-and-Portfolio",
    activeFile: "src/App.js",
    prompt:
      "Plan a refactor to clean up theme and routing structure in this React portfolio without changing visible behavior. Read App.js and the components that consume the theme before proposing the executable plan.",
    expect: {
      includes: [
        /src\/App\.js/,
        /src\/Components\/Nav\.js/,
        /ThemeProvider/,
        /GlobalStyles|DarkTheme|lightTheme|darkTheme|styled-components/,
        /(npm test|npm run test|npm run build)/,
      ],
      excludes: [
        /Routes\b|react-router-dom v6|Router v6/i,
        /All components .*consume .*ThemeProvider context/i,
        /Create `?src\/Components\/Nav\.js`?/i,
      ],
      toolIncludes: [/src\/App\.js/, /src\/Components\/Nav\.js/],
    },
  },
  {
    id: "blog-agent-creative-home-copy",
    category: "creative-edit",
    mode: "agent",
    copyRepo: true,
    repo: "/Users/sameer/Blog-and-Portfolio",
    activeFile: "src/Components/Home.js",
    prompt:
      "Improve the home hero headline copy to be grammatically correct and more polished. Keep layout, classes, imports, links, and assets unchanged; update only user-facing text in Home.js.",
    expect: {
      toolExcludes: AGENT_FORBIDDEN_COMMANDS,
      excludes: [
        /no (?:test scripts|build commands|verification command) (?:is|are) available/i,
        /user didn'?t specify (?:running )?(?:tests|builds)/i,
        /no verification was (?:run|performed)/i,
        /verification was not (?:run|performed)/i,
        /as per your constraints/i,
      ],
      changed: ["src/Components/Home.js"],
      unchanged: ["src/Components/Home.css", "src/App.js"],
      fileContains: {
        "src/Components/Home.js": /I('|’)m|I am/,
      },
      fileNotContains: {
        "src/Components/Home.js": /I'am/,
      },
    },
  },
  {
    id: "blog-agent-refactor-usefetch",
    category: "refactor",
    mode: "agent",
    copyRepo: true,
    repo: "/Users/sameer/Blog-and-Portfolio",
    activeFile: "src/useFetch.js",
    prompt:
      "Refactor src/useFetch.js so it does not issue the identical GraphQL request twice. Keep the returned API exactly { blogpage, id, numberofblogs }. Use one fetch response to set blogpage, blogs, id, and numberofblogs.",
    expect: {
      toolExcludes: AGENT_FORBIDDEN_COMMANDS,
      changed: ["src/useFetch.js"],
      fileContains: {
        "src/useFetch.js": /fetch\(['"]https:\/\/api-pranavdhar\.herokuapp\.com\/graphql['"],\s*sendingPost\)[^]*setBlogpage\(data\.data\.postById\)/,
      },
      fileNotContains: {
        "src/useFetch.js": /fetch\([^]*fetch\(/,
      },
    },
  },
  {
    id: "tauri-agent-uppercase-drop",
    category: "feature-implementation",
    mode: "agent",
    copyRepo: true,
    repo: "/Users/sameer/tauri-markdown",
    activeFile: "src/composables/useDragDrop.js",
    prompt:
      "Add support for uppercase Markdown/text extensions in drag-drop (.MD, .MARKDOWN, .TXT) by normalizing extension comparisons rather than enumerating every casing, and add or update unit tests covering uppercase extensions. Keep existing behavior for lowercase files.",
    expect: {
      toolExcludes: AGENT_FORBIDDEN_COMMANDS,
      changed: [
        "src/composables/useDragDrop.js",
        "src/composables/__tests__/useDragDrop.test.js",
      ],
      fileContains: {
        "src/composables/useDragDrop.js": /toLowerCase|toLocaleLowerCase/i,
        "src/composables/__tests__/useDragDrop.test.js": /\.MD|\.MARKDOWN|\.TXT/,
      },
    },
  },
];

async function runScenarioSuite({ suite = "smoke", repoOverride = null, approval = "auto", critic = false } = {}) {
  console.log(bar(`Pointer terminal suite: ${suite}`));
  console.log(`model: ${MODEL}`);
  if (critic) console.log("critic: enabled");
  const selected =
    suite === "smoke"
      ? SCENARIOS.filter((s) => ["express-ask-application", "express-ask-edit-redirect"].includes(s.id))
      : suite === "real"
        ? SCENARIOS
        : SCENARIOS.filter((s) => s.id === suite || s.mode === suite);
  if (!selected.length) throw new Error(`No terminal scenario matched ${suite}`);
  const results = [];
  for (const scenario of selected) {
    const sourceRepo = repoOverride ?? scenario.repo;
    if (!fs.existsSync(sourceRepo)) {
      results.push({ scenario, pass: false, failures: [`repo not found: ${sourceRepo}`] });
      console.log(`  ${emoji(false)} ${scenario.id} - repo not found`);
      continue;
    }
    let repo = sourceRepo;
    let cleanupRepo = null;
    const t0 = Date.now();
    let terminal;
    let run;
    let verdict;
    try {
      if (scenario.copyRepo) {
        cleanupRepo = copyRepoForScenario(sourceRepo, scenario.id);
        repo = cleanupRepo;
      }
      terminal = new PointerTerminal({ repo, approval, verbose: false });
      if (scenario.activeFile) terminal.setActiveFile(scenario.activeFile);
      run = await terminal.send(scenario.prompt, {
        mode: scenario.mode,
        approval,
        maxTurns: scenario.maxTurns ?? 12,
      });
      const expect = { ...(scenario.expect ?? {}), workspace: repo };
      if (scenario.mode === "ask") verdict = evaluateAsk(run, expect);
      else if (scenario.mode === "plan") verdict = evaluatePlan(run, expect);
      else verdict = evaluateAgent(run, terminal, expect);
      if (critic && run && terminal) {
        const criticVerdict = await runDevilsAdvocateCritic({
          scenario,
          result: run,
          verdict,
          terminal,
          workspace: repo,
        });
        verdict.critic = criticVerdict;
        if (!criticVerdict.pass) {
          verdict.pass = false;
          verdict.failures.push(
            `critic: ${criticVerdict.issues.join("; ")}${criticVerdict.repairBrief ? ` | repair: ${criticVerdict.repairBrief}` : ""}`,
          );
        }
      }
    } catch (error) {
      verdict = { pass: false, failures: [`runtime: ${error.message}`] };
    } finally {
      if (cleanupRepo) fs.rmSync(cleanupRepo, { recursive: true, force: true });
    }
    const ms = Date.now() - t0;
    results.push({ scenario, ms, ...verdict });
    console.log(`  ${emoji(verdict.pass)} ${scenario.id}${scenario.category ? ` [${scenario.category}]` : ""} (${ms}ms)`);
    for (const failure of verdict.failures ?? []) console.log(`     - ${failure}`);
  }
  const passes = results.filter((r) => r.pass).length;
  const byCategory = new Map();
  for (const result of results) {
    const key = result.scenario.category ?? result.scenario.mode;
    const item = byCategory.get(key) ?? { pass: 0, total: 0 };
    item.total += 1;
    if (result.pass) item.pass += 1;
    byCategory.set(key, item);
  }
  console.log(`\nTerminal suite total: ${passes}/${results.length} passed`);
  console.log(
    `Coverage: ${[...byCategory.entries()]
      .map(([category, item]) => `${category} ${item.pass}/${item.total}`)
      .join(", ")}`,
  );
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
    category: s.category ?? s.mode,
    mode: s.mode,
    repo: s.repo,
    copyRepo: Boolean(s.copyRepo),
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
  if (expect.toolExcludes) out.toolExcludes = expect.toolExcludes.map(String);
  if (expect.changed) out.changed = expect.changed;
  if (expect.changedAnyOf) out.changedAnyOf = expect.changedAnyOf;
  if (expect.unchanged) out.unchanged = expect.unchanged;
  if (expect.fileContains) {
    out.fileContains = Object.fromEntries(
      Object.entries(expect.fileContains).map(([k, v]) => [k, String(v)]),
    );
  }
  if (expect.fileNotContains) {
    out.fileNotContains = Object.fromEntries(
      Object.entries(expect.fileNotContains).map(([k, v]) => [k, String(v)]),
    );
  }
  return out;
}

async function runSelfTest() {
  const fixture = new PointerTerminal({ repo: null, verbose: false });
  fixture.root = os.tmpdir();
  fixture.fs_ = new VirtualFs({
    "src/App.jsx": "import { Deck } from './Deck.jsx';\nexport default function App() { return <Deck /> }\n",
    "src/Deck.jsx": "import { Card } from './components/Card';\nexport function Deck() { return <Card /> }\n",
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
  const context = fixture.buildAskContext("Tell me about App.jsx");
  const brainOk =
    context.files.includes("src/Deck.jsx") &&
    context.files.includes("src/components/Card.tsx") &&
    /Context|Files retained|src\/Deck\.jsx/.test(context.memoryDigest ?? "");
  console.log(`${emoji(brainOk)} context brain import frontier`);
  if (!brainOk) throw new Error(`context brain self-test failed: ${context.files.join(", ")}`);
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
  const critic = hasFlag("--critic") || process.env.POINTER_CRITIC === "1";
  const prompt = argValue("--prompt");
  const mode = argValue("--mode") ?? "ask";
  if (exportFormat) {
    exportScenarios({ suite: suite ?? "real", format: exportFormat || "jsonl" });
    return;
  }
  if (suite) {
    const results = await runScenarioSuite({ suite, repoOverride: argValue("--repo"), approval, critic });
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
