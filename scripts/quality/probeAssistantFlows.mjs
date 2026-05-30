#!/usr/bin/env node
// Targeted Assistant-flow probe.
//
// This is intentionally more verbose than `npm run eval`: it prints the
// model's actual responses for the regressions we care about while still
// failing the process when a response violates the contract.

import { chat, MODEL, bar } from "./lib.mjs";

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

function workspaceSummary() {
  return [
    "## workspace summary",
    "- root: /tmp/pointer-quality-fixture",
    '- module system: ESM (matches package.json "type")',
    "- target: node 22",
    "",
  ].join("\n");
}

function appJsxContext() {
  return `${workspaceSummary()}

Implicitly attached file:
<file path="src/App.jsx">
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
</file>`;
}

function assertMatches(label, response, required, rejected = []) {
  const failures = [];
  for (const re of required) {
    if (!re.test(response)) failures.push(`missing ${re}`);
  }
  for (const re of rejected) {
    if (re.test(response)) failures.push(`rejected phrase ${re}`);
  }
  if (failures.length) {
    throw new Error(`${label}: ${failures.join("; ")}\nResponse:\n${response}`);
  }
}

function extractPlan(trace) {
  const plans = [];
  for (const t of trace) {
    const text = t.sanitized ?? t.response ?? "";
    for (const m of text.matchAll(/<plan>([\s\S]*?)<\/plan>/g)) {
      if (m[1]?.trim()) plans.push(m[1].trim());
    }
  }
  return plans.at(-1) ?? "";
}

function extractFinal(trace) {
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const final = trace[i].final;
    if (final?.trim()) return final.trim();
    const text = trace[i].sanitized ?? trace[i].response ?? "";
    const m = /<final>([\s\S]*?)<\/final>/.exec(text);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return "";
}

function toolPath(trace) {
  return trace
    .filter((t) => t.call)
    .map((t) => `${t.call.tool}${t.call.attrs?.path ? `:${t.call.attrs.path}` : ""}`)
    .join(" -> ");
}

async function runAskProbe() {
  const response = await chat({
    system: askSystem(workspaceSummary()),
    messages: [
      {
        role: "user",
        content: `${appJsxContext()}\n\nTell me about App.jsx`,
      },
    ],
    options: { temperature: 0.2, num_predict: 800 },
  });
  assertMatches(
    "Ask implicit App.jsx context",
    response,
    [/App\.jsx|App/i, /Header/i, /Counter/i, /useState|state|count/i],
    [
      /```/,
      /do(?:n't| not) have access/i,
      /share (?:the )?contents/i,
      /switch to Agent mode/i,
    ],
  );
  return response.trim();
}

async function runAgentScenario(id) {
  process.env.POINTER_EVAL_SCENARIO = id;
  const { runAgent } = await import("./evalAgent.mjs");
  const rows = await runAgent();
  const row = rows[0];
  if (!row?.pass) {
    throw new Error(`${id} failed: ${(row?.failures ?? []).join("; ")}`);
  }
  return row;
}

console.log(bar("Assistant flow probe"));
console.log(`Model: ${MODEL}`);

const askResponse = await runAskProbe();
console.log("\nASK RESPONSE — Tell me about App.jsx");
console.log(askResponse);

const planRow = await runAgentScenario("plan-existing-codebase-route-middleware");
const plan = extractPlan(planRow.trace);
assertMatches(
  "Plan existing-codebase route middleware",
  plan,
  [
    /src\/routes\/passwordReset\.js|src\/http\/server\.js/,
    /src\/middleware\/rateLimit\.js|rateLimit/,
    /req\.ip/,
    /test\/passwordReset\.test\.js|node test\/passwordReset\.test\.js|npm test|test/i,
  ],
  [/create a plan/i, /look(?:ing)? into|identify the/i],
);
console.log("\nPLAN RESPONSE — existing codebase route middleware");
console.log(plan);
console.log(`Tool path: ${toolPath(planRow.trace)}`);

const agentRow = await runAgentScenario("repo-context-fix-service-layer");
const final = extractFinal(agentRow.trace);
assertMatches(
  "Agent repo-context service-layer fix",
  final,
  [/auth|authenticate|disabled|fixed|updated|changed|implemented/i],
);
console.log("\nAGENT FINAL — repo-context service-layer fix");
console.log(final);
console.log(`Tool path: ${toolPath(agentRow.trace)}`);

console.log("\nAssistant flow probe passed.");
