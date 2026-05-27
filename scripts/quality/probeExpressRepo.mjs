#!/usr/bin/env node
// Real Express repo probe for Pointer's Ask, Plan, and Agent flows.
//
// This copies /Users/sameer/express to a temp directory, injects a
// focused regression, and then asks the live local model to behave like
// a senior engineer against that real checkout. The source repo is never
// modified.

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

const SOURCE_REPO = process.env.EXPRESS_REPO || "/Users/sameer/express";
const TARGETED_LINKS_TEST =
  "npx mocha --require test/support/env --reporter dot --check-leaks test/res.links.js";

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
  "coverage",
  ".nyc_output",
  "tmp",
  ".cache",
]);

const TEXT_EXTS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const TEXT_NAMES = new Set([
  "LICENSE",
  "Makefile",
  "package",
  "package.json",
  "readme",
]);

function askSystem(brief) {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

You are in ASK mode - answer questions and explain code. Do NOT emit edit blocks, tool tags, shell commands, or triple-backtick code fences.

ASK MODE OUTPUT CONTRACT:
- Prose only. The literal string \`\`\` is forbidden.
- Inline code spans are OK; multi-line code examples are not.
- If the context includes a <file> block for a named file, answer from that file. Do not claim you lack access to it.
- For "tell me about <file>" style questions, answer with the file's purpose, important imports/exports, state or data flow, and notable risks or neighboring files worth checking.
- When explaining core framework/runtime files, name concrete configuration defaults, compatibility hooks, and routing/middleware paths visible in the file instead of smoothing them into generic summaries.
- Name important top-level functions and methods by their literal identifiers (for example \`app.handle\`, \`app.use\`, \`defaultConfiguration\`) when they are central to the file.
- Do not compress literal setting names into "configuration"; if keys such as \`trust proxy\`, \`etag\`, or \`query parser\` appear in the file, name them.

Workspace brief:
${brief}`;
}

function expressBrief(root) {
  return [
    `- root: ${root}`,
    "- project: Express, a CommonJS Node.js web framework",
    "- key source files: lib/application.js, lib/request.js, lib/response.js, lib/express.js",
    "- tests: mocha under test/ and test/acceptance/",
    `- targeted verification command for this probe: ${TARGETED_LINKS_TEST}`,
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

function copyExpressToTemp() {
  assert(fs.existsSync(SOURCE_REPO), `Express repo not found: ${SOURCE_REPO}`);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-express-"));
  const dest = path.join(parent, "express");
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
  return { cmd, output: compact(`${r.stdout}\n${r.stderr}`, 1200) };
}

function introduceLinksRegression(root) {
  const file = path.join(root, "lib/response.js");
  const original = fs.readFileSync(file, "utf-8");
  const good = `  return this.set('Link', link + Object.keys(links).map(function(rel) {
    // Allow multiple links if links[rel] is an array
    if (Array.isArray(links[rel])) {
      return links[rel].map(function (singleLink) {
        return \`<\${singleLink}>; rel="\${rel}"\`;
      }).join(', ');
    } else {
      return \`<\${links[rel]}>; rel="\${rel}"\`;
    }
  }).join(', '));`;
  const bad = `  return this.set('Link', link + Object.keys(links).map(function(rel) {
    return \`<\${links[rel]}>; rel="\${rel}"\`;
  }).join(', '));`;
  assert(original.includes(good), "Could not find the expected res.links array-handling block");
  fs.writeFileSync(file, original.replace(good, bad));
}

function isTextPath(p) {
  const name = path.basename(p);
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTS.has(ext) || TEXT_NAMES.has(name) || TEXT_NAMES.has(name.toLowerCase());
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
          let idx = lower.indexOf(term);
          let seen = 0;
          while (idx !== -1 && seen < 3) {
            score += 10;
            const lineNo = text.slice(0, idx).split("\n").length;
            const line = text.split("\n")[lineNo - 1]?.trim().slice(0, 180) ?? "";
            snippets.push(`${file}:${lineNo}: ${line}`);
            idx = lower.indexOf(term, idx + term.length);
            seen += 1;
          }
        }
        if (score > 0) scored.push({ file, score, snippets });
      }
      scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
      const top = scored.slice(0, 15);
      if (top.length === 0) {
        return {
          status: "ok",
          text: `discover: no files mention any of: ${terms.join(", ")}`,
        };
      }
      const lines = [
        `discover: topic=\`${body.trim()}\`, keywords=[${terms.join(", ")}]`,
        "",
        `Top files (${top.length}):`,
      ];
      for (const hit of top) {
        lines.push(`  ${hit.file}  (score ${hit.score})`);
        for (const snippet of hit.snippets.slice(0, 3)) lines.push(`    > ${snippet}`);
      }
      const dirs = [
        ...new Set(top.slice(0, 5).map((hit) => path.dirname(hit.file)).filter((dir) => dir !== ".")),
      ];
      for (const dir of dirs) {
        const outline = await diskToolRunner(
          repo,
          { tool: "list_code_definition_names", attrs: { path: `${dir}/` }, body: "" },
          mode,
        );
        if (outline.status === "ok" && !outline.text.startsWith("(no recognised")) {
          lines.push("", `Definitions under ${dir}/:`, outline.text.slice(0, 1400));
        }
      }
      return { status: "ok", text: lines.join("\n").slice(0, 9000) };
    }

    if (tool === "apply_diff" || tool === "edit_file") {
      const p = attrs.path;
      if (!p) return { status: "error", text: "missing path attribute" };
      if (!repo.has(p)) return { status: "error", text: `apply_diff: file \`${p}\` does not exist` };
      const existing = repo.read(p);
      const result = applyDiffBody(body, existing);
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

function traceSummary(trace) {
  return trace
    .map((turn) => {
      const attrs = turn.call?.attrs ?? {};
      const target = attrs.path ?? attrs.from ?? "";
      const call = turn.call ? `${turn.call.tool}${target ? `:${target}` : ""}` : "no-call";
      const result = turn.result ? ` ${turn.result.status}` : "";
      const flags = [
        turn.planRewriteRedirected ? "plan-rewrite" : null,
        turn.planCommandRedirected ? "command-rewrite" : null,
        turn.planGenericTestRedirected ? "generic-test" : null,
        turn.planBroadTestRedirected ? "broad-test" : null,
        turn.proseRedirected ? "prose-redirect" : null,
        turn.malformedToolRedirected ? `malformed-${turn.malformedToolRedirected}` : null,
        turn.planRedirected ? "plan-final-redirect" : null,
        turn.cycleNudged ? "cycle-nudge" : null,
      ].filter(Boolean);
      const text = (turn.sanitized ?? turn.response ?? "").replace(/\s+/g, " ").slice(0, 180);
      return `T${turn.turn}: ${call}${result}${flags.length ? ` [${flags.join(", ")}]` : ""} :: ${text}`;
    })
    .join("\n");
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
  const appFile = fs.readFileSync(path.join(root, "lib/application.js"), "utf-8");
  const response = await chat({
    system: askSystem(expressBrief(root)),
    messages: [
      {
        role: "user",
        content: `<file path="lib/application.js">\n\`\`\`js\n${appFile}\n\`\`\`\n</file>\n\nTell me about lib/application.js in this Express checkout as if I am about to review a contribution there.`,
      },
    ],
    options: { temperature: 0.2, num_predict: 900 },
  });
  assertMatches(
    "Ask lib/application.js",
    response,
    [
      /application\.js|Express application|app/i,
      /defaultConfiguration|default configuration|settings/i,
      /etag|query parser|x-powered-by|trust proxy/i,
      /lazy|router/i,
      /app\.handle|handle/i,
      /app\.use|middleware|mount/i,
      /mount|inherit|prototype|parent/i,
    ],
    [/do(?:n't| not) have access/i, /share (?:the )?contents/i, /switch to Agent mode/i, /```/],
  );
  return response.trim();
}

async function runPlanProbe(root) {
  const repo = new DiskRepo(root);
  const goal = [
    "This is a real Express checkout.",
    "Plan how to fix the regression where `res.links({ last: [url1, url2] })` emits one malformed comma-joined URL instead of one Link entry per URL.",
    "Gather source and test context yourself. Name exact files, exact behavior, and exact verification command.",
    "PLAN MODE ONLY: do not edit files and do not run tests.",
  ].join("\n");
  const run = await driveAgent({
    goal,
    fs_: repo,
    maxTurns: 12,
    mode: "plan",
    workspace: root,
    openTabs: ["lib/response.js", "test/res.links.js"],
    activeFile: "lib/response.js",
    toolRunner: diskToolRunner,
  });
  const plan = extractPlan(run.trace);
  assert(
    run.terminated === "final",
    `Plan probe did not terminate cleanly: ${run.terminated}\n${traceSummary(run.trace)}`,
  );
  assert(usedContextTools(run.trace), "Plan probe did not gather codebase context with tools");
  assert(mutationCalls(run.trace).length === 0, "Plan probe attempted to mutate files");
  assertMatches(
    "Plan res.links regression",
    plan,
    [
      /lib\/response\.js/,
      /test\/res\.links\.js/,
      /Array\.isArray|array/i,
      /Link header|Link entries|rel=/i,
      /npx mocha[\s\S]*test\/res\.links\.js|test\/res\.links\.js[\s\S]*mocha/i,
    ],
    [/create a plan to create a plan/i, /update\s+test\/res\.links\.js|edit\s+test\/res\.links\.js/i],
  );
  return { run, plan };
}

async function runAgentProbe(root) {
  const repo = new DiskRepo(root);
  const beforeTest = fs.readFileSync(path.join(root, "test/res.links.js"), "utf-8");
  const goal = [
    "This is a real Express checkout.",
    "A regression in Express causes `res.links({ last: [url1, url2] })` to serialize a single comma-joined URL instead of one Link entry per URL.",
    "Find the right source and test context yourself, fix the source only, do not edit tests, and verify with this exact command:",
    TARGETED_LINKS_TEST,
  ].join("\n");
  const run = await driveAgent({
    goal,
    fs_: repo,
    maxTurns: 18,
    mode: "auto",
    workspace: root,
    openTabs: ["lib/response.js", "test/res.links.js"],
    activeFile: "lib/response.js",
    toolRunner: diskToolRunner,
  });
  const responseFile = fs.readFileSync(path.join(root, "lib/response.js"), "utf-8");
  const afterTest = fs.readFileSync(path.join(root, "test/res.links.js"), "utf-8");
  const runShells = run.trace.filter((turn) => turn.call?.tool === "run_shell");
  assert(run.terminated === "final", `Agent probe did not terminate cleanly: ${run.terminated}`);
  assert(usedContextTools(run.trace), "Agent probe did not gather source/test context with tools");
  assert(mutationCalls(run.trace).some((turn) => turn.call.attrs.path === "lib/response.js"), "Agent did not edit lib/response.js");
  assert(afterTest === beforeTest, "Agent edited test/res.links.js despite being asked not to");
  assert(/Array\.isArray\(links\[rel\]\)/.test(responseFile), "Agent did not restore array handling in res.links");
  assert(runShells.some((turn) => /res\.links\.js|mocha/.test(turn.call.body)), "Agent did not run the targeted mocha verification");
  const finalTest = command(root, TARGETED_LINKS_TEST, { timeoutMs: 180000 });
  assert(finalTest.code === 0, `Targeted test still fails after agent fix:\n${compact(finalTest.stdout)}\n${compact(finalTest.stderr)}`);
  return { run, final: extractFinal(run.trace), finalTest };
}

function originalExpressStatus() {
  const r = command(SOURCE_REPO, "git status --short", { timeoutMs: 30000 });
  return r.code === 0 ? r.stdout.trim() : "(git status unavailable)";
}

console.log(bar("Express real-repo Pointer probe"));
console.log(`Model: ${MODEL}`);
console.log(`Source repo: ${SOURCE_REPO}`);
const sourceStatusBefore = originalExpressStatus();
if (sourceStatusBefore) {
  console.log(`Source repo initial status:\n${sourceStatusBefore}`);
}

const tempRoot = copyExpressToTemp();
console.log(`Temp repo: ${tempRoot}`);

const install = installDeps(tempRoot);
console.log(`Installed dependencies with: ${install.cmd}`);

introduceLinksRegression(tempRoot);
const failing = command(tempRoot, TARGETED_LINKS_TEST, { timeoutMs: 180000 });
assert(
  failing.code !== 0,
  `Injected regression did not fail the targeted test. Output:\n${compact(failing.stdout)}\n${compact(failing.stderr)}`,
);

console.log("\nFAILING TEST BEFORE AGENT");
console.log(compact(`${failing.stdout}\n${failing.stderr}`, 1800));

const askResponse = await runAskProbe(tempRoot);
console.log("\nASK RESPONSE - lib/application.js");
console.log(askResponse);

const planProbe = await runPlanProbe(tempRoot);
console.log("\nPLAN RESPONSE - res.links array regression");
console.log(planProbe.plan);
console.log(`Tool path: ${toolPath(planProbe.run.trace)}`);

const agentProbe = await runAgentProbe(tempRoot);
console.log("\nAGENT FINAL - res.links array regression");
console.log(agentProbe.final || "(final block was empty)");
console.log(`Tool path: ${toolPath(agentProbe.run.trace)}`);

console.log("\nTARGETED TEST AFTER AGENT");
console.log(compact(`${agentProbe.finalTest.stdout}\n${agentProbe.finalTest.stderr}`, 1800));

const sourceStatusAfter = originalExpressStatus();
assert(
  sourceStatusAfter === sourceStatusBefore,
  `Original Express repo status changed.\nBefore:\n${sourceStatusBefore || "(clean)"}\nAfter:\n${sourceStatusAfter || "(clean)"}`,
);

console.log("\nExpress real-repo Pointer probe passed.");
console.log(`Original repo status was unchanged. Temp repo retained for inspection: ${tempRoot}`);
