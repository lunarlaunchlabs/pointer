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
  breakpointBlock,
  codebaseBlock,
  debugValueBlock,
  diagnosticBlock,
  fileBlock,
  folderBlock,
  selectionBlock,
} from "@/lib/prompt";
import type { Reference } from "@/store/chat";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "another",
  "because",
  "before",
  "change",
  "could",
  "explain",
  "feature",
  "files",
  "from",
  "have",
  "into",
  "make",
  "mode",
  "plan",
  "please",
  "project",
  "repo",
  "should",
  "that",
  "their",
  "there",
  "this",
  "through",
  "update",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

export type BuildContextOptions = {
  /** Token budget for the whole context blob. Ask uses a smaller budget for
   *  latency; Plan/Agent can use more of the 33k model window for a
   *  deterministic research frontier and verification map. */
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
  /** The pending user prompt. When present, Pointer can deterministically
   *  explore a small workspace frontier before the LLM starts. */
  userPrompt?: string;
  /** Assistant mode. Plan/Agent get a slightly wider deterministic frontier. */
  mode?: "ask" | "plan" | "agent";
  /** Open editor tabs, ordered by recency. Used as low-cost orientation. */
  openTabs?: string[];
};

export async function buildContext(
  refs: Reference[],
  opts: BuildContextOptions = {},
): Promise<string | undefined> {
  const budget = new PromptBudget(opts.budgetTokens ?? 6000);
  const referencedPaths = new Set<string>();
  const memory = new ContextMemory();
  const brain = new BrainTrace(opts.userPrompt ?? "", opts.mode ?? "ask");

  for (const r of refs) {
    if (r.kind === "file") {
      try {
        const text = await ipc.readTextFile(r.path);
        referencedPaths.add(normalizePathKey(r.path));
        brain.include(r.path, "explicit file reference");
        memory.remember(r.path, text, "explicit file reference");
        budget.push(80, "file", fileBlock(r.path, compactFileForContext(r.path, text)));
        await pushDirectImportNeighbors(budget, r.path, text, referencedPaths, 52, memory, brain);
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
      referencedPaths.add(normalizePathKey(r.path));
      brain.include(r.path, "explicit selection reference");
      budget.push(
        100,
        "selection",
        selectionBlock(r.path, r.startLine, r.endLine, r.text),
      );
    } else if (r.kind === "diagnostic") {
      brain.include(r.path, "explicit diagnostic reference");
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
    } else if (r.kind === "breakpoint") {
      referencedPaths.add(normalizePathKey(r.path));
      brain.include(r.path, "explicit breakpoint reference");
      budget.push(
        108,
        "breakpoint",
        breakpointBlock({
          path: r.path,
          line: r.line,
          column: r.column,
          enabled: r.enabled,
          condition: r.condition,
          logMessage: r.logMessage,
        }),
      );
    } else if (r.kind === "debugValue") {
      budget.push(
        112,
        "debug-value",
        debugValueBlock({
          name: r.name,
          value: r.value,
          type: r.type,
          path: r.path,
          line: r.line,
          scope: r.scope,
          frame: r.frame,
          thread: r.thread,
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
    referencedPaths.add(normalizePathKey(opts.currentFile.path));
    brain.include(opts.currentFile.path, "active editor file");
    memory.remember(opts.currentFile.path, opts.currentFile.content, "active editor file");
    budget.push(
      40,
      "current",
      fileBlock(
        opts.currentFile.path,
        compactFileForContext(opts.currentFile.path, opts.currentFile.content),
      ),
    );
    await pushDirectImportNeighbors(
      budget,
      opts.currentFile.path,
      opts.currentFile.content,
      referencedPaths,
      38,
      memory,
      brain,
    );
  }

  await pushWorkspaceBrain(budget, referencedPaths, memory, brain, {
    prompt: opts.userPrompt,
    mode: opts.mode ?? "ask",
    openTabs: opts.openTabs ?? [],
  });

  const brainText = brain.render();
  if (brainText) budget.push(78, "brain-frontier", brainText);

  const memoryText = memory.render();
  if (memoryText) budget.push(76, "memory", memoryText);

  const { text } = budget.build();
  return text || undefined;
}

async function pushWorkspaceBrain(
  budget: PromptBudget,
  referencedPaths: Set<string>,
  memory: ContextMemory,
  brain: BrainTrace,
  opts: { prompt?: string; mode: "ask" | "plan" | "agent"; openTabs: string[] },
) {
  const prompt = opts.prompt?.trim() ?? "";
  const research = isResearchPrompt(prompt);
  const planning = opts.mode === "plan" || opts.mode === "agent";
  if (!prompt && !planning) return;

  const maxFiles = planning ? 8 : research ? 5 : 0;
  if (maxFiles <= 0) return;

  let included = 0;
  const include = async (path: string, reason: string, priority: number) => {
    if (included >= maxFiles) return false;
    const key = normalizePathKey(path);
    if (referencedPaths.has(key) || isGeneratedContextPath(path)) return false;
    try {
      const text = await ipc.readTextFile(path);
      referencedPaths.add(key);
      included += 1;
      brain.include(path, reason);
      memory.remember(path, text, reason);
      budget.push(priority, "brain", fileBlock(path, compactFileForContext(path, text)));
      await pushDirectImportNeighbors(
        budget,
        path,
        text,
        referencedPaths,
        Math.max(28, priority - 14),
        memory,
        brain,
      );
      return true;
    } catch {
      return false;
    }
  };

  for (const tab of opts.openTabs.slice(0, planning ? 4 : 2)) {
    await include(tab, "open editor tab", planning ? 42 : 32);
  }

  if (planning || shouldIncludeVerificationContext(prompt)) {
    const manifests = await discoverManifestFiles();
    brain.candidates("project config", manifests);
    for (const manifest of manifests) {
      await include(manifest, "project manifest / verification config", planning ? 58 : 44);
    }
  }

  const promptFiles = await discoverPromptSearchFiles(prompt, planning ? 10 : 6, brain);
  brain.candidates("prompt evidence", promptFiles);
  for (const file of promptFiles) {
    await include(file, "prompt-guided workspace search", planning ? 52 : 46);
  }

  if (planning || shouldIncludeVerificationContext(prompt)) {
    const verificationFiles = await discoverVerificationFiles(
      prompt,
      Array.from(referencedPaths),
      planning ? 10 : 6,
      brain,
    );
    brain.candidates("verification candidates", verificationFiles);
    for (const file of verificationFiles) {
      await include(file, "verification/specification candidate", planning ? 50 : 42);
    }
  }

  for (const path of Array.from(referencedPaths).slice(0, 8)) {
    if (included >= maxFiles) break;
    const base = basenameNoExt(path);
    if (!base || base.length < 3) continue;
    for (const related of await discoverRelatedFiles(base)) {
      await include(related, `verification/import neighbor for ${base}`, 38);
      if (included >= maxFiles) break;
    }
  }
}

async function discoverManifestFiles(): Promise<string[]> {
  const names = [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "tox.ini",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "mix.exs",
    "composer.json",
    "Gemfile",
    "Makefile",
    "justfile",
    "Taskfile.yml",
    "deno.json",
    "bunfig.toml",
    "pubspec.yaml",
    "Package.swift",
    "project.clj",
    "deps.edn",
  ];
  const out: string[] = [];
  for (const name of names) {
    try {
      const hits = await ipc.searchFiles(name, 4);
      for (const hit of hits) {
        if (basenamePath(hit.path).toLowerCase() === name.toLowerCase()) {
          pushUnique(out, hit.path);
        }
      }
    } catch {
      // Search is opportunistic; OpenCode still has its own tools.
    }
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

async function discoverPromptSearchFiles(
  prompt: string,
  limit: number,
  brain?: BrainTrace,
): Promise<string[]> {
  const queries = promptSearchQueries(prompt).slice(0, 8);
  brain?.queries(queries);
  const scores = new Map<string, number>();
  for (const query of queries) {
    try {
      const hits = await ipc.searchText(query, 24);
      for (const hit of hits) {
        if (isGeneratedContextPath(hit.path)) continue;
        const current = scores.get(hit.path) ?? 0;
        scores.set(hit.path, current + query.length + evidenceLineScore(hit.text, prompt));
      }
    } catch {
      // Keep gathering from the next query.
    }
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path]) => path)
    .slice(0, limit);
}

async function discoverVerificationFiles(
  prompt: string,
  anchors: string[],
  limit: number,
  brain?: BrainTrace,
): Promise<string[]> {
  const terms = verificationSearchTerms(prompt, anchors).slice(0, 12);
  brain?.queries(terms.map((term) => `verify:${term}`));
  const scores = new Map<string, number>();
  for (const term of terms) {
    const names = verificationNameCandidates(term).slice(0, 10);
    for (const name of names) {
      try {
        const hits = await ipc.searchFiles(name, 12);
        for (const hit of hits) {
          if (isGeneratedContextPath(hit.path)) continue;
          const current = scores.get(hit.path) ?? 0;
          scores.set(hit.path, current + verificationPathScore(hit.path, term));
        }
      } catch {
        // Keep probing other patterns; this is an opportunistic frontier.
      }
    }
    if (scores.size >= limit * 2) break;
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path]) => path)
    .slice(0, limit);
}

async function discoverRelatedFiles(base: string): Promise<string[]> {
  const out: string[] = [];
  const queries = [
    `${base}.test`,
    `${base}.spec`,
    `${base}Test`,
    `from './${base}'`,
    `from "./${base}"`,
    `require('./${base}')`,
    `require("./${base}")`,
  ];
  for (const query of queries) {
    try {
      if (query.includes(".test") || query.includes(".spec") || query.endsWith("Test")) {
        const hits = await ipc.searchFiles(query, 8);
        for (const hit of hits) pushUnique(out, hit.path);
      } else {
        const hits = await ipc.searchText(query, 12);
        for (const hit of hits) pushUnique(out, hit.path);
      }
    } catch {
      // Best-effort neighbor discovery.
    }
    if (out.length >= 5) break;
  }
  return out.slice(0, 5);
}

function isResearchPrompt(prompt: string): boolean {
  return /\b(where|how|why|trace|flow|wired|configured|compiled|consumed|call(?:ed|s)?|references?|uses?|explain|tell me about|audit|investigate)\b/i.test(
    prompt,
  );
}

function shouldIncludeVerificationContext(prompt: string): boolean {
  return /\b(test|spec|verify|validation|lint|typecheck|build|bug|fix|refactor|feature|implement|change|add|remove|update)\b/i.test(
    prompt,
  );
}

function promptSearchQueries(prompt: string): string[] {
  const raw = prompt.trim();
  const out: string[] = [];
  for (const item of extractQuotedHints(raw)) pushUnique(out, item);
  for (const path of extractPathHints(raw)) pushUnique(out, basenameNoExt(path));
  for (const id of extractIdentifierHints(raw)) {
    pushUnique(out, id);
    for (const split of splitCompoundIdentifier(id).slice(0, 2)) {
      if (split.length >= 4) pushUnique(out, split);
    }
  }

  const words = contentWords(raw);
  for (const phrase of phraseWindows(words, 3).slice(0, 4)) pushUnique(out, phrase);
  for (const phrase of phraseWindows(words, 2).slice(0, 6)) pushUnique(out, phrase);
  for (const word of words) pushUnique(out, word);
  return out.slice(0, 12);
}

function contentWords(raw: string): string[] {
  return raw
    .split(/[^A-Za-z0-9_$.-]+/)
    .map((word) => word.trim())
    .filter((word) => {
      if (word.length < 4) return false;
      if (STOP_WORDS.has(word.toLowerCase())) return false;
      if (/^\d+$/.test(word)) return false;
      return true;
    });
}

function phraseWindows(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= words.length - size; i += 1) {
    const slice = words.slice(i, i + size);
    if (slice.some((word) => word.includes(".") || word.includes("_"))) continue;
    out.push(slice.join(" "));
  }
  return out;
}

function extractQuotedHints(raw: string): string[] {
  const out: string[] = [];
  const quoted = raw.match(/[`'"]([^`'"]{3,120})[`'"]/g) ?? [];
  for (const item of quoted) pushUnique(out, item.slice(1, -1).trim());
  return out;
}

function extractPathHints(raw: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|\s)([A-Za-z0-9_./@-]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|rs|go|py|rb|php|java|kt|kts|cs|cpp|cxx|cc|c|h|hpp|swift|scala|clj|ex|exs|erl|fs|fsx|dart|json|ya?ml|toml|xml|gradle|md|css|scss|less|sql|sh|bash|zsh|fish|ps1))/g;
  for (const match of raw.matchAll(re)) {
    if (match[1]) pushUnique(out, match[1]);
  }
  return out;
}

function extractIdentifierHints(raw: string): string[] {
  const out: string[] = [];
  const re = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Z][A-Za-z0-9_$]{3,}\b|\b[a-z]+(?:[A-Z][A-Za-z0-9_$]*)+\b/g;
  for (const match of raw.matchAll(re)) {
    if (match[0]) pushUnique(out, match[0]);
  }
  return out;
}

function splitCompoundIdentifier(id: string): string[] {
  return id
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function verificationSearchTerms(prompt: string, anchors: string[]): string[] {
  const out: string[] = [];
  for (const hint of extractPathHints(prompt)) pushUnique(out, basenameNoExt(hint));
  for (const id of extractIdentifierHints(prompt)) {
    pushUnique(out, id);
    pushUnique(out, splitCompoundIdentifier(id).join(" "));
  }
  for (const anchor of anchors) {
    const base = basenameNoExt(anchor);
    if (base && base.length >= 3) pushUnique(out, base);
  }
  for (const query of promptSearchQueries(prompt)) {
    if (query.length >= 4) pushUnique(out, query);
  }
  return out.slice(0, 16);
}

function verificationNameCandidates(term: string): string[] {
  const compact = term
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\w$.-]/g, "");
  const kebab = term
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_.]+/g, "-")
    .replace(/[^\w$.-]+/g, "")
    .toLowerCase();
  const snake = kebab.replace(/-/g, "_");
  const bases = [compact, kebab, snake].filter((item) => item.length >= 3);
  const out: string[] = [];
  for (const base of bases) {
    for (const candidate of [
      `${base}.test`,
      `${base}.spec`,
      `${base}_test`,
      `test_${base}`,
      `${base}Test`,
      `${base}Spec`,
      `${base}.stories`,
      `${base}.feature`,
    ]) {
      pushUnique(out, candidate);
    }
  }
  return out;
}

function verificationPathScore(path: string, term: string): number {
  const lower = normalizeSlashes(path).toLowerCase();
  let score = 4;
  if (/(^|\/)(__tests__|tests?|spec|specs|features?|fixtures?)(\/|$)/.test(lower)) score += 10;
  if (/\.(test|spec|feature|stories)\./.test(lower) || /_test\./.test(lower)) score += 12;
  const normalizedTerm = term.toLowerCase().replace(/\s+/g, "");
  if (normalizedTerm && lower.replace(/[-_./]/g, "").includes(normalizedTerm)) score += 8;
  return score;
}

function evidenceLineScore(line: string, prompt: string): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const term of promptSearchQueries(prompt).slice(0, 5)) {
    if (lower.includes(term.toLowerCase())) score += 8;
  }
  if (/import|export|describe\s*\(|\bit\s*\(|test\s*\(/.test(line)) score += 4;
  if (/setItem|getItem|app\.set|app\.get|Route|Switch|ThemeProvider|drag|drop|query parser/i.test(line)) {
    score += 6;
  }
  return score;
}

async function pushDirectImportNeighbors(
  budget: PromptBudget,
  fromPath: string,
  contents: string,
  referencedPaths: Set<string>,
  priority: number,
  memory?: ContextMemory,
  brain?: BrainTrace,
) {
  const specs = extractRelativeImports(contents).slice(0, 8);
  let included = 0;
  for (const spec of specs) {
    if (included >= 5) break;
    const resolved = await readFirstExistingImport(fromPath, spec);
    if (!resolved) continue;
    const key = normalizePathKey(resolved.path);
    if (referencedPaths.has(key)) continue;
    referencedPaths.add(key);
    included += 1;
    brain?.include(resolved.path, `direct import from ${fromPath}`);
    memory?.remember(resolved.path, resolved.contents, `direct import from ${fromPath}`);
    budget.push(
      priority,
      "neighbor",
      fileBlock(resolved.path, compactFileForContext(resolved.path, resolved.contents)),
    );
  }
}

async function readFirstExistingImport(fromPath: string, spec: string) {
  for (const candidate of relativeImportCandidates(fromPath, spec)) {
    try {
      return { path: candidate, contents: await ipc.readTextFile(candidate) };
    } catch {
      // Try the next common extension/index shape.
    }
  }
  return null;
}

class BrainTrace {
  private queryList: string[] = [];
  private candidateGroups = new Map<string, string[]>();
  private includedFiles: { path: string; reason: string }[] = [];

  constructor(
    private prompt: string,
    private mode: "ask" | "plan" | "agent",
  ) {}

  queries(items: string[]) {
    for (const item of items) pushUnique(this.queryList, item);
  }

  candidates(group: string, paths: string[]) {
    if (!paths.length) return;
    const existing = this.candidateGroups.get(group) ?? [];
    for (const path of paths) pushUnique(existing, path);
    this.candidateGroups.set(group, existing.slice(0, 10));
  }

  include(path: string, reason: string) {
    if (this.includedFiles.some((item) => normalizePathKey(item.path) === normalizePathKey(path))) {
      return;
    }
    this.includedFiles.push({ path, reason });
  }

  render(): string {
    const shouldRender =
      this.includedFiles.length > 0 ||
      this.queryList.length > 0 ||
      this.candidateGroups.size > 0;
    if (!shouldRender) return "";
    const intent = describeBrainIntent(this.prompt, this.mode);
    const lines = [
      "<brain-frontier>",
      "Pointer built this deterministic, language-agnostic search frontier before the model answered. Treat it as a shared external memory: use exact paths and evidence, inspect any remaining candidate before asserting behavior, and avoid rediscovering included facts.",
      `mode: ${this.mode}`,
      `intent: ${intent}`,
    ];
    if (this.queryList.length) {
      lines.push(`queries: ${this.queryList.slice(0, 10).join(" | ")}`);
    }
    if (this.includedFiles.length) {
      lines.push("included evidence:");
      for (const item of this.includedFiles.slice(0, 12)) {
        lines.push(`- ${item.path} (${item.reason})`);
      }
    }
    for (const [group, paths] of this.candidateGroups) {
      const remaining = paths.filter(
        (path) =>
          !this.includedFiles.some(
            (item) => normalizePathKey(item.path) === normalizePathKey(path),
          ),
      );
      if (!remaining.length) continue;
      lines.push(`${group} not yet included: ${remaining.slice(0, 6).join(", ")}`);
    }
    lines.push("</brain-frontier>");
    return lines.join("\n").slice(0, 5200);
  }
}

function describeBrainIntent(prompt: string, mode: "ask" | "plan" | "agent"): string {
  const p = prompt.toLowerCase();
  const bits: string[] = [];
  if (mode === "plan") bits.push("read-only executable planning");
  if (mode === "agent") bits.push("implementation with verification");
  if (/\b(where|trace|flow|wired|configured|references?|uses?)\b/.test(p)) bits.push("codebase research");
  if (/\b(bug|fix|broken|error|regression|lint|failing|fails)\b/.test(p)) bits.push("bug investigation");
  if (/\b(refactor|cleanup|clean up|rename|migrate)\b/.test(p)) bits.push("refactor");
  if (/\b(add|implement|feature|support|create)\b/.test(p)) bits.push("feature/change");
  if (/\b(test|spec|verify|validation|typecheck|build)\b/.test(p)) bits.push("verification-sensitive");
  return bits.length ? bits.join(", ") : "general code assistance";
}

type MemoryPacket = {
  path: string;
  reason: string;
  imports: string[];
  symbols: string[];
  evidence: string[];
};

class ContextMemory {
  private packets = new Map<string, MemoryPacket>();

  remember(path: string, contents: string, reason: string) {
    const key = normalizePathKey(path);
    if (this.packets.has(key)) return;
    this.packets.set(key, {
      path,
      reason,
      imports: extractRelativeImports(contents).slice(0, 8),
      symbols: extractMemorySymbols(contents).slice(0, 12),
      evidence: extractMemoryEvidence(path, contents).slice(0, 10),
    });
  }

  render(): string {
    if (!this.packets.size) return "";
    const lines = [
      "<context-memory>",
      "Deterministic retained memory outside the raw file window. Use this as a compact source map, not as a substitute for quoted code.",
    ];
    for (const packet of this.packets.values()) {
      const bits = [
        `${packet.path} (${packet.reason})`,
        packet.symbols.length ? `symbols: ${packet.symbols.slice(0, 8).join(", ")}` : "",
        packet.imports.length ? `imports: ${packet.imports.slice(0, 6).join(", ")}` : "",
        packet.evidence.length ? `evidence: ${packet.evidence.slice(0, 4).join(" | ")}` : "",
      ].filter(Boolean);
      lines.push(`- ${bits.join("; ")}`);
    }
    lines.push("</context-memory>");
    return lines.join("\n").slice(0, 7000);
  }
}

function extractMemorySymbols(contents: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const symbol = match[2] ? `${match[1]}.${match[2]}` : match[1];
      if (symbol && !out.includes(symbol)) out.push(symbol);
      if (out.length >= 18) return out;
    }
  }
  return out;
}

function extractMemoryEvidence(path: string, contents: string): string[] {
  const patterns = [
    /import\s/,
    /export\s/,
    /describe\s*\(|\bit\s*\(|test\s*\(/,
    /ThemeProvider|Switch|Route|storage\.|local-storage-fallback/i,
    /showDropOverlay|dragDrop|drop-overlay|unsupported/i,
    /app\.set|app\.get|compile|query parser|subdomain offset/i,
    /Vditor|upload|image|save|open|export/i,
  ];
  return contents
    .split(/\r?\n/)
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter(({ line }) => line && patterns.some((pattern) => pattern.test(line)))
    .slice(0, 14)
    .map(({ line, idx }) => `${path}:${idx + 1}: ${line.slice(0, 180)}`);
}

function extractRelativeImports(contents: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of contents.matchAll(re)) {
    const spec = match[1]?.split(/[?#]/)[0];
    if (spec && !specs.includes(spec)) specs.push(spec);
  }
  return specs;
}

function relativeImportCandidates(fromPath: string, spec: string): string[] {
  const base = joinPath(dirnamePath(fromPath), spec);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.vue`,
    `${base}.svelte`,
    joinPath(base, "index.ts"),
    joinPath(base, "index.tsx"),
    joinPath(base, "index.js"),
    joinPath(base, "index.jsx"),
    joinPath(base, "index.vue"),
    joinPath(base, "index.svelte"),
  ];
}

function dirnamePath(filePath: string): string {
  const normalized = normalizeSlashes(filePath);
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? (normalized.startsWith("/") ? "/" : ".") : normalized.slice(0, idx);
}

function joinPath(base: string, child: string): string {
  const absolute = normalizeSlashes(base).startsWith("/");
  const parts = `${base}/${child}`
    .split("/")
    .filter((part) => part && part !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${absolute ? "/" : ""}${out.join("/")}`;
}

function normalizePathKey(path: string): string {
  return normalizeSlashes(path).replace(/\/+$/, "").toLowerCase();
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function basenamePath(path: string): string {
  const normalized = normalizeSlashes(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function basenameNoExt(path: string): string {
  const base = basenamePath(path);
  return base.replace(/\.[^.]+$/, "");
}

function pushUnique(out: string[], item: string) {
  const trimmed = item.trim();
  if (!trimmed) return;
  const key = normalizePathKey(trimmed);
  if (out.some((existing) => normalizePathKey(existing) === key)) return;
  out.push(trimmed);
}

function isGeneratedContextPath(path: string): boolean {
  return /(?:^|\/)(node_modules|\.git|dist|build|target|coverage|\.next|\.nuxt|\.svelte-kit|vendor|Pods|DerivedData)\//.test(
    normalizeSlashes(path),
  );
}

function compactFileForContext(path: string, contents: string): string {
  if (contents.length <= 24_000) return contents;
  const lines = contents.split(/\r?\n/);
  const imports: string[] = [];
  const stateKeys: string[] = [];
  const methods: string[] = [];
  const hotspots: string[] = [];
  const patterns = [
    /import\s/,
    /export\s/,
    /Vditor|Monaco|CodeMirror|editor/i,
    /upload|image|media/i,
    /drag|drop|overlay/i,
    /save|open|load|export/i,
    /theme|dark|light/i,
    /route|router/i,
    /test|describe|it\(/i,
  ];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (/^import\s/.test(trimmed) && imports.length < 32) {
      imports.push(`${idx + 1}: ${trimmed}`);
    }
    const state = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*(?:null|false|true|['"`{\[]|\d)/);
    if (state && idx < 220 && stateKeys.length < 36) {
      stateKeys.push(`${idx + 1}: ${state[1]}`);
    }
    const method = trimmed.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (method && methods.length < 56) {
      methods.push(`${idx + 1}: ${method[1]}()`);
    }
    if (patterns.some((pattern) => pattern.test(line)) && hotspots.length < 64) {
      hotspots.push(`${idx + 1}: ${trimmed.slice(0, 180)}`);
    }
  });

  return [
    `${path} is large (${lines.length} lines). Compact structural map:`,
    imports.length ? `Imports:\n${imports.join("\n")}` : "",
    stateKeys.length ? `State/data keys:\n${stateKeys.join(", ")}` : "",
    methods.length ? `Methods:\n${methods.join(", ")}` : "",
    hotspots.length ? `Feature hotspots:\n${hotspots.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 18_000);
}
