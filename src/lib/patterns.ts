/**
 * Pure pattern detectors used by the FIM context builder.
 *
 * Every detector is synchronous, side-effect-free, and bounded — we
 * are called on every keystroke, so anything quadratic in file size
 * would tax the host. Callers slice the prefix / suffix to a small
 * window (a few hundred lines) before calling us.
 *
 * Detection philosophy: high precision, lower recall. A wrong hint
 * actively misleads the model (it sees "we're in a list" and starts
 * predicting list items even when we aren't), so each detector
 * refuses to fire unless it's reasonably sure.
 */

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export type PatternKind =
  | "list" // repeated items (object literals, switch cases, enum members)
  | "import" // an import statement is in progress
  | "signature" // about to define a function — header / parameters
  | "body" // inside a function body
  | "none";

export type ListPattern = {
  kind: "list";
  /** The template line(s) the user has been repeating. Stripped of
   *  trailing commas / whitespace so the model sees the "shape". */
  template: string;
  /** Number of repetitions we counted. >=2 to fire. */
  count: number;
};

export type ImportPattern = {
  kind: "import";
  /** The module path being imported FROM, if we could see one. */
  module: string | undefined;
};

export type FunctionPattern =
  | { kind: "signature" }
  | { kind: "body" }
  | { kind: "none" };

export type DetectedPattern =
  | ListPattern
  | ImportPattern
  | { kind: "signature" }
  | { kind: "body" }
  | { kind: "none" };

/** Casing convention of an identifier set. Used to nudge the model
 *  toward the local style. `mixed` is a real outcome (don't pretend
 *  there's a convention when there isn't). */
export type NamingConvention =
  | "camelCase"
  | "snake_case"
  | "PascalCase"
  | "SCREAMING_SNAKE"
  | "kebab-case"
  | "mixed";

// ──────────────────────────────────────────────────────────────────────
// detectListContinuation
// ──────────────────────────────────────────────────────────────────────

/**
 * Look at the last few non-empty lines of the prefix and decide
 * whether the user is in the middle of typing a repeated structure
 * (array literal, object literal, switch ladder, enum, etc.).
 *
 * We don't try to parse the code — we tokenise lines into "shape
 * signatures" (the sequence of non-identifier punctuation) and check
 * whether the last two or three lines share the same signature.
 */
export function detectListContinuation(prefix: string): ListPattern | { kind: "none" } {
  const lines = lastMeaningfulLines(prefix, 8);
  if (lines.length < 2) return { kind: "none" };
  // Shape signature: drop string contents and identifiers; keep
  // punctuation + keywords. Two adjacent lines with the same
  // signature are evidence of a repetition.
  const sigs = lines.map(shapeSignature);
  // Walk backwards finding the longest run of identical signatures
  // ending at the most-recent line.
  let count = 1;
  const tailSig = sigs[sigs.length - 1];
  for (let i = sigs.length - 2; i >= 0; i--) {
    if (sigs[i] === tailSig && tailSig.length >= 2) {
      count += 1;
    } else {
      break;
    }
  }
  if (count < 2) return { kind: "none" };
  // Reject "false positives" where the signature is so generic
  // (e.g. just `;`) that it'd match arbitrary lines.
  if (tailSig.length < 2) return { kind: "none" };
  const template = lines[lines.length - 1].trim().replace(/,\s*$/, "");
  return { kind: "list", template, count };
}

/** Reduce a line to a "shape" — keeping structural punctuation and
 *  hash-stripped identifiers. This lets two semantically-similar
 *  lines map to the same key even though their string / number
 *  literals differ. */
function shapeSignature(line: string): string {
  return (
    line
      .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "S") // strings -> S
      .replace(/\b\d[\d_.eE+-]*\b/g, "N") // numbers -> N
      .replace(/\b[A-Za-z_$][\w$]*\b/g, "I") // identifiers -> I
      .replace(/\s+/g, "")
      .slice(0, 80)
  );
}

/** Return the last `n` non-empty trimmed lines (preserving original
 *  text — we only use the trimmed copy for shape comparison). */
function lastMeaningfulLines(text: string, n: number): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = raw.length - 1; i >= 0 && out.length < n; i--) {
    const t = raw[i];
    if (t.trim() === "") continue;
    out.unshift(t);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// detectImportBlock
// ──────────────────────────────────────────────────────────────────────

/**
 * Recognise that the cursor sits inside an `import …` statement
 * (with or without a trailing `from "x"`).
 *
 * We require the `import` keyword to be the FIRST token on its line —
 * matches inside comments, strings, or arbitrary identifiers don't
 * fire. We also tolerate multi-line imports (the keyword on a previous
 * line followed by an open brace).
 */
export function detectImportBlock(prefix: string): ImportPattern | { kind: "none" } {
  const lines = prefix.split(/\r?\n/);
  // Walk backwards from the cursor line. The first non-trivial line
  // dictates the verdict.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Open import on this very line.
    if (/^import\b/.test(trimmed)) {
      const m = trimmed.match(/from\s+["']([^"']+)["']/);
      return { kind: "import", module: m?.[1] };
    }
    // Continuing an import that started earlier (an open brace
    // without a matching close yet).
    if (/^\{/.test(trimmed) || /^[A-Za-z_$,\s]+,\s*$/.test(trimmed)) {
      // Look one more line back.
      const prev = (lines[i - 1] ?? "").trim();
      if (/^import\b/.test(prev)) {
        const m = prev.match(/from\s+["']([^"']+)["']/);
        return { kind: "import", module: m?.[1] };
      }
    }
    // Any other content closes the chance — we're not in an import.
    return { kind: "none" };
  }
  return { kind: "none" };
}

// ──────────────────────────────────────────────────────────────────────
// detectFunctionBoundary
// ──────────────────────────────────────────────────────────────────────

/**
 * Distinguish "defining a function (signature)" from "inside a
 * function body". The two need very different completions — a
 * signature completion looks like parameter lists or return types,
 * while a body completion looks like statements.
 */
export function detectFunctionBoundary(
  prefix: string,
  _suffix: string,
): FunctionPattern {
  // Strict signature: the last meaningful token is the `function`
  // keyword, or a function name that hasn't yet hit `(`. We look at
  // just the last 80 chars to keep it cheap.
  const tail = prefix.slice(-160);
  const sigStart = /(function\s+[\w$]*\s*$|function\s*$|=>\s*$|=\s*\(\s*$)/m;
  if (sigStart.test(tail)) return { kind: "signature" };
  // Body: there's an unmatched `{` somewhere in the recent prefix.
  // Cheap approximation: count braces in the last 400 chars.
  const window = prefix.slice(-400);
  let depth = 0;
  for (const c of window) {
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  if (depth > 0) return { kind: "body" };
  return { kind: "none" };
}

// ──────────────────────────────────────────────────────────────────────
// detectNamingConvention
// ──────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "function",
  "const",
  "let",
  "var",
  "class",
  "interface",
  "type",
  "enum",
  "import",
  "export",
  "from",
  "as",
  "default",
  "new",
  "this",
  "super",
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "instanceof",
  "in",
  "of",
  "void",
  "yield",
  "async",
  "await",
  "throw",
  "try",
  "catch",
  "finally",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "extends",
  "implements",
  "any",
  "string",
  "number",
  "boolean",
  "object",
  "never",
  "unknown",
  "module",
  "namespace",
  "declare",
  "with",
  "yield",
  "let",
  "set",
  "get",
]);

export function detectIdentifiersInScope(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Strip strings / comments first so we don't pull identifiers out
  // of `"hello world"`.
  const stripped = text
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const m of stripped.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const id = m[0];
    if (id.length < 3) continue;
    if (KEYWORDS.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function detectNamingConvention(ids: string[]): NamingConvention {
  if (ids.length === 0) return "mixed";
  const tally: Record<NamingConvention, number> = {
    camelCase: 0,
    snake_case: 0,
    PascalCase: 0,
    SCREAMING_SNAKE: 0,
    "kebab-case": 0,
    mixed: 0,
  };
  for (const id of ids) {
    tally[classifyIdentifier(id)] += 1;
  }
  // Pick the convention with the most votes, BUT require a clear
  // plurality (>=50% of meaningful votes). Otherwise the set is
  // genuinely mixed and we shouldn't pretend.
  const meaningful: NamingConvention[] = [
    "camelCase",
    "snake_case",
    "PascalCase",
    "SCREAMING_SNAKE",
    "kebab-case",
  ];
  let best: NamingConvention = "mixed";
  let bestCount = 0;
  for (const k of meaningful) {
    if (tally[k] > bestCount) {
      best = k;
      bestCount = tally[k];
    }
  }
  if (bestCount * 2 < ids.length) return "mixed";
  return best;
}

function classifyIdentifier(id: string): NamingConvention {
  if (/^[A-Z][A-Z0-9_]*$/.test(id) && id.includes("_")) return "SCREAMING_SNAKE";
  if (/^[a-z][a-z0-9_]*$/.test(id) && id.includes("_")) return "snake_case";
  if (/^[a-z][a-z0-9-]*$/.test(id) && id.includes("-")) return "kebab-case";
  if (/^[A-Z][A-Za-z0-9]*$/.test(id)) return "PascalCase";
  if (/^[a-z][a-zA-Z0-9]*$/.test(id)) return "camelCase";
  return "mixed";
}

// ──────────────────────────────────────────────────────────────────────
// detectPattern — the umbrella
// ──────────────────────────────────────────────────────────────────────

/**
 * Run every detector and pick the strongest match. Order encodes our
 * confidence in each detector's signal:
 *
 *   import > list > function-body > function-signature > none
 *
 * Imports are very specific (the `import` keyword pins them down).
 * List patterns require two repetitions, so they're solid too.
 * Function-body / signature are the broadest signals so they rank
 * last.
 */
export function detectPattern(prefix: string, suffix: string): DetectedPattern {
  const imp = detectImportBlock(prefix);
  if (imp.kind === "import") return imp;
  const list = detectListContinuation(prefix);
  if (list.kind === "list") return list;
  const fn = detectFunctionBoundary(prefix, suffix);
  if (fn.kind !== "none") return fn;
  return { kind: "none" };
}
