/**
 * Refactor watcher — the glue between the rename observer and the
 * UI's suggestion banner.
 *
 * Lifecycle:
 *
 *   1. The app constructs ONE watcher at startup (see App.tsx).
 *   2. The editor calls `watcher.observe(path, content)` on every
 *      content change (it already does this via `updateContent`).
 *   3. The watcher keeps a per-path "last known snapshot". When a
 *      new content arrives and a debounce window elapses without
 *      further edits, it compares the snapshot to the latest
 *      content and runs `observeRename`.
 *   4. If a rename is detected, it queries the workspace search for
 *      occurrences of the old name and (if there are any) publishes
 *      a suggestion via `useRefactorSuggestions`.
 *
 * The search call is injectable so tests can stub it out cleanly.
 */

import type { TextHit } from "@/lib/ipc";
import { observeRename } from "./renameObserver";
import { useRefactorSuggestions } from "@/store/refactorSuggestions";

export type RefactorWatcher = {
  /** Record a new content snapshot for a path. */
  observe: (path: string, content: string) => void;
  /** Tear down timers / state. Idempotent. */
  dispose: () => void;
};

type Options = {
  /** Workspace text searcher — usually `ipc.searchText`. */
  search: (query: string, limit?: number) => Promise<TextHit[]>;
  /** How long to wait after the last edit before analysing.
   *  Defaults to ~800ms — long enough that the user has paused
   *  typing, short enough to feel responsive. */
  debounceMs?: number;
};

export function createRefactorWatcher(opts: Options): RefactorWatcher {
  const debounceMs = opts.debounceMs ?? 800;
  // Per-path: the BASELINE snapshot (what we compare *against*) and
  // the LATEST snapshot. The baseline is sticky — it only resets
  // after we've analysed or after a long quiet period.
  //
  // We cap the size to MAX_TRACKED files (most-recently-touched
  // entries kept; oldest evicted). Without this cap, touching
  // thousands of files in a long session would grow the maps
  // without bound.
  const MAX_TRACKED = 200;
  const baseline = new Map<string, string>();
  const latest = new Map<string, string>();
  const lru: string[] = []; // most-recent first
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function touch(path: string) {
    const idx = lru.indexOf(path);
    if (idx !== -1) lru.splice(idx, 1);
    lru.unshift(path);
    while (lru.length > MAX_TRACKED) {
      const drop = lru.pop()!;
      baseline.delete(drop);
      latest.delete(drop);
      const t = timers.get(drop);
      if (t) {
        clearTimeout(t);
        timers.delete(drop);
      }
    }
  }

  function schedule(path: string) {
    const existing = timers.get(path);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => analyse(path), debounceMs);
    timers.set(path, t);
  }

  async function analyse(path: string) {
    if (disposed) return;
    timers.delete(path);
    const before = baseline.get(path);
    const after = latest.get(path);
    if (before === undefined || after === undefined) return;
    if (before === after) {
      baseline.set(path, after);
      return;
    }
    const obs = observeRename(before, after);
    // Reset the baseline regardless of outcome — analysing the same
    // diff repeatedly is pointless. The new baseline becomes the
    // current "after" so subsequent edits diff from here.
    baseline.set(path, after);
    if (obs.kind !== "rename") return;
    let hits: TextHit[] = [];
    try {
      const all = await opts.search(obs.oldName, 200);
      // Exclude:
      //   • Hits in the source file (the rename already happened
      //     there).
      //   • Hits in non-source files (.md, .json, .lock, …) where a
      //     name appearance could be content rather than a symbol
      //     reference. Rewriting a README that mentions the old
      //     identifier is rude.
      //   • Trivial substring matches — we require a whole-word
      //     occurrence so `foo` doesn't drag `fooBar` along.
      const pattern = new RegExp(`\\b${escapeRegex(obs.oldName)}\\b`);
      hits = all.filter(
        (h) =>
          h.path !== path &&
          isSourceFile(h.path) &&
          pattern.test(h.text),
      );
    } catch {
      // Search backend down → silently skip the suggestion. This is
      // a "nice to have" feature, not a critical path.
      return;
    }
    if (hits.length === 0) return;
    useRefactorSuggestions.getState().propose({
      oldName: obs.oldName,
      newName: obs.newName,
      sourcePath: path,
      hits,
    });
  }

  return {
    observe: (path, content) => {
      if (disposed) return;
      touch(path);
      if (!baseline.has(path)) {
        baseline.set(path, content);
        latest.set(path, content);
        return;
      }
      latest.set(path, content);
      schedule(path);
    },
    dispose: () => {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      baseline.clear();
      latest.clear();
      lru.length = 0;
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Source-code file extensions we'll happily mass-rename in.
 *  Anything outside this set is treated as "documentation / config /
 *  generated" and excluded from rename apply targets. */
const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "scala",
  "rb",
  "php",
  "swift",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "lua",
  "dart",
  "ex",
  "exs",
  "elm",
  "ml",
  "fs",
  "fsx",
  "vue",
  "svelte",
  "astro",
  "css",
  "scss",
  "sass",
  "less",
  "sh",
  "bash",
  "zsh",
]);

function isSourceFile(path: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  if (!m) return false;
  return SOURCE_EXTENSIONS.has(m[1].toLowerCase());
}
