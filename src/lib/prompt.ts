/**
 * Priompt-inspired prompt builder. Pieces are inserted with a priority; if the
 * total token estimate exceeds the budget, lowest-priority pieces are dropped.
 * Token counts are approximated as chars / 4.
 */
export type Piece = { priority: number; tag: string; text: string };

export class PromptBudget {
  private pieces: Piece[] = [];
  constructor(public maxTokens: number) {}
  push(priority: number, tag: string, text: string) {
    if (text) this.pieces.push({ priority, tag, text });
    return this;
  }
  build(): { text: string; tagsIncluded: string[]; tokensEstimated: number } {
    const ordered = [...this.pieces.entries()].sort(
      (a, b) => b[1].priority - a[1].priority,
    );
    const budgetChars = this.maxTokens * 4;
    const includedSet = new Set<number>();
    let used = 0;
    for (const [idx, p] of ordered) {
      const cost = p.text.length + 2;
      if (used + cost <= budgetChars) {
        includedSet.add(idx);
        used += cost;
      }
    }
    const tagsIncluded: string[] = [];
    const out: string[] = [];
    this.pieces.forEach((p, idx) => {
      if (includedSet.has(idx)) {
        out.push(p.text);
        tagsIncluded.push(p.tag);
      }
    });
    return {
      text: out.join("\n\n"),
      tagsIncluded,
      tokensEstimated: Math.ceil(used / 4),
    };
  }
}

export function fileBlock(path: string, contents: string, language?: string) {
  const lang = language ?? "";
  return `<file path="${path}">\n\`\`\`${lang}\n${contents}\n\`\`\`\n</file>`;
}

export function selectionBlock(
  path: string,
  startLine: number,
  endLine: number,
  contents: string,
  language?: string,
) {
  const lang = language ?? "";
  return `<selection path="${path}" lines="${startLine}-${endLine}">\n\`\`\`${lang}\n${contents}\n\`\`\`\n</selection>`;
}

export function codebaseBlock(
  chunks: { path: string; start_line: number; end_line: number; text: string }[],
) {
  if (!chunks.length) return "";
  const items = chunks
    .map(
      (c) =>
        `--- ${c.path}:${c.start_line}-${c.end_line} ---\n${c.text}`,
    )
    .join("\n\n");
  return `<codebase>\n${items}\n</codebase>`;
}

/**
 * Diagnostic block. We include source/code/severity in the open tag so the
 * model can address the user's intent ("fix this TS2304") without us
 * needing to spell it out in the prose. The snippet is the offending
 * lines verbatim — keep it small.
 */
export function diagnosticBlock(opts: {
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  severity: string;
  source: string;
  code?: string;
  message: string;
  snippet: string;
  language?: string;
}) {
  const lang = opts.language ?? "";
  const codeAttr = opts.code ? ` code="${opts.code}"` : "";
  return [
    `<diagnostic path="${opts.path}" lines="${opts.startLine}-${opts.endLine}" severity="${opts.severity}" source="${opts.source}"${codeAttr}>`,
    `message: ${opts.message}`,
    "",
    "```" + lang,
    opts.snippet,
    "```",
    `</diagnostic>`,
  ].join("\n");
}

export function breakpointBlock(opts: {
  path: string;
  line: number;
  column?: number;
  enabled: boolean;
  condition?: string;
  logMessage?: string;
}) {
  const columnAttr = opts.column ? ` column="${opts.column}"` : "";
  const condition = opts.condition ? `condition: ${opts.condition}` : "";
  const log = opts.logMessage ? `log: ${opts.logMessage}` : "";
  return [
    `<breakpoint path="${opts.path}" line="${opts.line}"${columnAttr} enabled="${opts.enabled}">`,
    condition,
    log,
    `</breakpoint>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function debugValueBlock(opts: {
  name: string;
  value: string;
  type?: string;
  path?: string;
  line?: number;
  scope?: string;
  frame?: string;
  thread?: string;
}) {
  const attrs = [
    `name="${escapeAttr(opts.name)}"`,
    opts.type ? `type="${escapeAttr(opts.type)}"` : "",
    opts.path ? `path="${escapeAttr(opts.path)}"` : "",
    opts.line ? `line="${opts.line}"` : "",
    opts.scope ? `scope="${escapeAttr(opts.scope)}"` : "",
    opts.frame ? `frame="${escapeAttr(opts.frame)}"` : "",
    opts.thread ? `thread="${escapeAttr(opts.thread)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<debug-value ${attrs}>\n${opts.value}\n</debug-value>`;
}

/** Compact folder listing — just the immediate children. The agent / chat
 *  model can ask for deeper subtrees explicitly if it needs them. */
export function folderBlock(path: string, entries: string[]): string {
  if (entries.length === 0) {
    return `<folder path="${path}">(empty)</folder>`;
  }
  return `<folder path="${path}">\n${entries.join("\n")}\n</folder>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
