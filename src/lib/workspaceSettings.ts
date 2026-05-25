import { ipc } from "@/lib/ipc";
import { useSettings } from "@/store/settings";

/**
 * Per-workspace settings overlay.
 *
 * On workspace open, we look for `<root>/.pointer/settings.json` and
 * apply any keys it contains as overrides on top of the global
 * settings. The override is intentionally one-way: editing the
 * Pointer settings UI keeps modifying the *global* defaults — the
 * workspace file is treated as user-managed config that you commit
 * to git alongside your project (think `.editorconfig`).
 *
 * Supported keys mirror a subset of the persisted settings type so a
 * project can pin its tab width, format-on-save preference, etc.
 * Unknown keys are ignored with a console warning.
 */
const ALLOWED_KEYS = [
  "editorFontSize",
  "editorTabSize",
  "editorInsertSpaces",
  "editorWordWrap",
  "editorRenderWhitespace",
  "editorFormatOnSave",
  "editorAutoSave",
  "editorAutoSaveDelayMs",
  "editorStickyScroll",
  "editorBreadcrumbs",
  "editorHotExit",
  "editorMinimap",
  "editorTrimTrailingWhitespace",
  "editorInsertFinalNewline",
  "treeSort",
] as const;

type OverlayKey = (typeof ALLOWED_KEYS)[number];

/** Snapshot of the global values we replaced, keyed by setting name.
 *  When the workspace closes we use this to restore the user's
 *  global preference — otherwise reopening a different workspace
 *  would inherit the previous one's overrides. */
let restorePoints: Partial<Record<OverlayKey, unknown>> | null = null;

/** Read and apply the workspace overlay. Idempotent: safe to call on
 *  every workspace switch. Failures (no file, malformed JSON) are
 *  logged but don't propagate — the editor should still open. */
export async function applyWorkspaceSettings(root: string | null): Promise<void> {
  await clearWorkspaceSettings();
  if (!root) return;
  const path = `${root}/.pointer/settings.json`;
  let raw: string;
  try {
    raw = await ipc.readTextFile(path);
  } catch {
    return; // no overlay
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[pointer] .pointer/settings.json is not valid JSON:`, e);
    return;
  }
  const s = useSettings.getState();
  const snapshot: Partial<Record<OverlayKey, unknown>> = {};
  for (const key of ALLOWED_KEYS) {
    if (key in parsed) {
      const current = (s as unknown as Record<string, unknown>)[key];
      snapshot[key] = current;
      applyKey(key, parsed[key]);
    }
  }
  restorePoints = snapshot;
}

/** Undo the active overlay (used when switching workspaces or
 *  closing the folder). Restores the snapshot taken at apply time. */
export async function clearWorkspaceSettings(): Promise<void> {
  if (!restorePoints) return;
  for (const key of Object.keys(restorePoints) as OverlayKey[]) {
    applyKey(key, restorePoints[key]);
  }
  restorePoints = null;
}

/** Map a setting key to its corresponding setter and call it.
 *  Centralized so the apply/restore paths stay symmetric. */
function applyKey(key: OverlayKey, value: unknown): void {
  const s = useSettings.getState();
  switch (key) {
    case "editorFontSize":
      if (typeof value === "number") s.setEditorFontSize(value);
      break;
    case "editorTabSize":
      if (typeof value === "number") s.setEditorTabSize(value);
      break;
    case "editorInsertSpaces":
      if (typeof value === "boolean") s.setEditorInsertSpaces(value);
      break;
    case "editorWordWrap":
      if (typeof value === "boolean") s.setEditorWordWrap(value);
      break;
    case "editorRenderWhitespace":
      if (typeof value === "boolean") s.setEditorRenderWhitespace(value);
      break;
    case "editorFormatOnSave":
      if (typeof value === "boolean") s.setEditorFormatOnSave(value);
      break;
    case "editorAutoSave":
      if (value === "off" || value === "focusLoss" || value === "afterDelay") {
        s.setEditorAutoSave(value);
      }
      break;
    case "editorAutoSaveDelayMs":
      if (typeof value === "number") s.setEditorAutoSaveDelayMs(value);
      break;
    case "editorStickyScroll":
      if (typeof value === "boolean") s.setEditorStickyScroll(value);
      break;
    case "editorBreadcrumbs":
      if (typeof value === "boolean") s.setEditorBreadcrumbs(value);
      break;
    case "editorHotExit":
      if (typeof value === "boolean") s.setEditorHotExit(value);
      break;
    case "editorMinimap":
      if (typeof value === "boolean") s.setEditorMinimap(value);
      break;
    case "editorTrimTrailingWhitespace":
      if (typeof value === "boolean") s.setEditorTrimTrailingWhitespace(value);
      break;
    case "editorInsertFinalNewline":
      if (typeof value === "boolean") s.setEditorInsertFinalNewline(value);
      break;
    case "treeSort":
      if (value === "name" || value === "type") s.setTreeSort(value);
      break;
  }
}

/** Ensure `.pointer/settings.json` exists at the workspace root,
 *  seeded with the current effective settings (so the user has a
 *  starting point). Returns the absolute path. */
export async function ensureWorkspaceSettingsFile(
  root: string,
): Promise<string> {
  const dir = `${root}/.pointer`;
  const path = `${dir}/settings.json`;
  try {
    await ipc.readTextFile(path);
    return path; // already exists
  } catch {
    /* create */
  }
  await ipc.createDir(dir).catch(() => {});
  const s = useSettings.getState();
  const seed = {
    editorTabSize: s.editorTabSize,
    editorInsertSpaces: s.editorInsertSpaces,
    editorFormatOnSave: s.editorFormatOnSave,
    editorTrimTrailingWhitespace: s.editorTrimTrailingWhitespace,
    editorInsertFinalNewline: s.editorInsertFinalNewline,
  };
  const body = `${JSON.stringify(seed, null, 2)}\n`;
  await ipc.writeTextFile(path, body);
  return path;
}
