/**
 * Mention parsing — the small, pure layer underneath the @-picker UI.
 *
 * The composer needs to answer three questions on every keystroke:
 *
 *   1. Is the caret sitting at the end of an `@…` token? (open / close
 *      the picker)
 *   2. What's the user typing after the `@`? (query the right category)
 *   3. After picking a suggestion, where exactly do we splice the
 *      resulting token into the textarea? (replace `@xxx` with the
 *      canonical token like `@src/foo.ts`).
 *
 * Keeping all three answers in one tiny module means the chat composer,
 * the agent panel and any future surface (palette, inline edit…) read
 * mentions the *same* way, including the same edge cases (caret in the
 * middle of a word, mentions inside backtick spans, etc.).
 */

/**
 * Token categories the picker offers. The shorthand here is exactly what
 * the user can type after `@` to filter directly into a category — e.g.
 * `@codebase what does X do` jumps straight to the codebase row. The
 * picker still shows other categories when the query is empty.
 */
export type MentionCategory =
  | "file"
  | "folder"
  | "selection"
  | "codebase"
  | "diagnostic"
  | "breakpoint"
  | "debug"
  | "symbol";

/** Live state of the mention probe at the cursor position. */
export type MentionProbe =
  | { open: false }
  | {
      open: true;
      /** Inclusive 0-based index of the `@` that opened the mention. */
      atStart: number;
      /** Exclusive 0-based index just after the last char of the query. */
      atEnd: number;
      /** Text the user has typed after the `@`. May be empty. */
      query: string;
    };

/**
 * Inspect `text` with the caret at `caret` (0-based offset in the textarea)
 * and decide whether a mention picker should be open and, if so, what
 * query to use.
 *
 * The trigger rule:
 *   • There must be an unescaped `@` somewhere to the left of the caret.
 *   • Between that `@` and the caret, only "mention-safe" characters are
 *     allowed: word chars, `./-_~:`. Whitespace closes the mention.
 *   • The `@` itself must be at the very start of the text OR preceded by
 *     whitespace — otherwise it's almost certainly an email address /
 *     decorator / npm-scope and a mention popup would be intrusive.
 */
export function probeMention(text: string, caret: number): MentionProbe {
  // Walk backwards from the caret looking for the most recent `@` that
  // could plausibly anchor a mention.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text.charAt(i);
    if (ch === "@") {
      // Must be at start-of-text or preceded by whitespace.
      const prev = i === 0 ? "" : text.charAt(i - 1);
      if (i !== 0 && !/\s/.test(prev)) return { open: false };
      const query = text.slice(i + 1, caret);
      if (!isMentionQuery(query)) return { open: false };
      return { open: true, atStart: i, atEnd: caret, query };
    }
    if (ch === "\n") return { open: false };
  }
  return { open: false };
}

/** Token registry: built-in categories the picker should advertise even
 *  when the query is empty. The label is what's shown in the row; the
 *  alias list is what `@xxx` queries can match against to jump straight
 *  to the row.
 *
 *  Note on @symbol: kept in the `MentionCategory` type because the
 *  Reference union still includes a `symbol` kind for legacy stored
 *  sessions, but deliberately *omitted* from the registry — the picker
 *  has no symbol search backend yet, so surfacing it here would lead
 *  the user to an empty results list. We'll add it back when there's
 *  a real symbol provider behind it.
 */
export const CATEGORY_REGISTRY: {
  category: MentionCategory;
  label: string;
  description: string;
  /** Aliases the query can match. We compare lowercased. */
  aliases: string[];
}[] = [
  {
    category: "file",
    label: "@file",
    description: "Attach a workspace file by name.",
    aliases: ["file", "f"],
  },
  {
    category: "folder",
    label: "@folder",
    description: "Attach a directory listing.",
    aliases: ["folder", "dir", "directory"],
  },
  {
    category: "selection",
    label: "@selection",
    description: "Attach the current editor selection.",
    aliases: ["selection", "sel"],
  },
  {
    category: "codebase",
    label: "@codebase",
    description: "Semantic search across indexed chunks.",
    aliases: ["codebase", "code", "search"],
  },
  {
    category: "diagnostic",
    label: "@diagnostic",
    description: "Attach a current lint / type error.",
    aliases: ["diagnostic", "diag", "error", "lint"],
  },
  {
    category: "breakpoint",
    label: "@breakpoint",
    description: "Attach a debugger breakpoint.",
    aliases: ["breakpoint", "bp"],
  },
  {
    category: "debug",
    label: "@debug",
    description: "Attach a captured debug value.",
    aliases: ["debug", "value", "watch", "variable"],
  },
];

/**
 * Decide which category (if any) the query is *explicitly* asking for.
 *
 * "@selection" / "@sel" → "selection"
 * "@code rgb to hsl" → "codebase" (and the rest is the codebase query)
 * "@" → null (show everything)
 * "@foo" → null (no exact category match; we still rank file suggestions)
 */
export function intentFromQuery(query: string): {
  category: MentionCategory | null;
  remainder: string;
} {
  const trimmed = query.trim();
  if (!trimmed) return { category: null, remainder: "" };
  const lower = trimmed.toLowerCase();
  for (const r of CATEGORY_REGISTRY) {
    for (const alias of r.aliases) {
      if (lower === alias) return { category: r.category, remainder: "" };
      if (lower.startsWith(alias + " ")) {
        return {
          category: r.category,
          remainder: trimmed.slice(alias.length + 1),
        };
      }
      // Special case for `@codebase`: a trailing slash/dot/etc. means
      // the user is starting to type a query immediately, e.g. `@code:`.
      if (lower.startsWith(alias + ":")) {
        return {
          category: r.category,
          remainder: trimmed.slice(alias.length + 1),
        };
      }
    }
  }
  return { category: null, remainder: trimmed };
}

/**
 * Splice the textarea content so the `@…` token at the cursor is replaced
 * with `insertion`. Returns the new text and the caret offset that
 * follows the insertion (so the caller can restore the cursor cleanly).
 */
/**
 * Splice `insertion` over the probed `@…` range. Pure: callers add any
 * trailing whitespace they want (and dedupe against the existing tail
 * if doubling up would look ugly).
 *
 * `caret` is the caret position immediately after `insertion`, ready
 * to be passed straight to `HTMLTextAreaElement.setSelectionRange`.
 */
export function applyMention(
  text: string,
  probe: Pick<Extract<MentionProbe, { open: true }>, "atStart" | "atEnd">,
  insertion: string,
): { text: string; caret: number } {
  const head = text.slice(0, probe.atStart);
  let tail = text.slice(probe.atEnd);
  // Single concession to UX: if the user is splicing a token that
  // already ends with a space AND the existing tail starts with one,
  // drop the tail's space so we don't render a visually awkward
  // double gap. Everything else is left to the caller.
  if (insertion.endsWith(" ") && tail.startsWith(" ")) {
    tail = tail.slice(1);
  }
  return {
    text: head + insertion + tail,
    caret: head.length + insertion.length,
  };
}

/**
 * Canonical mention token for a reference — what we splice into the
 * textarea after a picker selection. The same token is used by the
 * mirror overlay to find and style the mention inline.
 */
export function mentionToken(
  kind:
    | { kind: "file"; path: string }
    | { kind: "folder"; path: string }
    | { kind: "selection"; path: string; startLine: number; endLine: number }
    | { kind: "codebase"; query: string }
    | { kind: "symbol"; name: string }
    | { kind: "breakpoint"; path: string; line: number }
    | { kind: "debugValue"; name: string }
    | { kind: "diagnostic"; path: string; startLine: number; code?: string },
): string {
  switch (kind.kind) {
    case "file":
      return `@${shorten(kind.path)}`;
    case "folder":
      return `@${shorten(kind.path)}/`;
    case "selection":
      return `@${shorten(kind.path)}:L${kind.startLine}-${kind.endLine}`;
    case "codebase":
      return `@codebase${kind.query ? `:${kind.query.replace(/\s+/g, "_")}` : ""}`;
    case "symbol":
      return `@${kind.name}`;
    case "breakpoint":
      return `@${shorten(kind.path)}:L${kind.line}`;
    case "debugValue":
      return `@debug:${kind.name.replace(/\s+/g, "_")}`;
    case "diagnostic":
      return `@${shorten(kind.path)}:L${kind.startLine}${kind.code ? `(${kind.code})` : ""}`;
  }
}

function shorten(p: string): string {
  return p.split(/[\\/]/).slice(-2).join("/");
}

function isMentionQuery(query: string): boolean {
  if (query.includes("@")) return false;
  if (!query.includes(" ")) return /^[\w./\-_:~]*$/.test(query);
  const first = query.trimStart().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!first || !categoryForAlias(first)) return false;
  return /^[\w./\-_:~ ][\w./\-_:~ \-]*$/.test(query);
}

function categoryForAlias(alias: string): MentionCategory | null {
  for (const row of CATEGORY_REGISTRY) {
    if (row.aliases.includes(alias)) return row.category;
  }
  return null;
}

/**
 * Build a regex that matches *all* mention tokens currently present in
 * the input. Used by the mirror overlay to highlight tokens inline.
 *
 * Tokens are escaped for safe inclusion in a RegExp. Empty registry
 * returns a regex that never matches.
 */
export function buildMentionRegex(tokens: string[]): RegExp {
  if (tokens.length === 0) return /(?!)/g;
  // Longest first so a folder token (`@src/`) doesn't get partially
  // consumed by a file token (`@src`).
  const ordered = [...tokens].sort((a, b) => b.length - a.length);
  const escaped = ordered.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})`, "g");
}
