/** Aider-style search/replace hunk. Empty `search` means "create or overwrite this file". */
export type SearchReplaceHunk = {
  path?: string;
  search: string;
  replace: string;
};

const HUNK_RE =
  /(?:```[\w-]*\n)?(?:<<<<<<<[ \t]*SEARCH(?:[ \t]+([^\n]+))?[ \t]*\n)([\s\S]*?)\n?=======\n([\s\S]*?)\n>>>>>>>\s*REPLACE(?:\n```)?/g;

const NEW_FILE_RE =
  /<file\s+(?:action="?(?:create|new|overwrite)"?\s+)?path="([^"]+)"\s*>\n?([\s\S]*?)\n?<\/file>/gi;

const FENCED_NEW_FILE_RE =
  /```[\w-]*\s*(?:title|file|name)="([^"]+)"\s*\n([\s\S]*?)\n```/g;

// Fallback for the very common shape `\`\`\`lang path/to/file\n…code…\n\`\`\``.
// Many models emit this even when asked to use SEARCH/REPLACE — it's the
// shape they were trained on. Rather than silently dropping it, treat it
// as "rewrite this file from scratch" (path on the fence line acts as
// the anchor). We're conservative: the token after the language must
// look like a path — contains a slash or has a known extension — so
// plain ` ```javascript ` blocks aren't misinterpreted.
const FENCED_PATH_RE =
  /```([\w-]+)[ \t]+([^\s`]+)\n([\s\S]*?)\n```/g;

function looksLikePath(token: string): boolean {
  // attribute-shaped tokens (title="…", name='…', etc.) are already
  // handled by FENCED_NEW_FILE_RE — never treat them as bare paths.
  if (token.includes("=") || token.includes('"') || token.includes("'")) {
    return false;
  }
  if (token.includes("/")) return true;
  // accept paths with a dotted extension like `clamp.js` or `App.tsx`
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

export function parseSearchReplace(text: string): SearchReplaceHunk[] {
  const hunks: SearchReplaceHunk[] = [];
  let m: RegExpExecArray | null;
  HUNK_RE.lastIndex = 0;
  while ((m = HUNK_RE.exec(text)) !== null) {
    const rawPath = m[1]?.trim();
    let search = m[2] ?? "";
    let path = rawPath;
    if (!path) {
      const nl = search.indexOf("\n");
      const first = nl === -1 ? search.trim() : search.slice(0, nl).trim();
      if (nl !== -1 && looksLikePath(first)) {
        path = first;
        search = search.slice(nl + 1);
      }
    }
    hunks.push({ path, search, replace: m[3] ?? "" });
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
    const pathArg = m[2].trim();
    if (!looksLikePath(pathArg)) continue;
    // Skip if this exact text is already covered by an earlier
    // match — the previous regexes look for `title="path"`, which
    // is a *subset* of the fenced-path shape; we don't want double
    // hunks.
    const dupe = hunks.some(
      (h) => h.path === pathArg && h.search === "" && h.replace === m![3],
    );
    if (dupe) continue;
    hunks.push({ path: pathArg, search: "", replace: m[3] });
  }
  // Last-resort: a fenced block whose FIRST line is a `// …path…` or
  // `# …path…` comment that names a quoted path. Some local coders
  // emit this drift mode instead of a clean SEARCH/REPLACE; treating
  // it as a create-or-overwrite keeps the user's edit from getting
  // silently dropped.
  const HEADER_COMMENT_RE =
    /```([\w-]+)\n[ \t]*(?:\/\/|#|--)\s*[^\n]*?path\s*[:=]\s*["']([^"']+)["'][^\n]*\n([\s\S]*?)\n```/g;
  while ((m = HEADER_COMMENT_RE.exec(text)) !== null) {
    const pathArg = m[2].trim();
    if (!pathArg) continue;
    const replaceBody = m[3];
    const dupe = hunks.some(
      (h) => h.path === pathArg && h.search === "" && h.replace === replaceBody,
    );
    if (dupe) continue;
    hunks.push({ path: pathArg, search: "", replace: replaceBody });
  }
  return hunks;
}

export function isCreationHunk(h: SearchReplaceHunk): boolean {
  return h.search.trim().length === 0 && !!h.path;
}

/** Apply a single hunk to file contents. Returns null on failure.
 *
 * Empty SEARCH means "this hunk is a create-or-overwrite": the
 * returned string is the full new file body, ignoring whatever was
 * there before. Production paths (Sidebar.tsx) check
 * `isCreationHunk` and route to `writeTextFile` directly, so this
 * branch is mostly for test code and inline-apply flows — but it
 * MUST return overwrite semantics, never a sneaky prepend.
 */
export function applyHunk(
  source: string,
  hunk: SearchReplaceHunk,
): string | null {
  if (hunk.search.length === 0) {
    return hunk.replace;
  }
  const idx = source.indexOf(hunk.search);
  if (idx === -1) {
    // Try a whitespace-tolerant match.
    const normSrc = source.replace(/\s+/g, " ");
    const normNeedle = hunk.search.replace(/\s+/g, " ");
    const ni = normSrc.indexOf(normNeedle);
    if (ni === -1) return null;
    // Fall back to a fuzzy line-based replacement.
    return source.replace(hunk.search, hunk.replace);
  }
  return source.slice(0, idx) + hunk.replace + source.slice(idx + hunk.search.length);
}

export function applyHunks(
  source: string,
  hunks: SearchReplaceHunk[],
): { text: string; applied: number; failed: number } {
  let out = source;
  let applied = 0;
  let failed = 0;
  for (const h of hunks) {
    const next = applyHunk(out, h);
    if (next === null) failed++;
    else {
      out = next;
      applied++;
    }
  }
  return { text: out, applied, failed };
}
