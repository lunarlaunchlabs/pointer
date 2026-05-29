import type { GitBranch, GitFileEntry, GitOperationState } from "@/lib/ipc";

export type CommitFileSummary = {
  path: string;
  status: GitFileEntry["status"];
  summary: string;
  fallback?: string;
};

export type CommitDiffChunk = {
  path: string;
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  text: string;
};

export type CommitChunkSummary = {
  index: number;
  lineRange: string;
  summary: string;
  fallback?: string;
};

export type CommitFileMemory = CommitFileSummary & {
  chunks: CommitChunkSummary[];
};

export type CommitGenerationMemory = {
  files: CommitFileMemory[];
  consolidatedSummary: string;
  generatedCommitMessage: string;
  warnings: string[];
  harnessMemory?: {
    lanes: number;
    memories: number;
    approved: number;
  };
};

export function changedFilesForCommit(
  entries: GitFileEntry[],
): GitFileEntry[] {
  const staged = entries.filter((entry) => entry.staged);
  if (staged.length > 0) return staged;
  return entries.filter(
    (entry) => entry.unstaged && entry.status !== "untracked",
  );
}

export function chunkDiffForSummary(
  path: string,
  diff: string,
  maxLines = 180,
  maxChars = 9000,
): CommitDiffChunk[] {
  const lines = (diff.trim() || `${path} changed.`).split(/\r?\n/);
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  const headerLines = firstHunk > 0 ? lines.slice(0, firstHunk) : [];
  const bodyLines = firstHunk > 0 ? lines.slice(firstHunk) : lines;
  const bodyStartLine = firstHunk > 0 ? firstHunk + 1 : 1;
  const chunks: Array<{ start: number; end: number; lines: string[] }> = [];
  let current: string[] = [];
  let currentStart = bodyStartLine;
  let charCount = 0;
  const softMinLines = Math.max(24, Math.floor(maxLines * 0.55));

  const flush = (endLine: number) => {
    if (current.length === 0) return;
    chunks.push({ start: currentStart, end: endLine, lines: current });
    current = [];
    charCount = 0;
  };

  bodyLines.forEach((line, offset) => {
    const absoluteLine = bodyStartLine + offset;
    const startsHunk = line.startsWith("@@ ");
    const lineChars = line.length + 1;
    const overLimit =
      current.length > 0 &&
      (current.length + 1 > maxLines || charCount + lineChars > maxChars);
    const hunkBoundary =
      startsHunk && current.length >= softMinLines && charCount + lineChars > maxChars * 0.45;

    if (overLimit || hunkBoundary) {
      flush(absoluteLine - 1);
      currentStart = absoluteLine;
    }

    current.push(line);
    charCount += lineChars;
  });
  flush(bodyStartLine + bodyLines.length - 1);

  return chunks.map((chunk, idx) => {
    const needsHeader =
      headerLines.length > 0 &&
      !chunk.lines.some((line) => line.startsWith("diff --git"));
    return {
      path,
      index: idx + 1,
      total: chunks.length,
      startLine: chunk.start,
      endLine: chunk.end,
      text: [...(needsHeader ? headerLines : []), ...chunk.lines].join("\n"),
    };
  });
}

export function buildFileSummaryPrompt(path: string, diff: string): string {
  return [
    `Summarize this git diff for ${path}.`,
    "Return only 1-2 short sentences, no bullets, no markdown.",
    "Stay under 35 words total.",
    "Describe the behavior, capability, or technical intent changed by this file.",
    "Do not repeat the file path, status, line counts, or a list of changed symbols.",
    "",
    diff.trim().slice(0, 12000),
  ].join("\n");
}

export function buildDiffChunkSummaryPrompt(chunk: CommitDiffChunk): string {
  return [
    `Summarize chunk ${chunk.index} of ${chunk.total} for ${chunk.path}.`,
    "Return exactly one short sentence, no bullets, no markdown.",
    "Stay under 24 words total.",
    "This is a partial diff chunk; only describe changes proven by this chunk.",
    "Describe behavior, UX, tests, or implementation intent. Do not list changed symbols.",
    "",
    chunk.text.trim().slice(0, 12000),
  ].join("\n");
}

export function buildFileConsolidationPrompt(
  path: string,
  chunks: CommitChunkSummary[],
): string {
  const body = chunks
    .map((chunk) => `${chunk.index}. ${chunk.summary}`)
    .join("\n");
  return [
    `Consolidate these independent chunk summaries for ${path}.`,
    "Return only 1-2 short sentences, no bullets, no markdown.",
    "Stay under 35 words total.",
    "Synthesize the file-level intent. Do not repeat the file path or changed symbols.",
    "",
    body,
  ].join("\n");
}

export function buildChangeConsolidationPrompt(
  summaries: CommitFileSummary[],
): string {
  const body = summaries
    .map((item, index) => `${index + 1}. ${item.summary}`)
    .join("\n");
  return [
    "Consolidate these file summaries into a user-visible change summary.",
    "Return 2-3 concise sentences, no bullets, no markdown.",
    "Stay under 65 words total.",
    "Explain what changed at the product or engineering level.",
    "Do not output file paths, filenames, directories, changed symbols, or an inventory.",
    "Treat test fixtures as validation; do not summarize mock response strings as product behavior.",
    "",
    body,
  ].join("\n");
}

export function buildCommitMessagePrompt(
  summaries: CommitFileSummary[],
  consolidatedSummary?: string,
): string {
  const body = summaries
    .map((item, index) => `${index + 1}. ${item.summary}`)
    .join("\n");
  return [
    "Write a polished git commit message from these independent file-level summaries.",
    "Return only the commit message.",
    "Use an imperative subject line under 72 characters.",
    "The entire commit message must be no more than 3 sentences.",
    "Do not output bullets, file paths, filenames, directories, or a changed-files inventory.",
    "Synthesize the intent across the summaries instead of restating each summary.",
    "Do not return a category-only subject like \"Improve workflow\"; name the concrete capability or fix.",
    "If body text is useful, add one blank line then 1-2 concise sentences.",
    "",
    consolidatedSummary ? `System memory summary:\n${consolidatedSummary}\n` : "",
    body,
  ].filter(Boolean).join("\n");
}

export function normalizeFileSummary(
  text: string,
  path: string,
  status: GitFileEntry["status"],
  fallback?: string,
): string {
  const cleaned = stripModelDecorations(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  const withoutPath = removePathInventory(cleaned, [path]);
  const sentences = firstSentences(withoutPath, 2);
  const normalized = limitWords(sentences, 35);
  if (
    normalized &&
    !isGenericSummary(normalized) &&
    !looksLikeSymbolInventory(normalized) &&
    !looksLikeMalformedSummary(normalized) &&
    !looksLikePathLeak(normalized) &&
    !looksLikeLowValueSummary(normalized)
  ) {
    return normalized;
  }
  if (
    fallback &&
    !looksLikeSymbolInventory(fallback) &&
    !looksLikeMalformedSummary(fallback) &&
    !looksLikePathLeak(fallback) &&
    !looksLikeLowValueSummary(fallback)
  ) {
    return fallback;
  }
  if (fallback) {
    const fallbackConcepts = conceptsFromText(fallback).slice(0, 2);
    if (fallbackConcepts.length > 0) {
      return `${summaryVerbForStatus(status)} ${formatHumanList(fallbackConcepts)}.`;
    }
  }
  return fallbackSummaryFromPath(path, status);
}

export function normalizeChunkSummary(
  text: string,
  path: string,
  status: GitFileEntry["status"],
  fallback?: string,
): string {
  const normalized = normalizeFileSummary(text, path, status, fallback);
  return limitWords(firstSentences(normalized, 1), 24);
}

export function normalizeChangeSummary(
  text: string,
  summaries: CommitFileSummary[],
): string {
  const paths = summaries.map((item) => item.path);
  const cleaned = stripModelDecorations(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  const normalized = limitWords(firstSentences(removePathInventory(cleaned, paths), 3), 65);
  if (
    normalized &&
    !isGenericSummary(normalized) &&
    !looksLikeFileInventory(normalized, paths) &&
    !looksLikeSymbolInventory(normalized) &&
    !looksLikeBadChangeSummary(normalized, paths)
  ) {
    return normalized;
  }
  const specific = synthesizeChangeSummaryFromSummaries(summaries);
  if (specific) return specific;
  const source = summaries
    .map((item) => item.summary)
    .filter(
      (summary) =>
        summary &&
        !looksLikeSymbolInventory(summary) &&
        !looksLikeBadChangeSummary(summary, paths),
    );
  const fallback = limitWords(firstSentences(source.join(" "), 3), 65);
  return fallback || synthesizeCommitIntent(summaries) || "Updates project behavior.";
}

export function fallbackSummaryFromDiff(
  path: string,
  status: GitFileEntry["status"],
  diff: string,
): string {
  const added = new Set<string>();
  const removed = new Set<string>();
  const featurePhrases = new Set<string>();
  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith("+++") || rawLine.startsWith("---")) {
      continue;
    }
    const sign = rawLine[0];
    if (sign !== "+" && sign !== "-") continue;
    const text = rawLine.slice(1).trim();
    if (!text || /^[{}()[\],;]+$/.test(text)) continue;
    const target = sign === "+" ? added : removed;
    for (const concept of extractIdentifierConcepts(text)) target.add(concept);
    for (const phrase of extractFeaturePhrases(text)) featurePhrases.add(phrase);
  }

  const symbols = [...added].filter((symbol) => !removed.has(symbol)).slice(0, 3);
  const phrase = [...featurePhrases][0];
  const area = humanizePath(path);
  const verb = status === "added" ? "Adds" : status === "deleted" ? "Removes" : "Updates";
  const semantic = semanticSummaryFromDiff(diff);
  const pathConcept = conceptFromPhrase(area);

  if (status === "added" && pathConcept) return `${verb} ${pathConcept}.`;
  if (semantic) return `${verb} ${semantic}.`;
  if (phrase) return `${verb} ${phrase}.`;
  if (symbols.length > 0) {
    return `${verb} ${formatList(symbols)} in ${area}.`;
  }
  return fallbackSummaryFromPath(path, status);
}

function fallbackSummaryFromPath(path: string, status: GitFileEntry["status"]): string {
  const area = humanizePath(path);
  switch (status) {
    case "added":
      return `Adds ${area}.`;
    case "deleted":
      return `Removes ${area}.`;
    case "renamed":
      return `Renames ${area}.`;
    case "conflicted":
      return `Resolves conflicts in ${area}.`;
    default:
      return `Updates ${area}.`;
  }
}

export function normalizeGeneratedCommitMessage(
  text: string,
  summaries: CommitFileSummary[],
): string {
  const paths = summaries.map((item) => item.path);
  const cleaned = stripModelDecorations(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^["'`]|["'`]$/g, "").trimEnd())
    .join("\n")
    .trim();

  if (
    cleaned &&
    !looksLikeFileInventory(cleaned, paths) &&
    !isGenericCommitMessage(cleaned) &&
    !looksLikeSymbolInventory(cleaned) &&
    !looksLikeThemeOnlyCommitMessage(cleaned, summaries) &&
    !looksLikeLowValueCommitMessage(cleaned)
  ) {
    return capCommitMessage(cleaned);
  }
  return fallbackCommitMessage(summaries);
}

function stripModelDecorations(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, ""),
    )
    .replace(/^commit message:\s*/i, "")
    .trim();
}

function looksLikeFileInventory(text: string, paths: string[]): boolean {
  const lower = text.toLowerCase();
  const fragments = paths.flatMap(pathInventoryFragments);
  const pathHits = fragments.filter((fragment) => lower.includes(fragment)).length;
  const bulletLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)).length;
  return pathHits >= Math.min(2, paths.length) || bulletLines >= 2;
}

function removePathInventory(text: string, paths: string[]): string {
  let out = text;
  for (const path of paths.flatMap(pathInventoryFragments)) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

function pathInventoryFragments(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.at(-1) ?? normalized;
  const withoutExt = normalized.replace(/\.[^.]+$/, "");
  const fileWithoutExt = file.replace(/\.[^.]+$/, "");
  return [...new Set([normalized, withoutExt, file, fileWithoutExt])].filter(
    (item) => item.length >= 4,
  );
}

function capCommitMessage(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const subject = limitChars(lines[0].replace(/[.!?]+$/g, ""), 72);
  const body = firstSentences(lines.slice(1).join(" "), 2);
  return [subject, body ? `\n\n${body}` : ""].join("").trim();
}

function fallbackCommitMessage(summaries: CommitFileSummary[]): string {
  const useful = summaries
    .map((item) => ({
      ...item,
      summary: safeSummaryForSynthesis(item),
    }))
    .filter(
      (item) =>
        item.summary &&
        !isGenericSummary(item.summary) &&
        !looksLikeSymbolInventory(item.summary) &&
        !looksLikeLowValueSummary(item.summary),
  );
  const source = useful.length > 0 ? useful : summaries;
  const synthesized = synthesizeCommitMessageFromSummaries(source);
  if (synthesized) return synthesized;
  const intent = synthesizeCommitIntent(source);
  if (intent) return intent;
  const summaryText = source
    .map((item) => item.summary.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  const body = firstSentences(summaryText, 2);
  const first =
    source[0]?.summary.replace(/^[-*]\s*/, "").trim() || "project behavior";
  const subject = subjectFromSummary(first);
  return [subject, body ? `\n\n${body}` : ""].join("").trim();
}

function safeSummaryForSynthesis(item: CommitFileSummary): string {
  const summary = item.summary;
  if (
    summary &&
    !isGenericSummary(summary) &&
    !looksLikeSymbolInventory(summary) &&
    !looksLikeMalformedSummary(summary) &&
    !looksLikePathLeak(summary) &&
    !looksLikeLowValueSummary(summary)
  ) {
    return summary;
  }
  if (
    item.fallback &&
    !isGenericSummary(item.fallback) &&
    !looksLikeSymbolInventory(item.fallback) &&
    !looksLikeMalformedSummary(item.fallback) &&
    !looksLikePathLeak(item.fallback) &&
    !looksLikeLowValueSummary(item.fallback)
  ) {
    return item.fallback;
  }
  return fallbackSummaryFromPath(item.path, item.status);
}

function synthesizeCommitMessageFromSummaries(summaries: CommitFileSummary[]): string {
  const concepts = rankedConceptsFromSummaries(summaries);
  if (concepts.length === 0) return "";
  const type = inferCommitType(summaries, concepts);
  const subjectConcepts = concepts.slice(0, 2);
  const subject = limitChars(`${type}: ${subjectAction(type)} ${formatHumanList(subjectConcepts)}`, 72);
  const bodyConcepts = concepts
    .slice(2, 5)
    .filter((concept) => !subjectConcepts.includes(concept));
  if (bodyConcepts.length === 0) return subject;
  return `${subject}\n\nIncludes ${formatHumanList(bodyConcepts)}.`;
}

function synthesizeChangeSummaryFromSummaries(summaries: CommitFileSummary[]): string {
  const concepts = rankedConceptsFromSummaries(summaries);
  if (concepts.length === 0) return "";
  const first = concepts.slice(0, 2);
  const rest = concepts.slice(2, 5);
  const lead = `${sentenceVerb(inferCommitType(summaries, concepts))} ${formatHumanList(first)}.`;
  if (rest.length === 0) return lead;
  return `${lead} Also includes ${formatHumanList(rest)}.`;
}

function rankedConceptsFromSummaries(summaries: CommitFileSummary[]): string[] {
  const candidates: string[] = [];
  for (const item of primarySummaries(summaries)) {
    const safe = safeSummaryForSynthesis(item);
    candidates.push(...conceptsFromText(safe));
    if (item.fallback) candidates.push(...conceptsFromText(item.fallback));
  }
  return rankConcepts(candidates);
}

function semanticSummaryFromDiff(diff: string): string {
  const candidates: string[] = [];
  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    const text = rawLine.slice(1).trim();
    if (!text) continue;
    candidates.push(...extractFeaturePhrases(text));
    candidates.push(...extractIdentifierConcepts(text));
  }
  return rankConcepts(candidates)[0] ?? "";
}

function conceptsFromText(text: string): string[] {
  return firstSentences(text, 3)
    .split(/[.!?]+|\s+[;&]\s+|\s+also includes\s+/i)
    .flatMap((part) => part.split(/\s+\band\b\s+/i))
    .map(conceptFromPhrase)
    .filter(Boolean);
}

function conceptFromPhrase(value: string): string {
  if (/\$|\bremote line\b/i.test(value)) return "";
  const cleaned = value
    .replace(/^(?:feat|fix|refactor|chore|docs|test|build|perf)(?:\([^)]+\))?:\s*/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^(?:adds?|updates?|removes?|renames?|fixes?|improves?|refines?|includes?|chunks?|locks?|shows?|keeps?|consolidates?|writes?|reads?|selects?|promotes?|stores?|materializes?|allows?|evaluates?|rejects?)\b/i, "")
    .replace(/\b(?:before|after|while|when|with|using|through|into|from)\b.*$/i, "")
    .replace(/[()[\]{}"'`]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim()
    .toLowerCase();
  if (!cleaned || cleaned.split(/\s+/).length < 2) return "";
  if (
    isGenericSummary(cleaned) ||
    looksLikeMalformedSummary(cleaned) ||
    looksLikePathLeak(cleaned) ||
    looksLikeSymbolInventory(cleaned) ||
    looksLikeStyleClassPhrase(cleaned) ||
    looksLikeBroadConcept(cleaned) ||
    looksLikeLowValueConcept(cleaned)
  ) {
    return "";
  }
  const words = cleaned
    .split(/\s+/)
    .filter((word) => !GENERIC_CONCEPT_WORDS.has(word))
    .slice(0, 6);
  if (words.length < 2) return "";
  return words.join(" ");
}

function rankConcepts(candidates: string[]): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const normalized = conceptFromPhrase(candidate) || candidate.trim().toLowerCase();
    if (!normalized || looksLikeBroadConcept(normalized) || looksLikeLowValueConcept(normalized)) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  const hasPrimary = entries.some(([concept]) => !looksLikeValidationConcept(concept));
  return entries
    .sort(([a, aCount], [b, bCount]) => {
      const aScore = conceptScore(a, aCount, hasPrimary);
      const bScore = conceptScore(b, bCount, hasPrimary);
      return bScore - aScore || a.localeCompare(b);
    })
    .map(([concept]) => concept)
    .slice(0, 6);
}

function conceptScore(concept: string, count: number, hasPrimary: boolean): number {
  const words = concept.split(/\s+/);
  let score = count * 4 + Math.min(words.length, 5);
  if (hasPrimary && looksLikeValidationConcept(concept)) score -= 5;
  if (/\b(memory|safeguard|validation|normalization|retry|judge|council|checkpoint|summary|generation|pipeline|harness|blueprint|archetype|scout|drafter)\b/.test(concept)) {
    score += 2;
  }
  if (/\b(git commit harness|judge council|memory graph|commit harness)\b/.test(concept)) {
    score += 4;
  }
  return score;
}

function inferCommitType(summaries: CommitFileSummary[], concepts: string[]): string {
  const typeSource = primarySummaries(summaries);
  const text = typeSource.map((item) => `${item.status} ${item.summary} ${item.fallback ?? ""}`).join(" ").toLowerCase();
  if (/\bfix(?:es|ed)?\b|\bbug\b|\bfail(?:s|ed|ure)?\b|\berror\b/.test(text)) return "fix";
  if (concepts.length > 0 && concepts.every(looksLikeDocsConcept)) return "docs";
  if (concepts.length > 0 && concepts.every(looksLikeValidationConcept)) return "test";
  if (/\badded\b|\badds?\b/.test(text) || typeSource.some((item) => item.status === "added")) return "feat";
  return "chore";
}

function subjectAction(type: string): string {
  if (type === "fix") return "correct";
  if (type === "docs" || type === "chore") return "update";
  if (type === "test") return "add";
  return "add";
}

function sentenceVerb(type: string): string {
  if (type === "fix") return "Fixes";
  if (type === "docs" || type === "chore") return "Updates";
  return "Adds";
}

function summaryVerbForStatus(status: GitFileEntry["status"]): string {
  if (status === "added") return "Adds";
  if (status === "deleted") return "Removes";
  if (status === "renamed") return "Renames";
  return "Updates";
}

function looksLikeValidationConcept(concept: string): boolean {
  return /\b(test|tests|testing|coverage|fixture|fixtures|spec|specs|regression|e2e|validation)\b/.test(concept);
}

function looksLikeDocsConcept(concept: string): boolean {
  return /\b(readme|docs|documentation|guide|manual)\b/.test(concept);
}

function looksLikeBroadConcept(concept: string): boolean {
  const normalized = concept.replace(/\s+/g, " ").trim();
  return (
    /\brelated behavior\b/.test(normalized) ||
    /\bproject behavior\b/.test(normalized) ||
    /\bworkspace behavior\b/.test(normalized) ||
    /\bworkflow support\b/.test(normalized) ||
    /\bvisual [a-z\s]+ workflow support\b/.test(normalized) ||
    /^[a-z\s]+ workflow$/.test(normalized)
  );
}

function looksLikeLowValueConcept(concept: string): boolean {
  return /\b(char count|lower case|upper case|data testid|get role|get text|set state|class name|line range|raw chunk|return chunks?|looks like|first sentences?|file paths?|path fragments?|num predict|parent ids?|body start line|git file entry|match all|limit chars?|max chars?|judge index|failure tags?|approved memory|writes approved|action mode|agent orbit|allowed tools?|requires judge use|input kinds?|commit main|single line|drop shadow|box shadow|accent hot|align items|border radius|end line|strip model decorations|raw symbols|harness mode|harness core|council item verdict|apply patch|due diligence trace|commit message inaccurate)\b/.test(
    concept,
  );
}

function looksLikeLowValueSummary(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/^(?:adds?|updates?|removes?|renames?|fixes?|improves?|includes?)\s+/, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return looksLikeLowValueConcept(normalized);
}

function looksLikeLowValueCommitMessage(text: string): boolean {
  return text.split(/\r?\n/).some((line) => looksLikeLowValueSummary(line));
}

function synthesizeCommitIntent(summaries: CommitFileSummary[]): string {
  const themes = detectedThemes(summaries);
  if (themes.length === 0) return "";
  const text = commitSignalText(summaries);
  const verb = /\bfix(?:es|ed)?\b|\bbug\b|\bfail(?:s|ed|ure)?\b/.test(text)
    ? "Fix"
    : /\badd(?:s|ed)?\b|\bnew\b/.test(text) && themes.length === 1
      ? "Add"
      : "Improve";
  return `${verb} ${formatHumanList(themes)}`;
}

function commitSignalText(summaries: CommitFileSummary[]): string {
  return primarySummaries(summaries)
    .flatMap((item) => [item.path, item.summary, item.fallback ?? ""])
    .join(" ")
    .toLowerCase();
}

function primarySummaries<T extends CommitFileSummary>(summaries: T[]): T[] {
  const primary = summaries.filter((item) => !isSupportPath(item.path));
  return primary.length > 0 ? primary : summaries;
}

function isSupportPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const file = normalized.split("/").at(-1) ?? normalized;
  return (
    /(^|\/)(test|tests|spec|specs|fixture|fixtures|mock|mocks|docs?|documentation)(\/|$)/.test(
      normalized,
    ) ||
    /(^|\/)scripts\/quality(\/|$)/.test(normalized) ||
    /(^|\/)quality(\/|$)/.test(normalized) ||
    /\.(css|scss|sass|less|pcss|postcss)$/.test(file) ||
    /\.(test|spec|fixture|mock)\.[^.]+$/.test(file) ||
    /^(readme|changelog|changes|license|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)(\.|$)/.test(file)
  );
}

function detectedThemes(summaries: CommitFileSummary[]): string[] {
  return rankedConceptsFromSummaries(summaries).slice(0, 2);
}

function isGenericSummary(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[.!?]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    !normalized ||
    normalized === "updates related behavior" ||
    normalized === "update related behavior" ||
    normalized === "adds related behavior" ||
    normalized === "add related behavior" ||
    normalized === "updates project behavior" ||
    normalized === "update project behavior" ||
    normalized === "updates workspace behavior" ||
    normalized === "update workspace behavior" ||
    looksLikeBroadConcept(normalized.replace(/^(?:adds?|updates?|improves?)\s+/, "")) ||
    /^updates? related\b/.test(normalized) ||
    /^adds? related\b/.test(normalized)
  );
}

function looksLikeMalformedSummary(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return (
    /^(updates?|adds?|removes?|renames?|fixes?|improves?)\s*[.!?]?$/.test(
      normalized,
    ) ||
    /^(updates?|adds?|removes?|renames?|fixes?|improves?)\s+[.!?]/.test(
      normalized,
    ) ||
    /^(updates?|adds?|removes?|renames?|fixes?|improves?)\s+diff --git\b/.test(
      normalized,
    ) ||
    /^(updates?|adds?|removes?|renames?|fixes?|improves?)\s+improves?\b/.test(
      normalized,
    ) ||
    /^(updates?|adds?|removes?|renames?|fixes?|improves?)\s+[a-z\s]*\s+[.!?]/.test(
      normalized,
    ) ||
    /\.\.$/.test(normalized)
  );
}

function looksLikePathLeak(text: string): boolean {
  return /\b(?:src|e2e|scripts|tests?|packages|crates|apps|fixtures|components|lib)\/[A-Za-z0-9._/-]+/.test(
    text,
  );
}

function isGenericCommitMessage(text: string): boolean {
  const sentences = firstSentences(text.replace(/\n+/g, " "), 3)
    .split(/[.!?]+/)
    .map((line) => line.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (sentences.length === 0) return true;
  return sentences.every(isGenericSummary);
}

function looksLikeThemeOnlyCommitMessage(
  text: string,
  summaries: CommitFileSummary[],
): boolean {
  if (hasConcreteCommitSignals(text)) return false;
  const themes = detectedThemes(summaries);
  if (themes.length === 0) return false;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[.!?]+$/g, "").trim())
    .filter(Boolean);
  const subject = lines[0]?.toLowerCase() ?? "";
  if (!/^(improve|update|refine|add|fix)\s+/.test(subject)) return false;
  const body = lines.slice(1).join(" ").toLowerCase();
  if (body && !isGenericSummary(body) && !themes.every((theme) => body.includes(theme))) {
    return false;
  }
  const expected = /^(improve|update|refine|add|fix)\s+/.exec(subject)?.[0] ?? "";
  const subjectPayload = subject.slice(expected.length).trim();
  return (
    subjectPayload === formatHumanList(themes) ||
    themes.every((theme) => subjectPayload.includes(theme))
  );
}

function looksLikeBadChangeSummary(text: string, paths: string[]): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const updateCount = (normalized.match(/\bUpdates?\b/g) ?? []).length;
  return (
    /\$\{[^}]+\}/.test(normalized) ||
    /\bremote line\b/i.test(normalized) ||
    /\bupdates?\s+adds?\b/i.test(normalized) ||
    /\.\./.test(normalized) ||
    updateCount >= 2 ||
    looksLikeFileInventory(normalized, paths) ||
    paths.some((path) =>
      pathInventoryFragments(path).some((fragment) => lower.includes(fragment)),
    )
  );
}

function hasConcreteCommitSignals(text: string): boolean {
  const normalized = text
    .replace(/^(?:feat|fix|refactor|chore|docs|test|build|perf)(?:\([^)]+\))?:\s*/i, "")
    .replace(/^(?:adds?|updates?|removes?|renames?|fixes?|improves?|refines?)\b/i, "")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
  const rawParts = normalized.split(/\s+and\s+|[,;]+/i).map((part) => part.trim()).filter(Boolean);
  if (rawParts.some(looksLikeBroadConcept)) return false;
  return conceptsFromText(text).some((concept) => !looksLikeBroadConcept(concept));
}

function looksLikeSymbolInventory(text: string): boolean {
  const normalized = text.replace(/`/g, "");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const subject = lines[0] ?? "";
  const rawSymbols = [...normalized.matchAll(/\b[A-Za-z_$][\w$]*\b/g)]
    .map((match) => match[0])
    .filter(isCodeLikeIdentifier);
  const updateSymbolSubject =
    /^(?:update|updates|add|adds|improve|improves|fix|fixes)\s+[A-Za-z_$][\w$]*$/i.test(
      subject,
    ) && rawSymbols.length > 0;
  const repetitiveUpdates =
    (normalized.match(/\bUpdates?\s+[A-Za-z_$][\w$]*\b/g) ?? []).length >= 2;
  const pathHumanizationLeak = /\bfixtures pointer app\b|\be2e fixture\b/i.test(normalized);
  return updateSymbolSubject || rawSymbols.length >= 2 || repetitiveUpdates || pathHumanizationLeak;
}

function isCodeLikeIdentifier(value: string): boolean {
  return (
    /_/.test(value) ||
    /^[a-z][A-Za-z0-9]*[A-Z]/.test(value) ||
    /^[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(value)
  );
}

function extractFeaturePhrases(line: string): string[] {
  const quoted = [...line.matchAll(/["'`]([^"'`]{3,60})["'`]/g)]
    .map((match) => match[1].trim())
    .filter(
      (value) =>
        /[A-Za-z]/.test(value) &&
        value.split(/\s+/).length <= 8 &&
        !value.includes("${") &&
        !/[{}\\/]/.test(value) &&
        !/\b(lacks?|expected|received|failed|failure|error|warning)\b/i.test(value) &&
        !looksLikeStyleClassPhrase(value) &&
        !looksLikeSymbolInventory(value) &&
        !/^[a-z0-9_-]+$/i.test(value),
    )
    .slice(0, 2);
  return quoted;
}

function extractIdentifierConcepts(line: string): string[] {
  if (/\bclass(?:name)?\s*=/i.test(line)) return [];
  const concepts = new Set<string>();
  for (const match of line.matchAll(/\b[A-Za-z][A-Za-z0-9_$:-]{2,}\b/g)) {
    const raw = match[0];
    if (raw.length > 80 || /^[A-Z0-9_]+$/.test(raw)) continue;
    const words = splitIdentifierWords(raw)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length > 2 && !GENERIC_CONCEPT_WORDS.has(word));
    if (words.length >= 2 && words.length <= 6) {
      const phrase = words.join(" ");
      if (!looksLikeStyleClassPhrase(phrase) && !looksLikeBroadConcept(phrase)) {
        concepts.add(phrase);
      }
    }
  }
  return [...concepts];
}

function splitIdentifierWords(value: string): string[] {
  return value
    .replace(/[$]/g, "")
    .replace(/[-_:]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

function looksLikeStyleClassPhrase(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const classLikeHits = tokens.filter((token) => {
    const cleaned = token.replace(/^[:.[#]+|[,;]+$/g, "");
    return (
      /[:[\]#.%]/.test(cleaned) ||
      /^[a-z]+-\d+$/i.test(cleaned) ||
      /^[a-z]+-[a-z0-9]+$/i.test(cleaned) ||
      /^[a-z]+-\[[^\]]+\]$/i.test(cleaned) ||
      /^[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(cleaned)
    );
  }).length;
  return classLikeHits / tokens.length >= 0.5 || /\[[^\]]+\]/.test(value);
}

const GENERIC_CONCEPT_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "before",
  "after",
  "while",
  "when",
  "using",
  "through",
  "support",
  "behavior",
  "workflow",
  "related",
  "class",
  "name",
]);

function humanizePath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? path;
  const base = file.replace(/\.[^.]+$/, "");
  const parent = parts.at(-2);
  const raw = parent && !["src", "lib", "components", "commands"].includes(parent)
    ? `${parent} ${base}`
    : base;
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function formatHumanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "project behavior";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "behavior";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function subjectFromSummary(summary: string): string {
  const trimmed = summary.replace(/[.!?]+$/g, "").trim();
  if (!trimmed) return "Refine project behavior";
  if (/^(add|adds|added)\b/i.test(trimmed)) {
    return limitChars(trimmed.replace(/^adds?\b/i, "Add"), 72);
  }
  if (/^(update|updates|updated)\b/i.test(trimmed)) {
    return limitChars(trimmed.replace(/^updates?\b/i, "Update"), 72);
  }
  if (/^(fix|fixes|fixed)\b/i.test(trimmed)) {
    return limitChars(trimmed.replace(/^fixes?\b/i, "Fix"), 72);
  }
  if (/^(improve|improves|improved)\b/i.test(trimmed)) {
    return limitChars(trimmed.replace(/^improves?\b/i, "Improve"), 72);
  }
  return limitChars(`Update ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`, 72);
}

function firstSentences(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const matches = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [normalized];
  return matches
    .slice(0, max)
    .map((sentence) => sentence.trim())
    .join(" ")
    .trim();
}

function limitWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[.,;:]+$/g, "")}.`;
}

function limitChars(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars - 1).replace(/\s+\S*$/, "").trim();
}

export function groupBranches(branches: GitBranch[]): {
  local: GitBranch[];
  remote: GitBranch[];
} {
  return {
    local: branches.filter((branch) => !branch.remote),
    remote: branches.filter((branch) => branch.remote),
  };
}

export function operationActionLabel(operation: GitOperationState): string {
  switch (operation.kind) {
    case "rebase":
      return "Continue rebase";
    case "merge":
      return "Continue merge";
    case "cherry_pick":
      return "Continue cherry-pick";
    case "revert":
      return "Continue revert";
  }
}

export function operationAbortLabel(operation: GitOperationState): string {
  switch (operation.kind) {
    case "rebase":
      return "Abort rebase";
    case "merge":
      return "Abort merge";
    case "cherry_pick":
      return "Abort cherry-pick";
    case "revert":
      return "Abort revert";
  }
}

export function operationProgress(operation: GitOperationState): number | null {
  if (!operation.current || !operation.total || operation.total <= 0) return null;
  return Math.max(0, Math.min(100, (operation.current / operation.total) * 100));
}
