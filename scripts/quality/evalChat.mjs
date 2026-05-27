// Chat-surface quality evaluator.
//
// Replicates both Pointer chat paths:
//   A. Legacy patch-producing chat, where responses must contain
//      SEARCH/REPLACE or <file> blocks.
//   B. Unified Assistant Ask mode, where responses must be prose
//      answers only: no edits, no tool tags, no shell commands.
//
// Patch path:
//   1. Send our actual `chatSystemPrompt(context)` as the system msg.
//   2. Send a user task referencing a fixture file's path/contents.
//   3. Receive a streamed response.
//   4. Extract SEARCH/REPLACE hunks AND <file path="…"> create blocks.
//   5. Apply them to the fixture, syntax-check, and run behavioural
//      tests against the result.
//
// A scenario passes only when the model produces a correctly-
// formatted patch that ALSO solves the task. Everything else is a
// quality problem: malformed block, search not found, wrong logic.

import {
  chat,
  parseSearchReplace,
  parseFileBlocks,
  applyHunks,
  checkJsSyntax,
  runJsCases,
  bar,
  emoji,
} from "./lib.mjs";

// The exact system prompt our store ships, kept verbatim so we're
// not testing some idealised version. Mirror of chatSystemPrompt in
// src/store/chat.ts — if you change one, change the other.
function chatSystem(context) {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

BEFORE WRITING CODE, think briefly (silently) about:
  - what's the smallest patch that satisfies the request,
  - which edge cases (empty inputs, invalid arguments, ordering of
    checks) the user cares about,
  - whether new guards must run BEFORE existing returns to actually
    fire — placing them last makes them unreachable.
Then produce a single, self-consistent edit.

OUTPUT FORMAT FOR CODE CHANGES — these are the ONLY shapes Pointer's
parser accepts. Anything else is silently dropped, so the user sees
nothing happen. Treat this as a hard contract.

1. EDIT an existing file. Required when modifying a file the user
   already has. The SEARCH block MUST match the file byte-for-byte
   (whitespace, indentation, line endings included), and the path is
   REQUIRED on the SAME line as the word SEARCH.

   <<<<<<< SEARCH path/to/file
   ...exact existing text...
   =======
   ...replacement text...
   >>>>>>> REPLACE

2. CREATE a new file. Use either an empty-SEARCH SEARCH/REPLACE block,
   OR a <file> tag — both go through the same code path.

   <<<<<<< SEARCH path/to/new_file
   =======
   ENTIRE FILE CONTENTS HERE
   >>>>>>> REPLACE

   <file path="path/to/new_file">
   ENTIRE FILE CONTENTS HERE
   </file>

HARD RULES

- NEVER reply with the full updated file inside a triple-backtick
  fence ( \`\`\`lang path \`\`\` ). The parser ignores fenced blocks;
  the user sees no change. If you only want to change a few lines, use
  a SEARCH/REPLACE block targeting JUST those lines. If you really do
  need to rewrite the whole file, use the create-file form above.
- NEVER include narration INSIDE the SEARCH/REPLACE markers. Put
  prose explanations BEFORE or AFTER the block, never between the
  markers.
- Match the workspace's existing module system, language, naming, and
  import style. If the workspace context below shows ESM
  ("type": "module"), use \`export\`/\`import\`. If it shows CommonJS,
  use \`module.exports\`/\`require\`. Never mix the two.
- Paths are relative to the workspace root unless absolute. Use forward
  slashes. Always include the path on every edit/create block.

${context ? "User-provided context follows.\n\n" + context : ""}`;
}

function askSystem(brief) {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

You are in ASK mode — answer questions and explain code. Do NOT
emit edit blocks, tool tags, shell commands, or triple-backtick code
fences. If the user asks you to change code, do not provide a patch or
replacement implementation in Ask mode; briefly tell them to switch to
Plan mode for an implementation plan or Agent mode to apply the edit.

ASK MODE OUTPUT CONTRACT:
- Prose only. The literal string \`\`\` is forbidden.
- Inline code spans like \`profile.name\` are OK; multi-line code examples are not.
- If the context includes a <file> block for a named file, answer from that
  file. Do not claim you lack access to it.
- For "tell me about <file>" style questions, answer with the file's purpose,
  important imports/exports, state or data flow, and any notable risks or
  neighboring files worth checking. Prefer a tight, skimmable explanation.
- When explaining core framework/runtime files, name concrete configuration
  defaults, compatibility hooks, and routing/middleware paths visible in the
  file instead of smoothing them into generic summaries.
- Name important top-level functions and methods by their literal identifiers
  (for example \`app.handle\`, \`app.use\`, \`defaultConfiguration\`) when they
  are central to the file.
- Do not compress literal setting names into "configuration"; if keys such as
  \`trust proxy\`, \`etag\`, or \`query parser\` appear in the file, name them.
- For direct edit requests ("change this file", "fix this", "add X"),
  your ENTIRE response must be exactly:
  "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first."
  Do not show the changed code. Do not explain the change.

${
  brief && brief.trim().length
    ? "Workspace brief — a compact snapshot of the project the user has open. Use it for orientation; if you need more, ask.\n\n" +
      brief +
      "\n"
    : ""
}`;
}

// Helper — render a file as the editor would inject it into chat
// context: a labelled markdown fence.
function fenced(filePath, contents, lang = "javascript") {
  return "```" + lang + " " + filePath + "\n" + contents + "\n```";
}

// Inject a workspace summary the way buildContext.ts would — a few
// "facts about this workspace" the chat model needs to pick the
// right style (module system, formatter, language).
function workspaceSummary({ moduleSystem }) {
  return [
    "## workspace summary",
    "- root: /tmp/pointer-quality-fixture",
    `- module system: ${moduleSystem} (matches package.json "type")`,
    "- target: node 22",
    "",
  ].join("\n");
}

const scenarios = [
  {
    id: "edit-existing-fix-bug",
    description:
      "Patch a bug in an existing file. The model must emit a SEARCH/REPLACE block whose SEARCH matches the file verbatim, and the resulting code must pass behavioural tests.",
    fixturePath: "src/sum.js",
    fixture: `export function sum(nums) {
  // BUG: starts at 1, should start at 0.
  let total = 1;
  for (const n of nums) total += n;
  return total;
}
`,
    userTask:
      "There's a bug in sum.js — calling sum([]) returns 1 instead of 0. Fix it.",
    fnName: "sum",
    cases: [
      { args: [[]], expected: 0 },
      { args: [[1, 2, 3]], expected: 6 },
      { args: [[5]], expected: 5 },
    ],
  },
  {
    id: "edit-existing-add-feature",
    description:
      "Extend a function with a new branch. Must produce one or more apply-able SEARCH/REPLACE blocks AND pass behavioural tests.",
    fixturePath: "src/clamp.js",
    fixture: `export function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
`,
    userTask:
      "Update clamp.js so that when `lo > hi` it throws a RangeError with the message 'clamp: lo > hi'. Keep all existing behaviour.",
    fnName: "clamp",
    cases: [
      { args: [5, 0, 10], expected: 5 },
      { args: [-1, 0, 10], expected: 0 },
      { args: [11, 0, 10], expected: 10 },
      {
        args: [0, 5, 1],
        expectedThrows: /clamp:\s*lo\s*>\s*hi/,
      },
    ],
  },
  {
    id: "edit-existing-preserve-edge-order",
    description:
      "Add validation to an existing function without making it unreachable behind an earlier return.",
    fixturePath: "src/pageSize.js",
    fixture: `export function pageSize(input) {
  if (input == null || input === "") return 25;
  const n = Number(input);
  if (!Number.isFinite(n)) return 25;
  return Math.min(100, Math.max(1, Math.floor(n)));
}
`,
    userTask:
      "Update pageSize.js so negative numbers and zero throw RangeError('pageSize must be positive') instead of being clamped to 1. Keep null, empty string, and non-numeric inputs defaulting to 25.",
    fnName: "pageSize",
    cases: [
      { args: [null], expected: 25 },
      { args: [""], expected: 25 },
      { args: ["abc"], expected: 25 },
      { args: [101], expected: 100 },
      { args: [10.9], expected: 10 },
      { args: [0], expectedThrows: /pageSize must be positive/ },
      { args: [-2], expectedThrows: /pageSize must be positive/ },
    ],
  },
  {
    id: "edit-existing-normalize-collection",
    description:
      "Implement a realistic data-cleanup change while preserving order and filtering invalid entries.",
    fixturePath: "src/tags.js",
    fixture: `export function normalizeTags(tags) {
  return tags.map((tag) => tag.toLowerCase());
}
`,
    userTask:
      "Make normalizeTags trim whitespace, lowercase each tag, remove empty tags, and de-duplicate while preserving first-seen order.",
    fnName: "normalizeTags",
    cases: [
      { args: [[" Foo ", "foo", "", "BAR", " bar "]], expected: ["foo", "bar"] },
      { args: [["One", "Two", "one"]], expected: ["one", "two"] },
      { args: [[]], expected: [] },
    ],
  },
  {
    id: "create-new-file",
    description:
      "Generate a brand-new utility file. Must use either an empty-SEARCH block or a <file> block — both are accepted by Pointer's parser.",
    fixturePath: null,
    fixture: "",
    userTask:
      "Create src/util/uniq.js exporting a function `uniq(arr)` that returns a new array with duplicates removed, preserving first-seen order.",
    expectedNewPath: "src/util/uniq.js",
    fnName: "uniq",
    cases: [
      { args: [[]], expected: [] },
      { args: [[1, 1, 2, 3, 2]], expected: [1, 2, 3] },
      { args: [["a", "b", "a"]], expected: ["a", "b"] },
    ],
  },
];

const askScenarios = [
  {
    id: "ask-implicit-file-context-app-jsx",
    context:
      workspaceSummary({ moduleSystem: "ESM" }) +
      "\n\nImplicitly attached file:\n" +
      `<file path="src/App.jsx">
\`\`\`jsx
import { useState } from "react";
import Header from "./components/Header.jsx";
import Counter from "./components/Counter.jsx";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <Header title="Pointer Demo" />
      <Counter value={count} onIncrement={() => setCount((n) => n + 1)} />
    </main>
  );
}
\`\`\`
</file>`,
    userTask: "Tell me about App.jsx",
    expect: [/App\.jsx|App/i, /Header/i, /Counter/i, /useState|state|count/i],
    reject: [/do(?:n't| not) have access/i, /share (?:the )?contents/i],
  },
  {
    id: "ask-explain-cache-bug",
    context:
      workspaceSummary({ moduleSystem: "ESM" }) +
      "\n\nCurrently open file:\n" +
      fenced(
        "src/cache.js",
        `const cache = new Map();

export async function getUser(id, loadUser) {
  if (!cache.has(id)) {
    cache.set(id, loadUser(id));
  }
  return cache.get(id);
}
`,
      ),
    userTask:
      "Explain why concurrent calls to getUser with the same id only invoke loadUser once. Don't change the code.",
    expect: [/cache/i, /same\s+`?id`?/i, /promise|loadUser\(id\)/i, /once|single/i],
  },
  {
    id: "ask-diagnose-stacktrace",
    context:
      workspaceSummary({ moduleSystem: "ESM" }) +
      "\n\nCurrently open file:\n" +
      fenced(
        "src/profile.js",
        `export function displayName(user) {
  return user.profile.name.trim();
}
`,
      ),
    userTask:
      "I get TypeError: Cannot read properties of undefined (reading 'name') from displayName. What is likely wrong and what should I check first? Don't edit anything.",
    expect: [/profile/i, /undefined|missing/i, /check|valid|guard|optional|validate/i],
  },
  {
    id: "ask-does-not-edit-on-change-request",
    context:
      workspaceSummary({ moduleSystem: "ESM" }) +
      "\n\nCurrently open file:\n" +
      fenced(
        "src/double.js",
        `export function double(x) {
  return x + x;
}
`,
      ),
    userTask:
      "Change double.js to return x * 2 instead.",
    expect: [/Plan|Agent|switch/i, /change|edit/i],
  },
];

/**
 * Score a chat response against a scenario. Mirrors what the editor
 * actually does: parse blocks → apply → syntax-check → run tests.
 */
async function assess(scenario, response) {
  const hunks = parseSearchReplace(response);
  const newFiles = parseFileBlocks(response);

  if (hunks.length === 0 && newFiles.length === 0) {
    return {
      pass: false,
      why: "no SEARCH/REPLACE or <file> blocks found",
      head: response.slice(0, 400),
    };
  }

  // CREATE scenarios: the response must include either an empty-SEARCH
  // block at the right path, or a <file path="…"> block at that path.
  if (scenario.fixturePath === null) {
    let createdContent = null;
    for (const f of newFiles) {
      if (f.path === scenario.expectedNewPath) {
        createdContent = f.content;
        break;
      }
    }
    if (createdContent === null) {
      for (const h of hunks) {
        if (h.path === scenario.expectedNewPath && !h.search.trim()) {
          createdContent = h.replace;
          break;
        }
      }
    }
    if (createdContent === null) {
      return {
        pass: false,
        why: `no create-block found for ${scenario.expectedNewPath}`,
        hunksSeen: hunks.map((h) => ({ path: h.path, hasSearch: h.search.length > 0 })),
        newFilesSeen: newFiles.map((f) => f.path),
      };
    }
    const syntax = checkJsSyntax(createdContent);
    if (!syntax.ok) {
      return { pass: false, why: `syntax: ${syntax.error}`, createdContent };
    }
    const tests = await runJsCases(createdContent, scenario.fnName, scenario.cases);
    if (!tests.ok) {
      return { pass: false, why: "behavioural test failed", detail: tests };
    }
    return { pass: true };
  }

  // EDIT scenarios: find hunks (incl. <file> create-blocks) that
  // target the fixture path. We follow Sidebar.tsx's semantics — if
  // there's a create-style hunk for this path, the whole file gets
  // overwritten with that hunk's body; otherwise we apply
  // SEARCH/REPLACE hunks normally.
  const fixtureHunks = hunks.filter(
    (h) =>
      h.path === scenario.fixturePath || h.path === null || h.path === undefined,
  );
  // Also accept <file> create-blocks parsed earlier (newFiles).
  for (const f of newFiles) {
    if (f.path === scenario.fixturePath) {
      fixtureHunks.push({ path: f.path, search: "", replace: f.content });
    }
  }
  if (fixtureHunks.length === 0) {
    return {
      pass: false,
      why: `no hunks target ${scenario.fixturePath}`,
      pathsSeen: hunks.map((h) => h.path),
    };
  }
  const overwrite = fixtureHunks.find((h) => h.search.trim() === "");
  let patched;
  let applied;
  let missed;
  if (overwrite) {
    // Full-file overwrite path — Sidebar.tsx treats empty-SEARCH
    // hunks at an existing path as "rewrite this file from scratch".
    // We mirror that here so a model that emits a fenced full-file
    // block (a common drift mode for small 7B models) still gets
    // scored on the resulting code instead of being dropped.
    patched = overwrite.replace;
    applied = 1;
    missed = [];
  } else {
    const r = applyHunks(scenario.fixture, fixtureHunks);
    patched = r.text;
    applied = r.applied;
    missed = r.missed;
  }
  if (applied === 0) {
    return {
      pass: false,
      why: "no SEARCH block matched the fixture verbatim",
      missed,
      firstSearch: fixtureHunks[0]?.search?.slice(0, 200),
    };
  }
  const syntax = checkJsSyntax(patched);
  if (!syntax.ok) {
    return { pass: false, why: `syntax: ${syntax.error}`, patched };
  }
  // Behavioural tests — handle both expected-value and expected-throw cases.
  const tests = await runJsCases(patched, scenario.fnName, scenario.cases.map((c) => ({
    args: c.args,
    expected: c.expected ?? "__THROW__",
  })));
  // Validate throw expectations separately.
  for (let i = 0; i < scenario.cases.length; i++) {
    const c = scenario.cases[i];
    const r = tests.results?.[i];
    if (c.expectedThrows) {
      if (!r?.error) {
        return {
          pass: false,
          why: `case ${i} expected throw, got value ${JSON.stringify(r?.got)}`,
        };
      }
      if (!c.expectedThrows.test(r.error)) {
        return {
          pass: false,
          why: `case ${i} threw '${r.error}' which doesn't match ${c.expectedThrows}`,
        };
      }
    }
  }
  // Non-throwing cases must all pass.
  const valuedFailed = scenario.cases.some((c, i) => {
    if (c.expectedThrows) return false;
    const r = tests.results?.[i];
    return !r?.pass;
  });
  if (valuedFailed) {
    return { pass: false, why: "value-test mismatch", detail: tests };
  }
  return { pass: true };
}

export async function runChat() {
  console.log(bar("Chat evaluator"));
  const results = [];
  for (const s of scenarios) {
    const t0 = Date.now();
    const summary = workspaceSummary({ moduleSystem: "ESM" });
    const ctx = s.fixturePath
      ? `${summary}\n\nCurrently open file:\n${fenced(s.fixturePath, s.fixture)}`
      : summary;
    let response = "";
    try {
      response = await chat({
        system: chatSystem(ctx),
        messages: [{ role: "user", content: s.userTask }],
        options: { temperature: 0.2, num_predict: 1500 },
      });
      } catch (e) {
      results.push({ id: s.id, pass: false, why: `chat: ${e.message}` });
      console.log(`  ${emoji(false)}  ${s.id} — chat failed: ${e.message}`);
      continue;
    }
    // NOTE: temperature 0.2 mirrors src/store/chat.ts (post-tuning).
    const ms = Date.now() - t0;
    const v = await assess(s, response);
    results.push({ id: s.id, ms, ...v, responseHead: response.slice(0, 240) });
    const marker = emoji(v.pass);
    console.log(`  ${marker}  ${s.id}  (${ms}ms)`);
    if (!v.pass) {
      console.log(`         why: ${v.why}`);
      console.log(`         response head: ${JSON.stringify(response.slice(0, 360))}`);
      if (v.detail) {
        console.log(`         detail: ${JSON.stringify(v.detail).slice(0, 360)}`);
      }
      if (v.missed) {
        console.log(`         missed: ${JSON.stringify(v.missed).slice(0, 360)}`);
      }
      if (v.firstSearch) {
        console.log(`         firstSearch: ${JSON.stringify(v.firstSearch)}`);
      }
      if (v.pathsSeen) {
        console.log(`         pathsSeen: ${JSON.stringify(v.pathsSeen)}`);
      }
    }
  }
  for (const s of askScenarios) {
    const t0 = Date.now();
    let response = "";
    try {
      response = await chat({
        system: askSystem(workspaceSummary({ moduleSystem: "ESM" })),
        messages: [{ role: "user", content: `${s.context}\n\n${s.userTask}` }],
        options: { temperature: 0.2, num_predict: 800 },
      });
    } catch (e) {
      results.push({ id: s.id, pass: false, why: `chat: ${e.message}` });
      console.log(`  ${emoji(false)}  ${s.id} — chat failed: ${e.message}`);
      continue;
    }
    const ms = Date.now() - t0;
    const v = assessAsk(s, response);
    results.push({ id: s.id, ms, ...v, responseHead: response.slice(0, 240) });
    const marker = emoji(v.pass);
    console.log(`  ${marker}  ${s.id}  (${ms}ms)`);
    if (!v.pass) {
      console.log(`         why: ${v.why}`);
      console.log(`         response head: ${JSON.stringify(response.slice(0, 360))}`);
    }
  }
  return results;
}

function assessAsk(s, response) {
  const forbidden = [
    "<<<<<<< SEARCH",
    ">>>>>>> REPLACE",
    "<read_file",
    "<apply_diff",
    "<write_file",
    "<run_shell",
    "```",
  ];
  const hit = forbidden.find((needle) => response.includes(needle));
  if (hit) {
    return { pass: false, why: `Ask mode emitted forbidden edit/tool syntax: ${hit}` };
  }
  for (const needle of s.expect) {
    if (!needle.test(response)) {
      return { pass: false, why: `answer missing ${needle}` };
    }
  }
  for (const needle of s.reject ?? []) {
    if (needle.test(response)) {
      return { pass: false, why: `answer contained rejected phrase ${needle}` };
    }
  }
  return { pass: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runChat().then((r) => {
    const passes = r.filter((x) => x.pass).length;
    console.log(`\nChat total: ${passes}/${r.length} passed`);
    process.exit(passes === r.length ? 0 : 1);
  });
}
