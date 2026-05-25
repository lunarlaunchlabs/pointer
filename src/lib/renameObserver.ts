/**
 * Observe a "before / after" pair of file contents and decide whether
 * the user just performed a clean rename. Used by the refactor
 * watcher: when a rename is detected, the IDE proactively offers to
 * apply it across the rest of the workspace.
 *
 * The observer is intentionally strict — we'd rather miss a rename
 * than wrongly suggest one. A wrongful suggestion ("rename `foo` to
 * `bar` in 27 places?") risks data loss if accepted, so the
 * detection threshold is high:
 *
 *   1. Identifier-only change: every non-identifier difference must
 *      survive an identifier-strip pass identically. Whitespace
 *      reformatting alone doesn't count.
 *   2. Exactly one identifier was substituted everywhere it
 *      previously appeared.
 *   3. The old name is *gone* from the file — partial renames in
 *      progress shouldn't fire.
 *   4. Both names are length >= 4 and aren't reserved keywords.
 *
 * Algorithm:
 *
 *   • Tokenize both versions into an identifier *bag* (path-
 *     independent count of how many times each identifier appears),
 *     ignoring string / comment text and keywords.
 *   • Compute the symmetric difference. A rename produces exactly
 *     one identifier that vanished and one that appeared, with the
 *     same count. Anything else (different counts, multiple changes)
 *     means it's not a clean rename.
 *   • Also normalise both versions through "identifier-stripping"
 *     (replace each identifier with `IDENT`). The stripped versions
 *     must be identical — that rules out cases like additions /
 *     deletions / reorderings that happened to add and drop one
 *     identifier each.
 */

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
  "module",
  "namespace",
  "declare",
  "with",
  "set",
  "get",
  "Symbol",
  "Promise",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
]);

const MIN_NAME_LEN = 4;

export type RenameObservation =
  | {
      kind: "rename";
      oldName: string;
      newName: string;
      /** Number of times the new name appears in the after-text.
       *  Equal to the number of times oldName appeared in before. */
      occurrencesInFile: number;
    }
  | { kind: "none" };

export function observeRename(
  before: string,
  after: string,
): RenameObservation {
  if (before === after) return { kind: "none" };
  // 1. Strip strings and comments so we don't fire on "hello" -> "hi"
  //    string edits.
  const beforeCode = stripStringsAndComments(before);
  const afterCode = stripStringsAndComments(after);
  if (beforeCode === afterCode) {
    // Only string / comment content changed → not a rename.
    return { kind: "none" };
  }
  // 2. Build identifier multisets.
  const bagBefore = identifierBag(beforeCode);
  const bagAfter = identifierBag(afterCode);
  // 3. Find the symmetric difference.
  const removed: Array<[string, number]> = [];
  const added: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const [id, count] of bagBefore) {
    seen.add(id);
    const next = bagAfter.get(id) ?? 0;
    if (next < count) removed.push([id, count - next]);
    else if (next > count) added.push([id, next - count]);
  }
  for (const [id, count] of bagAfter) {
    if (seen.has(id)) continue;
    added.push([id, count]);
  }
  // Exactly one identifier added, one removed, same count.
  if (removed.length !== 1 || added.length !== 1) return { kind: "none" };
  const [oldName, removedCount] = removed[0];
  const [newName, addedCount] = added[0];
  if (removedCount !== addedCount) return { kind: "none" };
  // 4. Both names long enough and not keywords.
  if (oldName.length < MIN_NAME_LEN || newName.length < MIN_NAME_LEN)
    return { kind: "none" };
  if (KEYWORDS.has(oldName) || KEYWORDS.has(newName))
    return { kind: "none" };
  // 5. The old name must be GONE from the file. Partial renames in
  //    progress are filtered out — those will still fire when the
  //    user finishes.
  if ((bagAfter.get(oldName) ?? 0) > 0) return { kind: "none" };
  // 6. Identifier-stripped versions must match. Catches "deleted one
  //    line, added another that happens to share counts".
  if (
    stripIdentifiers(beforeCode, oldName, newName) !==
    stripIdentifiers(afterCode, oldName, newName)
  ) {
    return { kind: "none" };
  }
  return {
    kind: "rename",
    oldName,
    newName,
    occurrencesInFile: addedCount,
  };
}

/** Remove string literals and comments — replaced by single-character
 *  placeholders so positions don't shift dramatically. */
function stripStringsAndComments(src: string): string {
  return src
    .replace(/"(?:\\.|[^"\\])*"/g, '"S"')
    .replace(/'(?:\\.|[^'\\])*'/g, "'S'")
    .replace(/`(?:\\.|[^`\\])*`/g, "`S`")
    .replace(/\/\*[\s\S]*?\*\//g, "/*C*/")
    .replace(/\/\/[^\n]*/g, "//C");
}

/** Build a multiset of identifier -> count from a code blob. */
function identifierBag(src: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const id = m[0];
    if (KEYWORDS.has(id)) continue;
    bag.set(id, (bag.get(id) ?? 0) + 1);
  }
  return bag;
}

/**
 * Map every identifier to a single canonical token so that two
 * versions differing ONLY by a clean rename normalise to the same
 * string. We collapse both the old and new names to the same
 * marker, then any other identifier to its own marker (its own
 * literal text — we do this so adding a new identifier still
 * changes the result).
 */
function stripIdentifiers(
  src: string,
  oldName: string,
  newName: string,
): string {
  return src.replace(/\b[A-Za-z_$][\w$]*\b/g, (id) => {
    if (id === oldName || id === newName) return "RENAMED";
    return id; // unchanged — same identifier in both versions
  });
}
