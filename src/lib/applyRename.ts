/**
 * Apply a confirmed rename suggestion across the workspace.
 *
 * "Confirmed" here means the user clicked "Apply" on the rename
 * suggestion card — we already know
 *   • exactly which identifier is being renamed (whole word)
 *   • where the user did the original rename (we exclude that file)
 *   • which files have at least one hit (the prefiltered hit list)
 *
 * The applier is deliberately conservative:
 *
 *   1. Only whole-word matches are rewritten. `foo` -> `bar` will
 *      not touch `fooBar` or `foo_other`.
 *   2. Occurrences inside string literals (`"…"`, `'…'`, `` `…` ``)
 *      and comments (`// …`, `/* … *‌/`) are skipped. We can't tell
 *      whether a string mention is part of the API surface or
 *      content text, so we err on the side of safety.
 *   3. Per-file errors are swallowed (logged for diagnostics) — one
 *      unreadable file shouldn't block the rest of the apply.
 *
 * The function reads each affected file, runs the safe replacement,
 * and writes the result back. The editor store will pick up the new
 * content next time the user opens that tab (or if it's already
 * open, the file watcher reconciles it).
 */

import { ipc } from "@/lib/ipc";
import type { ActiveRenameSuggestion } from "@/store/refactorSuggestions";

export async function applyRenameAcrossWorkspace(
  suggestion: ActiveRenameSuggestion,
): Promise<void> {
  const { oldName, newName, sourcePath, hits } = suggestion;
  const paths = Array.from(
    new Set(hits.map((h) => h.path).filter((p) => p !== sourcePath)),
  );
  // Fire reads in parallel, then process serially so failures don't
  // poison the whole batch.
  await Promise.all(
    paths.map(async (path) => {
      try {
        const original = await ipc.readTextFile(path);
        const rewritten = safeReplaceIdentifier(original, oldName, newName);
        if (rewritten !== original) {
          await ipc.writeTextFile(path, rewritten);
        }
      } catch (e) {
        // Best-effort: keep going through the rest of the files.
        // We surface no error here; the UI's "Applying…" state will
        // resolve and the user can re-run if needed.
        console.warn(`[applyRename] ${path} skipped:`, e);
      }
    }),
  );
}

/**
 * Replace `oldName` with `newName` everywhere it appears as a
 * standalone identifier, EXCEPT inside string literals or comments.
 *
 * Implementation note: a single-pass scanner is enough and avoids
 * lexer baggage — we just track whether the cursor is inside a
 * string / template / comment, and only run the identifier
 * substitution when at "top-level". This is the same trick we use
 * in the rename observer's `stripStringsAndComments`.
 */
export function safeReplaceIdentifier(
  src: string,
  oldName: string,
  newName: string,
): string {
  // We build the result chunk-by-chunk. Each "chunk" is either
  // verbatim quoted/commented text (passed through) or plain code
  // (subject to identifier substitution).
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Line comment
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out.push(src.slice(i, stop));
      i = stop;
      continue;
    }
    // Block comment
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push(src.slice(i, stop));
      i = stop;
      continue;
    }
    // Strings: handle backslash escapes.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    // Code: scan until the next string / comment / EOF, then
    // replace identifiers in that chunk.
    const start = i;
    while (i < n) {
      const ch = src[i];
      const ch2 = src[i + 1];
      if (ch === "/" && (ch2 === "/" || ch2 === "*")) break;
      if (ch === '"' || ch === "'" || ch === "`") break;
      i += 1;
    }
    const chunk = src.slice(start, i);
    out.push(replaceWholeWord(chunk, oldName, newName));
  }
  return out.join("");
}

function replaceWholeWord(
  text: string,
  oldName: string,
  newName: string,
): string {
  const re = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");
  return text.replace(re, newName);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
