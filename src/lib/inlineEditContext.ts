/**
 * Compose the user-facing message body for a Cmd+K inline edit.
 *
 * The default approach — "send the selection and the user's prompt" —
 * gives the chat model very little to work with. Without surrounding
 * code the model can't honour local style (indent depth, naming
 * conventions, whether the selection is a method body or a top-level
 * statement). Without recent-file context it can't reuse helpers the
 * user just wrote. And when the user typed "fix this", the model
 * doesn't see the diagnostic message it should fix.
 *
 * This function assembles a structured message that gives the model
 * everything it needs to make a confident edit on the first try.
 * The shape:
 *
 *   <recent-files block, if any>
 *
 *   File: {path}
 *   Selection (lines {start}-{end}):
 *   ```{lang}
 *   {selection text}
 *   ```
 *
 *   Surrounding context:
 *   ```{lang}
 *   {N lines before}
 *   <<< SELECTION >>>
 *   {N lines after}
 *   ```
 *
 *   Diagnostics overlapping the selection:
 *   - line X: {message}
 *
 * Budget discipline mirrors the FIM builder:
 *   • Selection + surrounding context are sacred.
 *   • Recent files come first when room allows, but are dropped
 *     before we trim anything else.
 *   • Diagnostics are cheap (short strings) — always included.
 */

import { detectPattern } from "./patterns";

export type InlineEditDiagnostic = {
  line: number;
  message: string;
  /** Severity is plain string so callers don't have to map the
   *  editor's diagnostic enum (which includes "hint") onto our
   *  narrower set. Anything goes into the prompt as-is. */
  severity: string;
};

export type InlineEditInput = {
  filePath: string;
  fileContent: string;
  selection: {
    startLine: number;
    endLine: number;
    text: string;
  };
  language: string;
  recentFiles: Array<{ path: string; content: string }>;
  diagnostics: InlineEditDiagnostic[];
  /** Character cap on the assembled user message. The selection and
   *  surrounding-context blocks are preserved in full; everything
   *  else gets trimmed to fit. */
  budgetChars: number;
};

export type InlineEditOutput = {
  userMessage: string;
  trace: {
    recentFilesIncluded: Array<{ path: string; chars: number }>;
    diagnosticsIncluded: number;
    surroundingLines: number;
    pattern: string | null;
  };
};

const SURROUNDING_LINES = 8;
const MAX_REF_CHARS = 800;

export function buildInlineEditContext(
  input: InlineEditInput,
): InlineEditOutput {
  const lines = input.fileContent.split(/\r?\n/);
  const before = lines
    .slice(
      Math.max(0, input.selection.startLine - 1 - SURROUNDING_LINES),
      Math.max(0, input.selection.startLine - 1),
    )
    .join("\n");
  const after = lines
    .slice(
      input.selection.endLine,
      input.selection.endLine + SURROUNDING_LINES,
    )
    .join("\n");
  const surroundingLines =
    before.split("\n").filter((l) => l !== "").length +
    after.split("\n").filter((l) => l !== "").length;
  const pattern = detectPattern(before, after);
  const patternName = pattern.kind === "none" ? null : pattern.kind;

  // Selection + surrounding (sacred). Construct first so we know how
  // many chars to reserve.
  const selectionBlock =
    `File: ${input.filePath}\n` +
    `Selection (lines ${input.selection.startLine}-${input.selection.endLine}):\n` +
    fence(input.language, input.selection.text);
  const contextBlock =
    `Surrounding context:\n` +
    fence(
      input.language,
      `${before}\n<<< SELECTION (lines ${input.selection.startLine}-${input.selection.endLine}) >>>\n${after}`,
    );

  // Diagnostics block — always included, short.
  const overlapping = input.diagnostics.filter(
    (d) => d.line >= input.selection.startLine && d.line <= input.selection.endLine,
  );
  const diagnosticsBlock =
    overlapping.length > 0
      ? `Diagnostics overlapping the selection:\n` +
        overlapping
          .map(
            (d) =>
              `- [${d.severity}] line ${d.line}: ${d.message}`,
          )
          .join("\n")
      : "";

  const patternBlock = patternName
    ? `Pattern around selection: ${patternName}`
    : "";

  // Total floor — what we'd output even with zero refs.
  const floorParts = [
    selectionBlock,
    contextBlock,
    diagnosticsBlock,
    patternBlock,
  ].filter(Boolean);
  const floor = floorParts.join("\n\n");

  // Headroom available for recent-file refs.
  const headroom = Math.max(0, input.budgetChars - floor.length);
  const recentIncluded: InlineEditOutput["trace"]["recentFilesIncluded"] = [];
  const recentBlocks: string[] = [];
  let used = 0;
  for (const r of input.recentFiles) {
    const truncated = r.content.slice(0, MAX_REF_CHARS);
    const block =
      `Recent file: ${r.path}\n` + fence(input.language, truncated);
    if (used + block.length + 2 > headroom) break;
    recentBlocks.push(block);
    recentIncluded.push({ path: r.path, chars: truncated.length });
    used += block.length + 2;
  }
  const recentSection = recentBlocks.length
    ? recentBlocks.join("\n\n") + "\n\n"
    : "";

  return {
    userMessage: `${recentSection}${floor}`,
    trace: {
      recentFilesIncluded: recentIncluded,
      diagnosticsIncluded: overlapping.length,
      surroundingLines,
      pattern: patternName,
    },
  };
}

function fence(language: string, body: string): string {
  return "```" + language + "\n" + body + "\n```";
}
