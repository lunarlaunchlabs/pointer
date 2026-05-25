/**
 * Build an enriched FIM (Fill-In-Middle) prompt that gives the
 * completion model the same kind of context a human collaborator
 * would have: nearby pattern, freshly-edited files, currently-open
 * tabs.
 *
 * Why this matters:
 *   • The default Monaco prefix / suffix is just the surrounding 200
 *     lines of the active file. The model never sees the rest of the
 *     repo, so it has to *guess* type shapes, library APIs, and
 *     project naming conventions on every keystroke.
 *   • Qwen2.5-Coder (our reference model) supports a "repo-level FIM"
 *     prompt format: `<|file_sep|>path\n<content>\n` blocks before
 *     the usual `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`. The
 *     backend already lists `<|file_sep|>` as a stop token, so we
 *     can splice these reference blocks in front of the local prefix
 *     without any backend changes.
 *   • For local pattern continuation (lists, imports, repeated calls)
 *     we drop a one-line `# Pattern: …` comment so the model sees an
 *     explicit nudge in the language's own comment style.
 *
 * The contract this module preserves:
 *
 *   1. **The local prefix is sacred.** No matter how tight the budget
 *      gets, the last thing in the assembled prompt is the user's
 *      verbatim Monaco prefix. Truncating it would change what the
 *      model is asked to complete.
 *   2. **Suffix passes through.** Same logic — suffix gets consumed
 *      by the FIM template after `<|fim_suffix|>`; we don't mess
 *      with it here.
 *   3. **References are budgeted, lowest-priority first.** When the
 *      char budget is tight we drop trailing references, never the
 *      head ones (which are the most-recently edited).
 *   4. **Deterministic.** Same inputs → same outputs. No clocks, no
 *      randomness, no IO.
 *
 * Everything is `string -> string`. The caller does any IO needed
 * (file reads, store reads) and hands us snapshots.
 */

import { detectPattern, type DetectedPattern } from "./patterns";

export type FimContextInput = {
  /** Workspace-relative path of the file the user is editing. We use
   *  this purely for labeling references; it's never read off disk. */
  filePath: string;
  /** The text BEFORE the cursor. We splice this verbatim at the end
   *  of the assembled prompt. */
  prefix: string;
  /** The text AFTER the cursor. Passes through unchanged. */
  suffix: string;
  /** Source language (Monaco's language id is fine here). Drives the
   *  comment style of any hint comments we emit. */
  language: string;
  /** Recently-edited files, most-recent first. The caller should
   *  truncate each entry's content already (see useRecentEdits). */
  recentFiles: Array<{ path: string; content: string; touched: number }>;
  /** Other tabs currently open. Used as a fallback when the user
   *  hasn't actually edited a file recently but is reading along. */
  openTabs: Array<{ path: string; content: string }>;
  /** Cap on the assembled output, in characters. References are
   *  trimmed to fit; the local prefix is always preserved in full. */
  budgetChars: number;
};

export type FimContextOutput = {
  prefix: string;
  suffix: string;
  /** Stop sequences the caller should pass through to the backend.
   *  We don't add any new ones (the backend already stops on the
   *  Qwen FIM tokens) but the field is here for future hooks. */
  stop?: string[];
  trace: {
    referenceFiles: Array<{ path: string; chars: number; reason: string }>;
    patternHint?: string;
  };
};

/**
 * Maximum chars per reference file in the prompt. We don't want one
 * 50k-line file to evict every other reference. Each entry's content
 * is also pre-truncated by the recent-edits store; this is a second
 * line of defence at assembly time.
 */
const MAX_PER_REFERENCE = 1_200;

export function buildFimContext(input: FimContextInput): FimContextOutput {
  // 1. Pick the candidate references — recent edits, then open tabs,
  //    excluding the current file and de-duped by path. Recents come
  //    first because they're the most likely on the user's mind.
  const seen = new Set<string>([input.filePath]);
  const refs: Array<{ path: string; content: string; reason: string }> = [];
  for (const r of input.recentFiles) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    refs.push({
      path: r.path,
      content: clamp(r.content, MAX_PER_REFERENCE),
      reason: "recent-edit",
    });
  }
  for (const t of input.openTabs) {
    if (seen.has(t.path)) continue;
    seen.add(t.path);
    refs.push({
      path: t.path,
      content: clamp(t.content, MAX_PER_REFERENCE),
      reason: "open-tab",
    });
  }

  // 2. Detect any local pattern so we can prepend a `Pattern: …`
  //    hint comment. This is cheap (regex / string scans only).
  const pattern = detectPattern(input.prefix, input.suffix);
  const hint = patternHint(pattern, input.language);

  // 3. Frame each ref into a Qwen-FIM block. We do this as small
  //    chunks so we can trim from the tail without re-rendering.
  const blocks: string[] = [];
  for (const ref of refs) {
    blocks.push(`<|file_sep|>${ref.path}\n${ref.content}\n`);
  }

  // 4. Budget: reserve the local prefix's length, then fill in
  //    references and the pattern hint from the front, dropping
  //    trailing blocks until we fit.
  const reservedForLocal = input.prefix.length;
  const reservedForHint = hint ? hint.length + 2 : 0;
  const remainingForRefs = Math.max(
    0,
    input.budgetChars - reservedForLocal - reservedForHint,
  );
  const included: string[] = [];
  const includedTrace: FimContextOutput["trace"]["referenceFiles"] = [];
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (used + b.length > remainingForRefs) break;
    included.push(b);
    used += b.length;
    includedTrace.push({
      path: refs[i].path,
      chars: refs[i].content.length,
      reason: refs[i].reason,
    });
  }

  // 5. Assemble. Order:
  //    refs...refs <pattern-hint>\n<local-prefix>
  const head = included.join("");
  const assembled = `${head}${hint ? hint + "\n" : ""}${input.prefix}`;

  return {
    prefix: assembled,
    suffix: input.suffix,
    trace: {
      referenceFiles: includedTrace,
      patternHint: hint ? describePattern(pattern) : undefined,
    },
  };
}

/** Truncate `s` to at most `n` chars, taking the *head*. Files-as-
 *  context want the imports / types / public surface, not the
 *  closing braces. */
function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n);
}

/** Render a one-line comment hinting the pattern. We use the
 *  language's comment style so the model parses it as a comment, not
 *  as code (a `//` in Python would be a syntax error inside a
 *  function body, but in our prompt context the model would still
 *  read it — we just prefer to be polite). */
function patternHint(
  pattern: DetectedPattern,
  language: string,
): string | undefined {
  const desc = describePattern(pattern);
  if (!desc) return undefined;
  const c = commentSyntax(language);
  return `${c} Pattern: ${desc}`;
}

function describePattern(pattern: DetectedPattern): string | undefined {
  switch (pattern.kind) {
    case "list":
      return `list — ${pattern.count} repeated items. Template: ${truncate(
        pattern.template,
        80,
      )}`;
    case "import":
      return pattern.module
        ? `import-block from "${pattern.module}"`
        : "import-block in progress";
    case "signature":
      return "function signature in progress";
    case "body":
      return "function body in progress";
    case "none":
      return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Comment opener for a given language. We map every language we
 *  surface in the editor to a sensible default; anything unknown
 *  falls back to `//`. */
function commentSyntax(language: string): string {
  switch (language) {
    case "python":
    case "ruby":
    case "shell":
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "yaml":
    case "toml":
    case "ini":
    case "dockerfile":
    case "makefile":
    case "perl":
    case "r":
    case "elixir":
      return "#";
    case "lua":
    case "sql":
    case "ada":
      return "--";
    case "html":
    case "xml":
    case "vue":
    case "svelte":
    case "markdown":
    case "mdx":
      // `<!--` would need a closer; rather than worry about that we
      // fall back to `//` and let the model handle the framing — the
      // hint won't actually be compiled in any case.
      return "//";
    default:
      return "//";
  }
}
