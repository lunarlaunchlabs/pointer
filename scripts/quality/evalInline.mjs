// Inline edit (Cmd+K) quality evaluator.
//
// Drives the same code path as src/components/InlineEdit.tsx:
//   1. Compose the *exact* system prompt the editor sends, with
//      the active path + selection line numbers baked in.
//   2. Compose the user message in the same shape buildInlineEditContext
//      produces — selection + surrounding code + (optional) diagnostics
//      + an "Instruction: ..." trailer.
//   3. Send to the live model.
//   4. Parse the single SEARCH/REPLACE hunk.
//   5. Apply it to the fixture file and run behavioural tests.
//
// Each scenario sets a "win" condition. We score by behaviour, not
// by string-matching — there are many right answers for any given
// edit, and we want to reward correctness, not stylistic conformity.

import {
  chat,
  parseSearchReplace,
  applyHunks,
  checkJsSyntax,
  runJsCases,
  bar,
  emoji,
} from "./lib.mjs";

function inlineSystem({ path: filePath, startLine, endLine }) {
  return `You are Pointer's inline editor. The user has selected lines ${startLine}-${endLine} of file ${filePath}. Respond with EXACTLY ONE search/replace block using this format and nothing else:

<<<<<<< SEARCH ${filePath}
...exact selection text...
=======
...your replacement...
>>>>>>> REPLACE

Preserve indentation. Honour the surrounding style (naming, imports,
type usage). Do not include backticks or commentary.`;
}

/**
 * Compose a userMessage roughly matching buildInlineEditContext —
 * the real implementation lives in src/lib/inlineEditContext.ts and
 * gets its own unit tests; here we shape the *prompt the model sees*
 * the same way.
 */
function inlineUserMessage({
  filePath,
  fileContent,
  selection,
  diagnostics = [],
  instruction,
}) {
  const lines = fileContent.split("\n");
  const before = lines.slice(Math.max(0, selection.startLine - 1 - 8), selection.startLine - 1).join("\n");
  const after = lines.slice(selection.endLine, Math.min(lines.length, selection.endLine + 8)).join("\n");
  const diagBlock = diagnostics.length
    ? "\n\n## diagnostics overlapping the selection\n" +
      diagnostics
        .map((d) => `- line ${d.line} [${d.severity}]: ${d.message}`)
        .join("\n")
    : "";
  return `## file
path: ${filePath}

## before (surrounding context, do not modify)
${before}

## selection (lines ${selection.startLine}-${selection.endLine}) — patch this exactly
${selection.text}

## after (surrounding context, do not modify)
${after}${diagBlock}

Instruction: ${instruction}`;
}

const scenarios = [
  {
    id: "fix-off-by-one",
    description:
      "Patch a single buggy line in the middle of a function. The SEARCH block must match the selection verbatim and the replacement must fix the bug.",
    filePath: "src/util.js",
    fileContent:
      [
        "export function takeFirst(arr, n) {",
        "  if (n <= 0) return [];",
        "  const out = [];",
        "  for (let i = 0; i <= n; i++) {",
        "    out.push(arr[i]);",
        "  }",
        "  return out;",
        "}",
      ].join("\n") + "\n",
    selection: {
      startLine: 4,
      endLine: 4,
      text: "  for (let i = 0; i <= n; i++) {",
    },
    instruction:
      "Fix the off-by-one — this loop should iterate exactly n times, not n+1.",
    fnName: "takeFirst",
    cases: [
      { args: [[1, 2, 3, 4], 2], expected: [1, 2] },
      { args: [[1, 2, 3, 4], 0], expected: [] },
      { args: [["a", "b", "c"], 3], expected: ["a", "b", "c"] },
    ],
  },
  {
    id: "rewrite-implementation",
    description:
      "Rewrite the entire selected function body to use a different algorithm. The replacement must be semantically equivalent.",
    filePath: "src/factorial.js",
    fileContent:
      [
        "// Computes n! for non-negative integers.",
        "export function factorial(n) {",
        "  if (n < 0) throw new RangeError('n must be >= 0');",
        "  let acc = 1;",
        "  for (let i = 2; i <= n; i++) acc *= i;",
        "  return acc;",
        "}",
      ].join("\n") + "\n",
    selection: {
      startLine: 4,
      endLine: 6,
      text: "  let acc = 1;\n  for (let i = 2; i <= n; i++) acc *= i;\n  return acc;",
    },
    instruction:
      "Rewrite this body to use recursion instead of a loop. Don't change the function name or signature.",
    fnName: "factorial",
    cases: [
      { args: [0], expected: 1 },
      { args: [1], expected: 1 },
      { args: [5], expected: 120 },
      { args: [7], expected: 5040 },
    ],
  },
  {
    id: "fix-diagnostic",
    description:
      "An overlapping diagnostic is shown to the model. The patch must resolve the lint message while keeping the function's behaviour intact.",
    filePath: "src/numeric.js",
    fileContent:
      [
        "export function isEven(n) {",
        "  return n % 2 == 0;",
        "}",
      ].join("\n") + "\n",
    selection: {
      startLine: 2,
      endLine: 2,
      text: "  return n % 2 == 0;",
    },
    diagnostics: [
      {
        line: 2,
        message:
          "Use '===' (strict equality) instead of '==' to avoid type coercion.",
        severity: "warning",
      },
    ],
    instruction: "Resolve the lint.",
    fnName: "isEven",
    cases: [
      { args: [0], expected: true },
      { args: [1], expected: false },
      { args: [4], expected: true },
      { args: [-2], expected: true },
    ],
  },
];

async function assess(scenario, response) {
  const hunks = parseSearchReplace(response);
  if (hunks.length === 0) {
    return {
      pass: false,
      why: "no SEARCH/REPLACE block in response",
      head: response.slice(0, 280),
    };
  }
  // The inline editor always emits one hunk; if there are several
  // we apply them all (best-effort) to be lenient.
  const relevant = hunks.filter(
    (h) => !h.path || h.path === scenario.filePath,
  );
  if (!relevant.length) {
    return { pass: false, why: "no hunks target the selection's file", pathsSeen: hunks.map((h) => h.path) };
  }
  const { text: patched, applied } = applyHunks(scenario.fileContent, relevant);
  if (applied === 0) {
    return {
      pass: false,
      why: "SEARCH didn't match selection verbatim",
      head: response.slice(0, 280),
    };
  }
  const syntax = checkJsSyntax(patched);
  if (!syntax.ok) return { pass: false, why: `syntax: ${syntax.error}`, patched };
  const tests = await runJsCases(patched, scenario.fnName, scenario.cases);
  if (!tests.ok) return { pass: false, why: "behavioural tests failed", detail: tests, patched };
  return { pass: true };
}

export async function runInline() {
  console.log(bar("Inline edit (Cmd+K) evaluator"));
  const results = [];
  for (const s of scenarios) {
    const t0 = Date.now();
    let response = "";
    try {
      response = await chat({
        system: inlineSystem({ path: s.filePath, startLine: s.selection.startLine, endLine: s.selection.endLine }),
        messages: [
          {
            role: "user",
            content: inlineUserMessage({
              filePath: s.filePath,
              fileContent: s.fileContent,
              selection: s.selection,
              diagnostics: s.diagnostics ?? [],
              instruction: s.instruction,
            }),
          },
        ],
        options: { temperature: 0.2, num_predict: 800 },
      });
    } catch (e) {
      results.push({ id: s.id, pass: false, why: `chat: ${e.message}` });
      console.log(`  ${emoji(false)}  ${s.id} — chat failed: ${e.message}`);
      continue;
    }
    const ms = Date.now() - t0;
    const v = await assess(s, response);
    results.push({ id: s.id, ms, ...v });
    const marker = emoji(v.pass);
    console.log(`  ${marker}  ${s.id}  (${ms}ms)`);
    if (!v.pass) {
      console.log(`         why: ${v.why}`);
      console.log(`         response head: ${JSON.stringify(response.slice(0, 320))}`);
      if (v.detail) {
        console.log(`         detail: ${JSON.stringify(v.detail).slice(0, 240)}`);
      }
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runInline().then((r) => {
    const passes = r.filter((x) => x.pass).length;
    console.log(`\nInline total: ${passes}/${r.length} passed`);
    process.exit(passes === r.length ? 0 : 1);
  });
}
