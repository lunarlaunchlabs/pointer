// Shared utilities for the quality harness.
//
// Drives the live local Ollama server the same way the Tauri backend
// would, so anything we prove here translates directly to the running
// app. Pure ESM, no external deps beyond node:* stdlib.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
export const MODEL = process.env.POINTER_MODEL || "qwen2.5-coder:7b-instruct";

/** POST a JSON body to a JSON endpoint, return parsed response. */
async function postJson(url, body, { timeoutMs = 180_000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Stream Ollama's NDJSON generate endpoint and concatenate the
 * `response` tokens into a single string. We always use `stream:true`
 * and request raw mode so callers can pass the literal FIM template
 * unchanged.
 */
export async function generateRaw({ prompt, options = {}, raw = true, timeoutMs }) {
  const url = `${OLLAMA}/api/generate`;
  const body = {
    model: MODEL,
    prompt,
    raw,
    stream: true,
    options: { temperature: 0.2, num_predict: 256, ...options },
  };
  const ctrl = new AbortController();
  if (timeoutMs) setTimeout(() => ctrl.abort(), timeoutMs);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`generate HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.response) out += j.response;
        if (j.done) return out;
      } catch {
        // partial line — keep accumulating
      }
    }
  }
  return out;
}

/** Hit the chat endpoint. Returns the assistant text. */
export async function chat({ system, messages, options = {} }) {
  const url = `${OLLAMA}/api/chat`;
  const body = {
    model: MODEL,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ],
    stream: true,
    options: { temperature: 0.2, num_predict: 1500, ...options },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`chat HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const tok = j?.message?.content;
        if (tok) out += tok;
        if (j.done) return out;
      } catch {}
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Format parsing — replicates Pointer's SEARCH/REPLACE parser.
// ─────────────────────────────────────────────────────────────────

/**
 * Parse hunks from a chat response. Mirrors src/lib/diff.ts so the
 * harness pass-rate corresponds 1:1 with what the running app would
 * see — anything we add to the prod parser must show up here too.
 *
 * Forms handled:
 *   1. `<<<<<<< SEARCH path\n…\n=======\n…\n>>>>>>> REPLACE`  (edit)
 *   2. Same with empty SEARCH                                    (create)
 *   3. `<file path="…">…</file>`                                 (create)
 *   4. ` \`\`\`lang title="path"\n…\n\`\`\` `                            (create)
 *   5. ` \`\`\`lang path/to/file\n…\n\`\`\` ` (model drift fallback)    (create)
 */
const HUNK_RE =
  /(?:```[\w-]*\n)?(?:<<<<<<<\s*SEARCH(?:\s+([^\n]+))?\n)([\s\S]*?)\n?=======\n([\s\S]*?)\n>>>>>>>\s*REPLACE(?:\n```)?/g;
const NEW_FILE_RE =
  /<file\s+(?:action="?(?:create|new|overwrite)"?\s+)?path="([^"]+)"\s*>\n?([\s\S]*?)\n?<\/file>/gi;
const FENCED_NEW_FILE_RE =
  /```[\w-]*\s*(?:title|file|name)="([^"]+)"\s*\n([\s\S]*?)\n```/g;
const FENCED_PATH_RE = /```([\w-]+)[ \t]+([^\s`]+)\n([\s\S]*?)\n```/g;

function looksLikePath(token) {
  if (token.includes("=") || token.includes('"') || token.includes("'")) return false;
  if (token.includes("/")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

export function parseSearchReplace(text) {
  const hunks = [];
  let m;
  HUNK_RE.lastIndex = 0;
  while ((m = HUNK_RE.exec(text)) !== null) {
    const p = (m[1] ?? "").trim();
    hunks.push({ path: p || null, search: m[2] ?? "", replace: m[3] ?? "" });
  }
  NEW_FILE_RE.lastIndex = 0;
  while ((m = NEW_FILE_RE.exec(text)) !== null) {
    hunks.push({ path: m[1].trim(), search: "", replace: m[2] });
  }
  FENCED_NEW_FILE_RE.lastIndex = 0;
  while ((m = FENCED_NEW_FILE_RE.exec(text)) !== null) {
    hunks.push({ path: m[1].trim(), search: "", replace: m[2] });
  }
  FENCED_PATH_RE.lastIndex = 0;
  while ((m = FENCED_PATH_RE.exec(text)) !== null) {
    const p = m[2].trim();
    if (!looksLikePath(p)) continue;
    const dupe = hunks.some(
      (h) => h.path === p && h.search === "" && h.replace === m[3],
    );
    if (dupe) continue;
    hunks.push({ path: p, search: "", replace: m[3] });
  }
  // Last-resort: a fenced block whose FIRST line is a comment that
  // names a quoted path (e.g. `// CREATE file path="src/foo.js"`).
  // Mirrors the same fallback in src/lib/diff.ts.
  const HEADER_COMMENT_RE =
    /```([\w-]+)\n[ \t]*(?:\/\/|#|--)\s*[^\n]*?path\s*[:=]\s*["']([^"']+)["'][^\n]*\n([\s\S]*?)\n```/g;
  while ((m = HEADER_COMMENT_RE.exec(text)) !== null) {
    const p = m[2].trim();
    if (!p) continue;
    const replaceBody = m[3];
    const dupe = hunks.some(
      (h) => h.path === p && h.search === "" && h.replace === replaceBody,
    );
    if (dupe) continue;
    hunks.push({ path: p, search: "", replace: replaceBody });
  }
  return hunks;
}

/**
 * Apply hunks to a file contents string. Returns
 *   { text, applied, missed: ['hunk-0', ...] }.
 *
 * Mirrors `applyHunks` in src/lib/diff.ts: each SEARCH must occur
 * exactly once (we tolerate a leading newline difference but no
 * whitespace fuzz). Misses are logged for diagnostics.
 */
export function applyHunks(text, hunks) {
  let out = text;
  let applied = 0;
  const missed = [];
  hunks.forEach((h, idx) => {
    if (!h.search.trim()) {
      // CREATE — caller decides what to do; we just report.
      missed.push({ idx, reason: "empty-search (create-file hunk)" });
      return;
    }
    const i = out.indexOf(h.search);
    if (i === -1) {
      missed.push({ idx, reason: "search-not-found", searchHead: h.search.slice(0, 80) });
      return;
    }
    out = out.slice(0, i) + h.replace + out.slice(i + h.search.length);
    applied += 1;
  });
  return { text: out, applied, missed };
}

/**
 * Parse `<file path="...">…</file>` create-blocks from an agent or
 * chat response. These complement the SEARCH/REPLACE format for the
 * "no existing file to anchor against" case.
 */
export function parseFileBlocks(text) {
  const re = /<file\s+path=\"([^\"]+)\">([\s\S]*?)<\/file>/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ path: m[1], content: m[2] });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Sandboxed TS / JS check.
//
// Writes the candidate code to a temp file, runs `node --check`
// for JS or compiles via TypeScript for TS. Returns ok/err with
// stderr captured.
// ─────────────────────────────────────────────────────────────────

export function tmpDir(prefix = "pointer-qual-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function checkJsSyntax(code) {
  const dir = tmpDir();
  const file = path.join(dir, "snippet.mjs");
  fs.writeFileSync(file, code);
  const r = spawnSync("node", ["--check", file], { encoding: "utf-8" });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: r.stderr.trim() };
}

/**
 * Evaluate a JavaScript function's behaviour. The candidate code
 * must export a named function called `fnName`. We dynamically
 * import it and run the supplied I/O pairs.
 */
export async function runJsCases(code, fnName, cases) {
  const dir = tmpDir();
  const file = path.join(dir, "snippet.mjs");
  fs.writeFileSync(file, code);
  try {
    const mod = await import(`file://${file}?bust=${Date.now()}`);
    const fn = mod[fnName] ?? mod.default;
    if (typeof fn !== "function") {
      return { ok: false, error: `export "${fnName}" is not a function` };
    }
    const results = [];
    for (const c of cases) {
      try {
        const got = await fn(...c.args);
        const pass = deepEqual(got, c.expected);
        results.push({ pass, got, expected: c.expected, args: c.args });
      } catch (e) {
        results.push({ pass: false, error: e.message, args: c.args });
      }
    }
    const allPass = results.every((r) => r.pass);
    return { ok: allPass, results };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Result formatting
// ─────────────────────────────────────────────────────────────────

export function bar(title) {
  const line = "─".repeat(Math.max(0, 64 - title.length - 4));
  return `\n── ${title} ${line}`;
}

export function emoji(ok) {
  return ok ? "✓ PASS" : "✗ FAIL";
}
