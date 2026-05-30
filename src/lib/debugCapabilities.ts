import { languageFromPath } from "@/lib/lang";
import {
  DEBUGGER_COMPATIBILITY_MATRIX,
  type DebugCapability,
} from "@/lib/debugCompatibilityMatrix";

export type { DebugCapability } from "@/lib/debugCompatibilityMatrix";
export { DEBUGGER_COMPATIBILITY_MATRIX } from "@/lib/debugCompatibilityMatrix";

export function debuggerCapabilitiesForPath(path: string): DebugCapability[] {
  const language = normalize(languageFromPath(path));
  return DEBUGGER_COMPATIBILITY_MATRIX.filter((cap) => cap.language === language);
}

export function inferDebuggerCapabilities(files: string[]): DebugCapability[] {
  const normalizedFiles = files.map((file) => file.toLowerCase());
  const langs = new Set(files.map((file) => normalize(languageFromPath(file))));
  const out = DEBUGGER_COMPATIBILITY_MATRIX.filter((cap) => langs.has(cap.language));

  for (const cap of DEBUGGER_COMPATIBILITY_MATRIX) {
    if (cap.manifestPaths.some((pattern) => hasPath(normalizedFiles, pattern))) {
      pushUnique(out, cap);
    }
  }

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function hasPath(files: string[], pattern: string): boolean {
  const target = pattern.toLowerCase();
  return files.some((file) => {
    const normalized = file.replace(/\\/g, "/");
    const base = normalized.split("/").pop() ?? normalized;
    if (target.startsWith("*.")) {
      return base.endsWith(target.slice(1));
    }
    return normalized === target || normalized.endsWith(`/${target}`);
  });
}

function pushUnique(list: DebugCapability[], cap: DebugCapability | undefined) {
  if (!cap || list.some((item) => item.language === cap.language)) return;
  list.push(cap);
}

function normalize(language: string): string {
  if (language === "javascriptreact" || language === "jsx") return "javascript";
  if (language === "typescriptreact" || language === "tsx") return "typescript";
  if (language === "vue" || language === "svelte" || language === "astro") return "typescript";
  if (language === "vb") return "csharp";
  return language;
}
