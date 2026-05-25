/**
 * Rank file candidates for the @-mention picker.
 *
 * Why a custom ranker? `Array.filter(includes()).slice(0, 8)` is
 * roughly "alphabetic order of the first eight matching files",
 * which feels arbitrary. Engineers expect mention pickers to behave
 * like Cmd+P: exact / prefix / acronym matches first, recents bumped
 * to the top, currently-open tabs lifted a notch, ties broken by
 * shorter paths.
 *
 * Scoring is additive: each signal contributes points and the final
 * list is sorted by descending score. Buckets are integer-weighted
 * so the order is determined by signal kind first, signal precision
 * second.
 *
 *   • EXACT basename match              +1000
 *   • basename PREFIX match              +500
 *   • CamelCase initials match           +400
 *   • basename CONTAINS query            +200
 *   • path CONTAINS query                +100
 *   • RECENT edit (last 8 touched)       +60
 *   • currently OPEN tab                 +30
 *   • shorter path bonus (per missing /) +1
 *
 * Empty query is a valid case: we ignore match scoring and just sort
 * by the recency / open-tab signals. This is what the picker shows
 * when the user just typed `@` and hasn't narrowed yet.
 */

export type Candidate = { path: string };

export type RankerInput = {
  candidates: Candidate[];
  query: string;
  recents: { path: string }[];
  openTabs: { path: string }[];
  /** Hard cap on the returned set. Default 8 (the picker shows
   *  that many rows before scrolling). */
  limit?: number;
};

export function rankFileCandidates(input: RankerInput): Candidate[] {
  const limit = input.limit ?? 8;
  const q = input.query.trim();
  const ql = q.toLowerCase();
  const recentPaths = new Set(input.recents.map((r) => r.path));
  const openPaths = new Set(input.openTabs.map((t) => t.path));

  const scored: Array<{ c: Candidate; score: number }> = [];
  for (const c of input.candidates) {
    const score = scoreCandidate(c.path, ql, q, recentPaths, openPaths);
    if (q && score <= 0) continue; // no query == let everything through
    scored.push({ c, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tie-break: shorter path wins (closer to workspace root).
    return a.c.path.length - b.c.path.length;
  });
  return scored.slice(0, limit).map((s) => s.c);
}

function scoreCandidate(
  path: string,
  ql: string,
  qOriginal: string,
  recentPaths: Set<string>,
  openPaths: Set<string>,
): number {
  // First compute the match contribution. When a query is present,
  // we REQUIRE at least one match signal before the candidate is
  // considered at all. That way "no candidate matches" returns an
  // empty list instead of a recency-sorted fallback (which would be
  // very confusing UX).
  let match = 0;
  let matched = false;
  if (ql) {
    const base = basename(path).toLowerCase();
    const pathLower = path.toLowerCase();
    if (base === ql) {
      match += 1000;
      matched = true;
    } else if (base.startsWith(ql)) {
      match += 500;
      matched = true;
    }
    if (camelInitialsMatch(basename(path), qOriginal)) {
      match += 400;
      matched = true;
    }
    if (base.includes(ql) && !base.startsWith(ql)) {
      match += 200;
      matched = true;
    }
    if (pathLower.includes(ql) && !base.includes(ql)) {
      match += 100;
      matched = true;
    }
    if (!matched) return 0;
  }
  let score = match;
  if (recentPaths.has(path)) score += 60;
  if (openPaths.has(path)) score += 30;
  // Closer-to-root bias — a small nudge so files near the workspace
  // root edge out deeply-nested namesakes.
  score += Math.max(0, 20 - (path.match(/\//g)?.length ?? 0));
  // Guarantee a non-zero score so the >0 check upstream still
  // accepts the candidate even if the closer-to-root term zeros out.
  return Math.max(score, 1);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Match the uppercase letters in a basename against the user's
 * query. e.g. query "mp" matches "MentionPicker.tsx" (M and P are
 * the capitals).
 *
 * The query is treated case-insensitively; the candidate's capitals
 * are the haystack. We require every query letter to be consumed in
 * order so that "mp" doesn't match "MP3Player".
 */
function camelInitialsMatch(base: string, query: string): boolean {
  if (!query) return false;
  const initials: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const c = base[i];
    if (i === 0 && /[A-Za-z]/.test(c)) {
      initials.push(c.toLowerCase());
    } else if (i > 0 && /[A-Z]/.test(c)) {
      initials.push(c.toLowerCase());
    }
  }
  // Match the user's chars in order against the initials.
  let qi = 0;
  for (const init of initials) {
    if (init === query[qi]?.toLowerCase()) qi += 1;
    if (qi === query.length) return true;
  }
  return qi === query.length;
}
