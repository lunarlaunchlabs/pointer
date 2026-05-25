/** Tiny cross-platform path helpers. We only need join and the workspace
 *  resolver; importing node:path in the renderer is awkward under Tauri. */

const SEP_RE = /[\\/]+/;

export function isAbsolute(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/")) return true;
  // Windows: C:\foo or C:/foo
  return /^[a-zA-Z]:[\\/]/.test(p);
}

export function join(...parts: string[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (isAbsolute(p)) {
      out.length = 0;
    }
    out.push(p);
  }
  const joined = out.join("/");
  return joined.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function basename(p: string): string {
  const parts = p.split(SEP_RE);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const parts = p.split(SEP_RE);
  parts.pop();
  return parts.join("/") || ".";
}

/** Resolve a (possibly relative) path against the workspace root. */
export function resolveInWorkspace(workspace: string | null, p: string): string {
  if (!p) return p;
  if (isAbsolute(p)) return p;
  if (!workspace) return p;
  return join(workspace, p);
}

export default { isAbsolute, join, basename, dirname, resolveInWorkspace };
