import { ipc } from "@/lib/ipc";

/**
 * Per-process cache of the workspace brief. The brief is cheap to
 * generate (well under 50ms in practice) but we still avoid re-paying
 * the cost on every chat send — it only changes when the workspace
 * root changes, the user edits README/manifests, or the git remote
 * flips. The first two cases invalidate via `useWorkspace.setRoot`;
 * the third is rare enough to ignore until users complain.
 *
 * Keyed by absolute workspace path so opening, switching, and coming
 * back to a workspace doesn't re-fetch when nothing material has
 * changed in this process's lifetime.
 */
let cache: { root: string; brief: string } | null = null;

/**
 * Fetch the brief for `root`, falling back to the empty string when:
 *   - no workspace is open (root == null), or
 *   - the backend errors (we never want a transient IPC hiccup to
 *     block a chat send — better to send the prompt without the brief
 *     than to fail the whole turn).
 */
export async function getWorkspaceBrief(root: string | null): Promise<string> {
  if (!root) return "";
  if (cache?.root === root) return cache.brief;
  try {
    const r = await ipc.workspaceBrief(root);
    cache = { root, brief: r.text };
    return r.text;
  } catch {
    return "";
  }
}

/**
 * Drop the cached brief. Call this when the workspace root changes
 * (so the next chat/agent turn re-fetches against the new root) and
 * could also be called from a future file-watcher hook when README or
 * a top-level manifest changes. Safe to call from anywhere.
 */
export function invalidateWorkspaceBrief(): void {
  cache = null;
}
