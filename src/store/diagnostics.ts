/**
 * Diagnostics store — aggregates Monaco marker data into a single
 * IDE-wide "Problems" view.
 *
 * Monaco's `editor.onDidChangeMarkers` fires *globally* whenever any
 * worker (TypeScript, JSON, CSS) updates its marker set. We subscribe
 * once at boot and keep a denormalised `Diagnostic[]` keyed by file URI
 * so the status bar count is O(1) and the Problems panel renders without
 * re-querying Monaco on every keystroke.
 *
 * Severity follows Monaco's `MarkerSeverity` enum:
 *   1 = Hint, 2 = Info, 4 = Warning, 8 = Error.
 * We translate to our own `"error"|"warning"|"info"|"hint"` strings so
 * downstream code doesn't have to import the Monaco types directly.
 */

import { create } from "@/lib/signalStore";
import type { Monaco } from "@monaco-editor/react";
import { ipc, type ProjectCheckInfo } from "@/lib/ipc";

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type Diagnostic = {
  /** Monaco model URI in string form, e.g. "file:///workspace/src/app.ts". */
  uri: string;
  /** Convenience: just the basename for compact UIs. */
  name: string;
  /** 1-based line/column numbers, matching Monaco's API and the editor UI. */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Lint origin: "ts", "tsserver", "json", "css", etc. */
  source: string;
  /** Optional language-specific error code. */
  code?: string;
};

type State = {
  /** Map URI → ordered diagnostic list. We store per-URI so refreshing one
   *  file doesn't disturb the others' references (helps React memoisation). */
  byUri: Record<string, Diagnostic[]>;
  monacoByUri: Record<string, Diagnostic[]>;
  projectByUri: Record<string, Diagnostic[]>;
  errors: number;
  warnings: number;
  projectCheck: {
    status: "idle" | "running";
    detected: ProjectCheckInfo | null;
    lastOutput: string | null;
    error: string | null;
  };
  installFromMonaco: (monaco: Monaco) => void;
  runProjectCheck: () => Promise<void>;
  clearProjectDiagnostics: () => void;
  /** Counts for a single file path. Used by the file tree to badge
   *  individual rows. Returns `{ errors: 0, warnings: 0 }` for
   *  files with no markers — callers can branch on that without a
   *  null check. */
  countsForPath: (path: string) => { errors: number; warnings: number };
};

const installedMonacos = new WeakSet<object>();

function severityFromMonaco(n: number): DiagnosticSeverity {
  // Monaco numeric values: 8=error, 4=warning, 2=info, 1=hint.
  if (n >= 8) return "error";
  if (n >= 4) return "warning";
  if (n >= 2) return "info";
  return "hint";
}

function recomputeCounts(byUri: Record<string, Diagnostic[]>): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const list of Object.values(byUri)) {
    for (const d of list) {
      if (d.severity === "error") errors += 1;
      else if (d.severity === "warning") warnings += 1;
    }
  }
  return { errors, warnings };
}

function mergeDiagnostics(
  monacoByUri: Record<string, Diagnostic[]>,
  projectByUri: Record<string, Diagnostic[]>,
): Record<string, Diagnostic[]> {
  const out: Record<string, Diagnostic[]> = {};
  for (const [uri, list] of Object.entries(monacoByUri)) {
    out[uri] = [...list];
  }
  for (const [uri, list] of Object.entries(projectByUri)) {
    out[uri] = [...(out[uri] ?? []), ...list];
  }
  return out;
}

function groupByUri(list: Diagnostic[]): Record<string, Diagnostic[]> {
  const out: Record<string, Diagnostic[]> = {};
  for (const d of list) {
    out[d.uri] = [...(out[d.uri] ?? []), d];
  }
  return out;
}

export const useDiagnostics = create<State>((set, get) => ({
  byUri: {},
  monacoByUri: {},
  projectByUri: {},
  errors: 0,
  warnings: 0,
  projectCheck: {
    status: "idle",
    detected: null,
    lastOutput: null,
    error: null,
  },
  countsForPath: (path) => {
    // Monaco model URIs are `file:///abs/path` on every OS we ship
    // on. Match the suffix to handle both styles defensively.
    let errors = 0;
    let warnings = 0;
    const byUri = get().byUri;
    for (const uri in byUri) {
      if (uri.endsWith(path) || uri.endsWith(`/${path}`)) {
        for (const d of byUri[uri]) {
          if (d.severity === "error") errors++;
          else if (d.severity === "warning") warnings++;
        }
      }
    }
    return { errors, warnings };
  },
  runProjectCheck: async () => {
    set((s) => ({
      projectCheck: { ...s.projectCheck, status: "running", error: null },
    }));
    try {
      const result = await ipc.projectCheckRun();
      const projectByUri = groupByUri(
        result.diagnostics.map((d) => ({
          ...d,
          severity: d.severity ?? "error",
          source: d.source || "project-check",
          code: d.code ?? undefined,
        })),
      );
      const byUri = mergeDiagnostics(get().monacoByUri, projectByUri);
      const { errors, warnings } = recomputeCounts(byUri);
      set({
        byUri,
        projectByUri,
        errors,
        warnings,
        projectCheck: {
          status: "idle",
          detected: result.detected,
          lastOutput: result.rawOutput,
          error: result.timedOut
            ? "Project check timed out after 180s."
            : result.detected
            ? result.exitCode !== null &&
              result.exitCode !== 0 &&
              result.diagnostics.length === 0
              ? `Project check exited ${result.exitCode} without parseable file diagnostics.\n${result.rawOutput}`
              : null
            : result.rawOutput,
        },
      });
    } catch (e) {
      set((s) => ({
        projectCheck: {
          ...s.projectCheck,
          status: "idle",
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  },
  clearProjectDiagnostics: () => {
    const projectByUri: Record<string, Diagnostic[]> = {};
    const byUri = mergeDiagnostics(get().monacoByUri, projectByUri);
    const { errors, warnings } = recomputeCounts(byUri);
    set((s) => ({
      byUri,
      projectByUri,
      errors,
      warnings,
      projectCheck: { ...s.projectCheck, lastOutput: null, error: null },
    }));
  },
  installFromMonaco: (monaco) => {
    if (installedMonacos.has(monaco as object)) return;
    installedMonacos.add(monaco as object);

    const refresh = (uris: { toString: () => string }[]) => {
      const updates: Record<string, Diagnostic[]> = { ...get().monacoByUri };
      for (const uri of uris) {
        const key = uri.toString();
        const markers = monaco.editor.getModelMarkers({
          resource: uri as any,
        });
        if (markers.length === 0) {
          delete updates[key];
          continue;
        }
        updates[key] = markers.map((m) => ({
          uri: key,
          name: key.split(/[\\/]/).pop() || key,
          startLine: m.startLineNumber,
          startCol: m.startColumn,
          endLine: m.endLineNumber,
          endCol: m.endColumn,
          severity: severityFromMonaco(m.severity as unknown as number),
          message: m.message,
          source: m.source || "lint",
          code: typeof m.code === "string" ? m.code : m.code?.value,
        }));
      }
      const byUri = mergeDiagnostics(updates, get().projectByUri);
      const { errors, warnings } = recomputeCounts(byUri);
      set({ monacoByUri: updates, byUri, errors, warnings });
    };

    monaco.editor.onDidChangeMarkers((uris) =>
      refresh(uris as unknown as { toString: () => string }[]),
    );
    // Seed on install in case markers were produced before our listener
    // attached (e.g. a tab was already open across the boot tick).
    const seedUris = monaco.editor
      .getModels()
      .map((m) => m.uri) as unknown as { toString: () => string }[];
    if (seedUris.length > 0) refresh(seedUris);
  },
}));
