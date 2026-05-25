// FIM (Fill-In-Middle) quality evaluator.
//
// Drives the live Ollama instance with the same prompt template the
// Rust backend uses for inline completions (see
// src-tauri/src/commands/ollama.rs::ollama_fim) and scores each
// completion against task-specific criteria.
//
// The bar: each scenario states a "win" condition. A run passes
// when ALL scenarios win on the first sample. If any miss, we
// surface what went wrong so the harness or prompt can be tuned.

import { generateRaw, runJsCases, checkJsSyntax, bar, emoji } from "./lib.mjs";

const FIM_STOP = [
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|endoftext|>",
  "<|file_sep|>",
  "<|im_end|>",
];

/** Compose the FIM prompt verbatim — same template as ollama_fim. */
function fimPrompt(prefix, suffix) {
  return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
}

/**
 * Mirror what the editor actually accepts as ghost text: the
 * completion up to a sensible statement boundary. We look for the
 * first `;` at end-of-line, or the first `\n}\n`, whichever comes
 * first. Beyond that boundary the model is hallucinating the NEXT
 * statement — the editor wouldn't display it.
 */
function truncateAtStatementEnd(completion) {
  // ; at end-of-line
  const semi = completion.search(/;[ \t]*(\n|$)/);
  // newline + closing brace at start-of-line
  const brace = completion.search(/\n\s*\}/);
  let cut = -1;
  if (semi !== -1 && brace !== -1) cut = Math.min(semi + 1, brace);
  else if (semi !== -1) cut = semi + 1;
  else if (brace !== -1) cut = brace;
  return cut === -1 ? completion : completion.slice(0, cut);
}

const scenarios = [
  {
    id: "function-body",
    description:
      "Complete a function body where the signature, comment, and partial chain make the intent unambiguous.",
    prefix: `// sumOfEvenSquares: given numbers, return the sum of the squares of the even ones.
export function sumOfEvenSquares(nums) {
  return nums
    .filter((n) => n % 2 === 0)
    .map((n) => n * n)
    .`,
    suffix: `;
}
`,
    // Real ghost-text completion shows the model's output up to the
    // *next* natural boundary (end of expression, end of line/stmt).
    // We mirror that: take only the chunk through the first `;` on a
    // line, splice into the prefix, and ignore whatever the model
    // hallucinated afterwards.
    async assess(completion) {
      const head = truncateAtStatementEnd(completion);
      const candidate = this.prefix + head + this.suffix;
      const syntax = checkJsSyntax(candidate);
      if (!syntax.ok) {
        return { pass: false, why: `syntax: ${syntax.error}`, head };
      }
      const tests = await runJsCases(candidate, "sumOfEvenSquares", [
        { args: [[]], expected: 0 },
        { args: [[1, 2, 3, 4]], expected: 4 + 16 },
        { args: [[2, 4, 6]], expected: 4 + 16 + 36 },
        { args: [[1, 3, 5]], expected: 0 },
      ]);
      if (!tests.ok) {
        return { pass: false, why: "behavioural test failed", detail: tests };
      }
      return { pass: true };
    },
  },
  {
    id: "object-literal-continuation",
    description:
      "Continue an object literal pattern. The model should add at least one more key:value pair consistent with the established shape.",
    prefix: `export const STATUS_MESSAGES = {
  ok: "operation succeeded",
  pending: "operation in flight",
  `,
    suffix: `
};
`,
    async assess(completion) {
      // Continuations may be one line or several; we accept any
      // completion that ALSO contains a key:"value" entry. We then
      // syntax-check the spliced result.
      const trimmed = completion.replace(/\n+$/, "");
      const candidate = this.prefix + trimmed + this.suffix;
      const syntax = checkJsSyntax(candidate);
      if (!syntax.ok) {
        return { pass: false, why: `syntax: ${syntax.error}` };
      }
      // At least one additional key:value pair. The model's
      // completion alone should match this — we accept double or
      // single-quoted strings.
      const ok = /[A-Za-z_]\w*\s*:\s*["'`][^"'`]+["'`]/.test(trimmed);
      if (!ok) {
        return {
          pass: false,
          why: "no key:value pair detected in the completion",
          completion: trimmed.slice(0, 200),
        };
      }
      return { pass: true };
    },
  },
  {
    id: "import-list-continuation",
    description:
      "Continue an import block. The model should add a sensible identifier that fits the pattern (any plausible React export works).",
    prefix: `import {
  useState,
  useEffect,
  `,
    suffix: `,
} from "react";
`,
    async assess(completion) {
      // Real ghost text shows whatever is offered on the cursor's
      // line. Take the first line, strip a trailing comma (which is
      // perfectly valid syntax for a partial import) and check
      // we got a bare React-y identifier — not a string, not a
      // duplicate, not a junk token.
      const firstLine = completion.split("\n")[0].trim().replace(/,$/, "");
      const isIdent = /^[A-Za-z_][\w]*$/.test(firstLine);
      if (!isIdent) {
        return {
          pass: false,
          why: "first line of completion isn't a bare identifier",
          got: firstLine.slice(0, 80),
        };
      }
      if (["useState", "useEffect"].includes(firstLine)) {
        return { pass: false, why: "duplicates an existing import", got: firstLine };
      }
      return { pass: true, ident: firstLine };
    },
  },
  {
    id: "cross-file-context",
    description:
      "With a <|file_sep|>-prefixed reference file exposing helper APIs, the model should use those exact identifiers in its completion (proves the enrichment we built reaches the model).",
    // The reference file is added BEFORE the local prefix using the
    // Qwen file separator — exactly what buildFimContext does in
    // production. The local prefix starts an import-aware call site
    // that should pull in `formatBytes` from the helper module.
    prefix: [
      "<|file_sep|>src/util/format.js",
      "export function formatBytes(n) {",
      "  if (n < 1024) return n + \" B\";",
      "  if (n < 1048576) return (n / 1024).toFixed(1) + \" KB\";",
      "  return (n / 1048576).toFixed(1) + \" MB\";",
      "}",
      "<|file_sep|>src/index.js",
      "import { formatBytes } from \"./util/format.js\";",
      "",
      "// renderSize: turn a byte count into a human-readable string.",
      "export function renderSize(bytes) {",
      "  return ",
    ].join("\n"),
    suffix: "\n}\n",
    async assess(completion) {
      const head = truncateAtStatementEnd(completion);
      // The model has to use `formatBytes` (the symbol we just
      // exposed via the reference file). Any completion that doesn't
      // is "didn't read the context" — exactly what we built the
      // enrichment to prevent.
      if (!/\bformatBytes\s*\(/.test(head)) {
        return {
          pass: false,
          why: "completion didn't use formatBytes from the reference file",
          head,
        };
      }
      // The spliced result must compile.
      const candidate = this.prefix + head + this.suffix;
      // Strip the <|file_sep|> framing for syntax checking — only
      // the actual JS body is being run.
      const jsBody = candidate.split("<|file_sep|>src/index.js\n")[1] ?? "";
      const syntax = checkJsSyntax(jsBody.replace(/^[\s\S]*?\nimport/, "import"));
      if (!syntax.ok) {
        return { pass: false, why: `syntax: ${syntax.error}`, head };
      }
      return { pass: true };
    },
  },
  {
    id: "switch-case-continuation",
    description:
      "Add one more case to a switch ladder. The model should continue the pattern with a new label and a matching body.",
    prefix: `function describeEvent(kind) {
  switch (kind) {
    case "open":
      return "opened";
    case "close":
      return "closed";
    case "error":
      return "errored";
    `,
    suffix: `
    default:
      return "unknown";
  }
}
`,
    async assess(completion) {
      // The model often emits one case label at a time. We accept
      // EITHER of:
      //   (a) the full `case "X":\n  return "Y";` pair, or
      //   (b) just `case "X":` — which is a legitimate single-step
      //       completion in a ghost-text UX (the user accepts, hits
      //       Enter, and another completion fires for the body).
      const trimmed = completion.replace(/\s+$/, "");
      const fullCase = /case\s+["'`][^"'`]+["'`]\s*:\s*\n\s*return\s+["'`][^"'`]+["'`]\s*;?/.test(
        trimmed,
      );
      const partialCase = /^\s*case\s+["'`][^"'`]+["'`]\s*:\s*$/.test(trimmed);
      if (!fullCase && !partialCase) {
        return {
          pass: false,
          why: "no case label found in completion",
          completion: trimmed.slice(0, 200),
        };
      }
      // For partial completions we don't syntax-check the spliced
      // file (a half-case isn't valid alone). For full completions
      // we do.
      if (fullCase) {
        const candidate = this.prefix + trimmed + this.suffix;
        const syntax = checkJsSyntax(candidate);
        if (!syntax.ok) {
          return { pass: false, why: `syntax: ${syntax.error}`, completion: trimmed };
        }
      }
      return { pass: true, mode: fullCase ? "full" : "partial" };
    },
  },
];

export async function runFim() {
  console.log(bar("FIM evaluator"));
  const results = [];
  for (const s of scenarios) {
    const prompt = fimPrompt(s.prefix, s.suffix);
    const t0 = Date.now();
    let completion = "";
    try {
      completion = await generateRaw({
        prompt,
        options: {
          // Match the live app: temperature 0.2, num_predict 96.
          // That's what ollama_fim.rs sends per keystroke.
          temperature: 0.2,
          num_predict: 96,
          stop: FIM_STOP,
        },
      });
    } catch (e) {
      results.push({ id: s.id, pass: false, why: `generate: ${e.message}` });
      console.log(`  ${emoji(false)}  ${s.id} — generate failed: ${e.message}`);
      continue;
    }
    const ms = Date.now() - t0;
    const verdict = await s.assess(completion);
    results.push({ id: s.id, ms, ...verdict, completionHead: completion.slice(0, 200) });
    const marker = emoji(verdict.pass);
    console.log(`  ${marker}  ${s.id}  (${ms}ms)`);
    if (!verdict.pass) {
      console.log(`         why: ${verdict.why}`);
      console.log(`         completion: ${JSON.stringify(completion.slice(0, 240))}`);
      if (verdict.detail) {
        console.log(`         detail: ${JSON.stringify(verdict.detail).slice(0, 240)}`);
      }
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFim().then((r) => {
    const passes = r.filter((x) => x.pass).length;
    console.log(`\nFIM total: ${passes}/${r.length} passed`);
    process.exit(passes === r.length ? 0 : 1);
  });
}
