/**
 * Compute Monaco decoration descriptors for the chat + agent pending
 * reference lists, scoped to the editor's currently active file.
 *
 * The Editor component pulls this through `useEffect` whenever the
 * pending refs change and pushes the result through
 * `editor.deltaDecorations(prev, next)`. Keeping the descriptor
 * generation pure means we can unit-test the line/range math without
 * spinning up Monaco in JSDOM.
 *
 * Two staged surfaces (chat / agent) share the same decoration types
 * but use slightly different CSS so the user can tell which surface
 * owns the highlight at a glance.
 */

import type { Reference } from "@/store/chat";

export type StagedSurface = "chat" | "agent";

/** A minimal subset of Monaco's decoration descriptor — enough to
 *  pass to `editor.deltaDecorations`. We don't import Monaco's types
 *  here because the module is also used by pure unit tests that don't
 *  spin up the editor. */
export type StagedDecoration = {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  options: {
    className: string;
    linesDecorationsClassName: string;
    isWholeLine: boolean;
    hoverMessage: { value: string };
    overviewRuler: {
      color: string;
      position: number;
    };
  };
};

const POSITION_RIGHT = 4; // Monaco's OverviewRulerLane.Right; kept as a constant so the unit test doesn't drag in the editor types.

/**
 * Build the descriptor list for `refs` filtered to `activePath`.
 *
 * Only `selection` and `diagnostic` references carry line ranges —
 * other kinds (file, codebase, folder…) don't have an in-file
 * anchor, so they don't get drawn.
 */
export function aiStageDecorationsFor(
  refs: Reference[],
  surface: StagedSurface,
  activePath: string | null,
): StagedDecoration[] {
  if (!activePath) return [];
  const out: StagedDecoration[] = [];
  const agentSuffix = surface === "agent" ? " pn-ai-staged-agent" : "";
  for (const r of refs) {
    if (r.kind === "selection" && samePath(r.path, activePath)) {
      out.push({
        range: {
          startLineNumber: r.startLine,
          startColumn: 1,
          endLineNumber: r.endLine,
          endColumn: 1 << 30,
        },
        options: {
          className: "pn-ai-staged-range" + agentSuffix,
          linesDecorationsClassName: "pn-ai-staged-gutter" + agentSuffix,
          isWholeLine: true,
          hoverMessage: {
            value: `**Attached to ${surface}**\n\nLines ${r.startLine}–${r.endLine}`,
          },
          overviewRuler: {
            color:
              surface === "agent"
                ? "rgba(214, 188, 255, 0.6)"
                : "rgba(255, 45, 126, 0.6)",
            position: POSITION_RIGHT,
          },
        },
      });
    } else if (r.kind === "diagnostic" && samePath(r.path, activePath)) {
      const summary = r.code
        ? `${r.severity.toUpperCase()} ${r.source} ${r.code}`
        : `${r.severity.toUpperCase()} ${r.source}`;
      out.push({
        range: {
          startLineNumber: r.startLine,
          startColumn: r.startCol,
          endLineNumber: r.endLine,
          endColumn: r.endCol,
        },
        options: {
          className: "pn-ai-staged-range" + agentSuffix,
          linesDecorationsClassName: "pn-ai-staged-gutter" + agentSuffix,
          isWholeLine: false,
          hoverMessage: {
            value: `**Attached to ${surface}** — ${summary}\n\n${r.message}`,
          },
          overviewRuler: {
            color:
              surface === "agent"
                ? "rgba(214, 188, 255, 0.6)"
                : "rgba(255, 45, 126, 0.6)",
            position: POSITION_RIGHT,
          },
        },
      });
    }
  }
  return out;
}

/** Loose equality — file paths come in via Monaco URIs, OS paths, and
 *  Windows-with-drive-letter forms. We normalise to forward slashes and
 *  compare case-sensitively (Windows callers should pass paths that
 *  match the editor's URI casing). */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}
