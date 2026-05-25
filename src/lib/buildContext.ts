/**
 * Shared "build context" pipeline.
 *
 * Both Chat and Agent compose a single context blob from the user's
 * pending references — file contents, selections, codebase search hits,
 * diagnostics, processed file extracts, and so on. The logic used to live
 * inside `Chat/Sidebar.tsx`; pulling it here means:
 *
 *   • The Agent panel can use the *exact same* reference UX without a
 *     copy-paste fork.
 *   • The semantics of every reference kind (priority, framing, budget)
 *     are decided in one place, so chat and agent never disagree about
 *     what "@codebase" means.
 *
 * The output is plain text suitable for splicing into a system prompt
 * (chat) or the agent's `context` IPC field. Whitespace / framing is
 * deliberately consistent across both surfaces.
 */

import { ipc } from "@/lib/ipc";
import {
  PromptBudget,
  codebaseBlock,
  diagnosticBlock,
  fileBlock,
  folderBlock,
  selectionBlock,
} from "@/lib/prompt";
import type { Reference } from "@/store/chat";

export type BuildContextOptions = {
  /** Token budget for the whole context blob. Chat uses ~6k; agent uses
   *  more (~10k) because its goal text is shorter and it benefits more
   *  from context. */
  budgetTokens?: number;
  /** Embedding model for @codebase search. When undefined, codebase
   *  references are skipped (we can't run a search without an embedder). */
  embedModel?: string;
  /** Whether @codebase searches should actually run. The caller has the
   *  authoritative `isFeatureUsable("indexing")` view; we honour it. */
  codebaseUsable?: boolean;
  /** Optional fall-through "current file" anchor. When provided and not
   *  already referenced explicitly, we attach it at low priority so the
   *  model always knows what the user is *looking at*. */
  currentFile?: { path: string; content: string } | null;
};

export async function buildContext(
  refs: Reference[],
  opts: BuildContextOptions = {},
): Promise<string | undefined> {
  const budget = new PromptBudget(opts.budgetTokens ?? 6000);

  for (const r of refs) {
    if (r.kind === "file") {
      try {
        const text = await ipc.readTextFile(r.path);
        budget.push(80, "file", fileBlock(r.path, text));
      } catch {
        /* swallow — a missing file is an out-of-date ref, not a fatal */
      }
    } else if (r.kind === "folder") {
      try {
        const entries = await ipc.readWorkspaceTree(r.path);
        budget.push(
          70,
          "folder",
          folderBlock(
            r.path,
            entries.map((e) =>
              e.is_dir
                ? `${e.name}/`
                : `${e.name}${typeof e.size === "number" ? ` (${e.size}B)` : ""}`,
            ),
          ),
        );
      } catch {
        /* skip — folder may have been removed */
      }
    } else if (r.kind === "selection") {
      budget.push(
        100,
        "selection",
        selectionBlock(r.path, r.startLine, r.endLine, r.text),
      );
    } else if (r.kind === "diagnostic") {
      // Diagnostics get the *highest* priority — when the user lifts a
      // lint error into the conversation they want the model to focus on
      // exactly that. The snippet is small by construction so we don't
      // worry about budget.
      budget.push(
        110,
        "diagnostic",
        diagnosticBlock({
          path: r.path,
          startLine: r.startLine,
          startCol: r.startCol,
          endLine: r.endLine,
          endCol: r.endCol,
          severity: r.severity,
          source: r.source,
          code: r.code,
          message: r.message,
          snippet: r.snippet,
        }),
      );
    } else if (r.kind === "processed") {
      budget.push(
        90,
        "processed",
        [
          `## attached ${r.label.toLowerCase()} — ${r.path}`,
          r.model ? `processed-by: ${r.model}` : "raw extract",
          "",
          r.content,
        ].join("\n"),
      );
    } else if (r.kind === "codebase") {
      // Silently degrade when indexing isn't usable. The composer's
      // mention picker already flags this state; surfacing an error
      // here just doubles up the noise.
      if (!opts.codebaseUsable || !opts.embedModel) continue;
      try {
        const hits = await ipc.searchCodebase({
          query: r.query,
          limit: 6,
          embed_model: opts.embedModel,
        });
        budget.push(60, "codebase", codebaseBlock(hits.map((h) => h.chunk)));
      } catch {
        /* skip */
      }
    } else if (r.kind === "symbol") {
      // Symbol references are a thin convenience — we surface the symbol
      // name and the file path; the file content is already pulled in if
      // the user also added the file reference.
      budget.push(70, "symbol", `<symbol path="${r.path}" name="${r.name}" />`);
    }
  }

  if (
    opts.currentFile &&
    refs.every(
      (r) =>
        !(
          (r.kind === "file" || r.kind === "selection") &&
          r.path === opts.currentFile!.path
        ),
    )
  ) {
    budget.push(
      40,
      "current",
      fileBlock(opts.currentFile.path, opts.currentFile.content),
    );
  }

  const { text } = budget.build();
  return text || undefined;
}
