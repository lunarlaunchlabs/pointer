#!/usr/bin/env node
// Unified Pointer quality run.
//
// Drives each surface (FIM, Chat, Inline edit, Agent) against the
// live local Ollama and reports a single PASS/FAIL summary. Optional
// `--rounds=N` re-runs the full suite N times to surface flakiness
// (model temperature isn't zero, so any given turn is a sample, not
// a guarantee).
//
// Exit code is non-zero if ANY surface fails on ANY round.

import { runFim } from "./evalFim.mjs";
import { runChat } from "./evalChat.mjs";
import { runInline } from "./evalInline.mjs";
import { runAgent } from "./evalAgent.mjs";

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(name + "="));
  if (!a) return def;
  return a.slice(name.length + 1);
}

const rounds = Number(arg("--rounds", "1"));
const only = arg("--only", null); // e.g. --only=chat,agent

const SURFACES = [
  { id: "fim", run: runFim, label: "FIM" },
  { id: "chat", run: runChat, label: "Chat" },
  { id: "inline", run: runInline, label: "Inline edit" },
  { id: "agent", run: runAgent, label: "Agent" },
];

const enabled = only
  ? new Set(only.split(",").map((s) => s.trim()))
  : new Set(SURFACES.map((s) => s.id));

const t0 = Date.now();
const matrix = []; // matrix[round][surface] = { passes, total }
for (let r = 0; r < rounds; r++) {
  console.log(
    `\n══════════════════════════ ROUND ${r + 1}/${rounds} ══════════════════════════`,
  );
  const row = {};
  for (const s of SURFACES) {
    if (!enabled.has(s.id)) {
      row[s.id] = { skipped: true };
      continue;
    }
    const results = await s.run();
    const passes = results.filter((x) => x.pass).length;
    row[s.id] = { passes, total: results.length, results };
  }
  matrix.push(row);
}

// ───── Final report ─────
console.log("\n══════════════════════════ SUMMARY ══════════════════════════");
for (const s of SURFACES) {
  if (!enabled.has(s.id)) {
    console.log(`  ${s.label.padEnd(13)} — skipped`);
    continue;
  }
  const totals = matrix.map((row) => row[s.id]);
  const allPasses = totals.reduce((a, b) => a + b.passes, 0);
  const allTotal = totals.reduce((a, b) => a + b.total, 0);
  const breakdown = totals.map((t) => `${t.passes}/${t.total}`).join(", ");
  const fullyClean = totals.every((t) => t.passes === t.total);
  console.log(
    `  ${fullyClean ? "✓" : "✗"} ${s.label.padEnd(13)}  cumulative ${allPasses}/${allTotal}  per-round: ${breakdown}`,
  );
}
// Agent category coverage — show that the agent harness exercises
// a broad cross-section of behaviour, not just one shape of task.
if (enabled.has("agent")) {
  const byCat = new Map();
  for (const row of matrix) {
    for (const r of row.agent.results ?? []) {
      if (!byCat.has(r.category)) byCat.set(r.category, []);
      byCat.get(r.category).push(r.pass);
    }
  }
  if (byCat.size > 0) {
    console.log("\nAgent category coverage:");
    const cats = [...byCat.entries()].sort();
    for (const [cat, passes] of cats) {
      const ok = passes.filter(Boolean).length;
      const total = passes.length;
      const mark = ok === total ? "✓" : "✗";
      console.log(`  ${mark} ${cat.padEnd(15)} ${ok}/${total}`);
    }
  }
}

const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nWall clock: ${wall}s  rounds: ${rounds}`);

// Identify any flaky scenario — one that passed at least once AND
// failed at least once across the rounds.
const flaky = [];
for (const s of SURFACES) {
  if (!enabled.has(s.id)) continue;
  const byId = new Map();
  for (const row of matrix) {
    for (const r of row[s.id].results ?? []) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id).push(r.pass);
    }
  }
  for (const [id, passes] of byId) {
    if (passes.includes(true) && passes.includes(false)) {
      flaky.push({ surface: s.label, id, log: passes });
    }
  }
}
if (flaky.length) {
  console.log(`\nFlaky scenarios (passed AND failed across rounds):`);
  for (const f of flaky) {
    console.log(`  · ${f.surface} → ${f.id}: [${f.log.map((p) => (p ? "✓" : "✗")).join(" ")}]`);
  }
}

// Identify any scenario that failed every round (stable failure).
const stableFail = [];
for (const s of SURFACES) {
  if (!enabled.has(s.id)) continue;
  const byId = new Map();
  for (const row of matrix) {
    for (const r of row[s.id].results ?? []) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id).push(r.pass);
    }
  }
  for (const [id, passes] of byId) {
    if (passes.every((p) => p === false)) {
      stableFail.push({ surface: s.label, id });
    }
  }
}
if (stableFail.length) {
  console.log(`\nStable failures (failed every round):`);
  for (const f of stableFail) {
    console.log(`  · ${f.surface} → ${f.id}`);
  }
}

const ok = matrix.every((row) =>
  SURFACES.every((s) => !enabled.has(s.id) || row[s.id].passes === row[s.id].total),
);
process.exit(ok ? 0 : 1);
