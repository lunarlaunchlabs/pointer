#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";

const execFileAsync = promisify(execFile);

const GENERIC_PATH_FRAGMENT_WORDS = new Set([
  "app",
  "apps",
  "asset",
  "assets",
  "bin",
  "build",
  "bundle",
  "cache",
  "component",
  "components",
  "config",
  "dist",
  "doc",
  "docs",
  "file",
  "files",
  "fixture",
  "fixtures",
  "helper",
  "helpers",
  "icon",
  "icons",
  "image",
  "images",
  "index",
  "lib",
  "main",
  "mod",
  "module",
  "modules",
  "page",
  "pages",
  "public",
  "route",
  "routes",
  "script",
  "scripts",
  "source",
  "src",
  "static",
  "store",
  "stores",
  "style",
  "styles",
  "test",
  "tests",
  "type",
  "types",
  "util",
  "utils",
  "view",
  "views",
  "workspace",
  "workspaces",
]);

const args = parseArgs(process.argv.slice(2));
const appRoot = path.resolve(args.app ?? args.appRoot ?? process.cwd());
const cwd = path.resolve(args.cwd ?? process.cwd());
const mock = args.mock === true;
const json = args.json === true;
const staged = args.unstaged !== true;
const ollamaBaseUrl = args.ollamaUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

const server = await createServer({
  root: appRoot,
  appType: "custom",
  configFile: path.join(appRoot, "vite.config.ts"),
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const workflow = await server.ssrLoadModule("/src/lib/gitWorkflow.ts");
  const { Judge } = await server.ssrLoadModule("/src/lib/harnessCore.ts");
  const { GitCommitHarness } = await server.ssrLoadModule("/src/lib/gitCommitHarness.ts");
  const model = mock ? "mock-model" : (args.model ?? await detectOllamaModel());
  if (!mock && !model) {
    throw new Error("No Ollama model found. Pass --model <name> or use --mock.");
  }

  const files = await changedFiles(cwd, staged);
  if (files.length === 0) {
    throw new Error(`No ${staged ? "staged" : "unstaged"} tracked changes to probe.`);
  }

  const transcript = {
    cwd,
    mode: staged ? "staged" : "unstaged",
    model,
    files: [],
    consolidated: null,
    commit: null,
    judge: null,
    harness: null,
    polish: [],
    warnings: [],
  };

  const harness = new GitCommitHarness();
  const strictRuntime = harness.strictRuntime();
  const seedMemory = harness.seed({
    prompt: `Generate an accurate git commit message for the ${staged ? "staged" : "unstaged"} diff.`,
    workspaceRoot: cwd,
    openDirectoryEntries: files.map((file) => ({ path: file.path, kind: "file" })),
  });
  const scoutTodo = strictRuntime.todos.add({
    title: "Approve git status targets for commit drafting",
    stage: "scout_targets",
    assignedArchetype: "scout",
    evidenceMemoryIds: [seedMemory.id],
  });
  const targetMemories = harness.rememberScoutTargets(
    files.map((file) => ({
      kind: "file",
      path: file.path,
      reason: `Selected by git ${staged ? "staged" : "unstaged"} status for commit drafting.`,
    })),
    [seedMemory.id],
  );
  const approvedFiles = harness.promoteApprovedFiles(
    files.map((file) => ({
      path: file.path,
      status: file.status,
      reason: "Selected by deterministic git status for commit drafting.",
    })),
    files.map((file) => ({
      id: file.path,
      label: file.path,
      value: {
        path: file.path,
        status: file.status,
        reason: "Selected by deterministic git status for commit drafting.",
      },
    })),
    targetMemories.map((memory) => memory.id),
  );
  harness.approveMemories(targetMemories.map((memory) => memory.id));
  strictRuntime.todos.complete(
    scoutTodo.content.id,
    targetMemories.map((memory) => memory.id),
  );
  await strictRuntime.approveNavigation(
    "scout_targets",
    targetMemories.map((memory) => memory.id),
    async () => "Y",
  );
  const approvedFileByPath = new Map(
    approvedFiles.map((memory) => [memory.content.path, memory.id]),
  );

  const fileMemories = [];
  for (const file of files) {
    const diff = await gitDiff(cwd, file.path, staged);
    const fallback = workflow.fallbackSummaryFromDiff(file.path, file.status, diff);
    const chunks = workflow.chunkDiffForSummary(file.path, diff || `${file.path} changed.`);
    const chunkSummaries = [];
    const chunkMemoryIds = [];
    const fileRecord = {
      path: file.path,
      status: file.status,
      chunks: [],
      rawFileSummary: "",
      fileSummary: "",
      fallback,
    };

    for (const chunk of chunks) {
      const diffMemory = harness.rememberDiffChunk(
        {
          path: file.path,
          chunkIndex: chunk.index,
          totalChunks: chunk.total,
          lineRange: `${chunk.startLine}-${chunk.endLine}`,
          text: chunk.text,
        },
        [approvedFileByPath.get(file.path)].filter(Boolean),
      );
      const chunkFallback = workflow.fallbackSummaryFromDiff(file.path, file.status, chunk.text);
      const rawChunk = await generate({
        model,
        prompt: workflow.buildDiffChunkSummaryPrompt(chunk),
        title: `chunk ${file.path} ${chunk.index}/${chunk.total}`,
        numPredict: 56,
        stop: ["\n"],
      });
      const summary = workflow.normalizeChunkSummary(
        rawChunk,
        file.path,
        file.status,
        chunkFallback,
      );
      const chunkRecord = {
        index: chunk.index,
        total: chunk.total,
        lineRange: `${chunk.startLine}-${chunk.endLine}`,
        raw: rawChunk,
        summary,
        fallback: chunkFallback,
      };
      chunkSummaries.push({
        index: chunk.index,
        lineRange: chunkRecord.lineRange,
        summary,
        fallback: chunkFallback,
      });
      const chunkMemory = harness.rememberChunkSummary(
        {
          path: file.path,
          chunkIndex: chunk.index,
          totalChunks: chunk.total,
          lineRange: chunkRecord.lineRange,
          summary,
        },
        [diffMemory.id],
        true,
      );
      chunkMemoryIds.push(chunkMemory.id);
      fileRecord.chunks.push(chunkRecord);
    }

    const rawFileSummary =
      chunkSummaries.length <= 1
        ? (chunkSummaries[0]?.summary ?? "")
        : await generate({
            model,
            prompt: workflow.buildFileConsolidationPrompt(file.path, chunkSummaries),
            title: `file ${file.path}`,
            numPredict: 80,
            stop: ["\n"],
          });
    const fileSummary = workflow.normalizeFileSummary(
      rawFileSummary,
      file.path,
      file.status,
      fallback,
    );
    harness.rememberFileSummary(
      {
        path: file.path,
        status: file.status,
        summary: fileSummary,
      },
      chunkMemoryIds,
      true,
    );

    fileRecord.rawFileSummary = rawFileSummary;
    fileRecord.fileSummary = fileSummary;
    transcript.files.push(fileRecord);
    fileMemories.push({
      path: file.path,
      status: file.status,
      summary: fileSummary,
      fallback,
      chunks: chunkSummaries,
    });
  }

  const summaries = fileMemories.map(({ path: filePath, status, summary, fallback }) => ({
    path: filePath,
    status,
    summary,
    fallback,
  }));

  const rawConsolidated = "";
  const consolidatedSummary = workflow.normalizeChangeSummary("", summaries);
  const fileSummaryMemoryIds = harness.memory
    .byKind("file_summary", { approvedOnly: true })
    .map((memory) => memory.id);
  const sufficiency = harness.rememberDecision(
    "scout_evaluator",
    {
      verdict: "sufficient",
      reason: "Approved file summaries were enough to draft a commit message.",
    },
    fileSummaryMemoryIds,
    true,
  );
  transcript.consolidated = {
    raw: rawConsolidated,
    normalized: consolidatedSummary,
  };

  const rawCommit = await generate({
    model,
    prompt: workflow.buildCommitMessagePrompt(summaries, consolidatedSummary),
    title: "commit message",
    numPredict: 160,
  });
  const rawDraft = harness.rememberDraft(
    "message_drafter",
    { message: rawCommit, raw: rawCommit },
    [sufficiency.id],
    false,
  );
  const commitMessage = workflow.normalizeGeneratedCommitMessage(rawCommit, summaries);
  const normalizedDraft = harness.rememberDraft(
    "message_normalizer",
    { message: commitMessage, raw: rawCommit },
    [rawDraft.id],
    true,
  );
  harness.supersedeMemory(rawDraft.id);
  const redTeam = harness.rememberDecision(
    "message_red_team",
    {
      verdict: "ready",
      reason: "The normalized draft passed deterministic leak checks.",
    },
    [normalizedDraft.id],
    true,
  );
  transcript.commit = {
    raw: rawCommit,
    normalized: commitMessage,
  };

  if (args.judge === true) {
    const judge = new Judge();
    transcript.judge = await judge.run(
      {
        taskClass: "commit",
        initialPrompt: "Generate an accurate git commit message for the staged diff.",
        foundImportantBecause: [
          `Consolidated summary: ${consolidatedSummary}`,
          "File summaries:",
          ...summaries.map((item) => `${item.path}: ${item.summary}`),
        ].join("\n"),
        dueDiligenceTrace: [
          `git_status selected ${files.length} ${staged ? "staged" : "unstaged"} tracked file(s)`,
          ...transcript.files.flatMap((file) => [
            `git_diff ${staged ? "--cached " : ""}${file.path}`,
            `chunked ${file.path} into ${file.chunks.length} bounded diff chunk(s)`,
            `normalized ${file.path}: ${file.fileSummary}`,
          ]),
          "normalized consolidated summary before final commit message",
          "normalized final commit message before judge validation",
        ],
        producedOutput: commitMessage,
        successCriteria: [
          "The commit message describes only actual staged changes.",
          "The commit message names concrete capabilities rather than broad categories.",
          "The commit message does not leak paths, fixture strings, template literals, or implementation-symbol inventory.",
          "The commit message is concise enough for a real commit.",
        ],
        diligenceCriteria: [
          "The pipeline inspected each selected staged diff.",
          "The pipeline chunked and normalized file-level evidence before final synthesis.",
          "The final commit message was judged after normalization, not from raw model output alone.",
        ],
      },
      async (prompt, index, dimension) =>
        generate({
          model,
          prompt,
          title: `judge ${index + 1} ${dimension}`,
          numPredict: 2,
        }),
    );
    if (transcript.judge.verdict !== "PASS") {
      transcript.warnings.push(
        `judge blocked commit message (${transcript.judge.yes}Y/${transcript.judge.no}N/${transcript.judge.invalid} invalid, required ${transcript.judge.requiredYes}/${transcript.judge.totalVotes})`,
      );
    }
    harness.rememberFinal(
      { message: commitMessage, raw: rawCommit },
      [redTeam.id],
      transcript.judge.verdict === "PASS",
    );
  } else {
    harness.rememberFinal(
      { message: commitMessage, raw: rawCommit },
      [redTeam.id],
      true,
    );
  }

  transcript.harness = summarizeHarness(harness);
  validateTranscript(transcript);
  analyzeHarnessTrace(transcript);
  if (json) {
    process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  } else {
    printTranscript(transcript);
  }

  if (transcript.warnings.length > 0 && args.failOnWarnings === true) {
    process.exitCode = 1;
  }
} finally {
  await server.close();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mock") out.mock = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--unstaged") out.unstaged = true;
    else if (arg === "--fail-on-warnings") out.failOnWarnings = true;
    else if (arg === "--judge") out.judge = true;
    else if (arg === "--trace-harness") out.traceHarness = true;
    else if (arg === "--app" || arg === "--app-root") out.app = argv[++i];
    else if (arg === "--cwd") out.cwd = argv[++i];
    else if (arg === "--model") out.model = argv[++i];
    else if (arg === "--ollama-url") out.ollamaUrl = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function changedFiles(repo, useStaged) {
  const argsForDiff = ["diff", "--name-status", "-M", ...(useStaged ? ["--cached"] : [])];
  const { stdout } = await execFileAsync("git", argsForDiff, { cwd: repo });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/);
      const rawStatus = parts[0] ?? "M";
      const pathName = rawStatus.startsWith("R") ? parts[2] : parts[1];
      return {
        path: pathName,
        status: gitStatusToEntry(rawStatus),
      };
    })
    .filter((item) => item.path && item.status !== "untracked");
}

function gitStatusToEntry(status) {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("U")) return "conflicted";
  return "modified";
}

async function gitDiff(repo, filePath, useStaged) {
  const argsForDiff = ["diff", ...(useStaged ? ["--cached"] : []), "--", filePath];
  const { stdout } = await execFileAsync("git", argsForDiff, {
    cwd: repo,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function detectOllamaModel() {
  try {
    const { stdout } = await execFileAsync("ollama", ["list"], { maxBuffer: 1024 * 1024 });
    return stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .find(Boolean);
  } catch {
    return "";
  }
}

async function generate({ model, prompt, title, numPredict, stop }) {
  if (mock) return mockGenerate(prompt, title);
  const response = await fetch(`${ollamaBaseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      think: false,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: numPredict,
        ...(stop ? { stop } : {}),
      },
      system:
        "You are Pointer's git assistant. Be concise, specific, and accurate. Never invent changes not shown in the diff.",
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama ${title} failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return String(data.response ?? "").trim();
}

function mockGenerate(prompt, title) {
  if (prompt.startsWith("You are Judge ")) {
    return "Y";
  }
  if (prompt.includes("Write a polished git commit message")) {
    return "Improve commit message generation and source control workflow";
  }
  if (prompt.includes("Consolidate these file summaries")) {
    return "Updates remote line ${i + 1}. Updates Adds visual git workflow support.. Updates src/lib/harnessCore.";
  }
  if (prompt.includes("Consolidate these independent chunk summaries")) {
    return "Updates src/lib/harnessCore.";
  }
  if (title.includes("chunk")) {
    return "Adds visual git workflow support.";
  }
  return "Updates related behavior.";
}

function validateTranscript(transcript) {
  const paths = transcript.files.map((file) => file.path);
  for (const [label, value] of [
    ["consolidated summary", transcript.consolidated?.normalized ?? ""],
    ["commit message", transcript.commit?.normalized ?? ""],
  ]) {
    if (/\$\{[^}]+\}/.test(value)) {
      transcript.warnings.push(`${label} still contains a template literal leak`);
    }
    if (/\bremote line\b/i.test(value)) {
      transcript.warnings.push(`${label} still contains fixture remote-line text`);
    }
    if (/\bupdates?\s+adds?\b/i.test(value)) {
      transcript.warnings.push(`${label} still contains broken grammar`);
    }
    const lower = value.toLowerCase();
    for (const filePath of paths) {
      for (const fragment of pathFragments(filePath)) {
        if (lower.includes(fragment)) {
          transcript.warnings.push(`${label} still contains path fragment: ${fragment}`);
        }
      }
    }
  }
}

function summarizeHarness(harness) {
  const snapshot = harness.memory.snapshot();
  const stageCounts = new Map();
  for (const memory of snapshot.memories) {
    const current = stageCounts.get(memory.stage) ?? {
      stage: memory.stage,
      total: 0,
      approved: 0,
      pending: 0,
      rejected: 0,
      kinds: new Set(),
      archetypes: new Set(),
    };
    current.total += 1;
    current[memory.status] = (current[memory.status] ?? 0) + 1;
    current.kinds.add(memory.kind);
    current.archetypes.add(memory.archetype);
    stageCounts.set(memory.stage, current);
  }
  return {
    blueprint: harness.blueprint.layers.map((layer) => ({
      id: layer.id,
      archetype: layer.archetype,
      actionMode: layer.actionMode,
      judge: layer.judge.kind,
      outputKinds: layer.outputKinds,
    })),
    lanes: snapshot.lanes.length,
    memories: snapshot.memories.length,
    approved: snapshot.memories.filter((memory) => memory.status === "approved").length,
    pending: snapshot.memories.filter((memory) => memory.status === "pending").length,
    rejected: snapshot.memories.filter((memory) => memory.status === "rejected").length,
    superseded: snapshot.memories.filter((memory) => memory.status === "superseded").length,
    stages: [...stageCounts.values()].map((stage) => ({
      ...stage,
      kinds: [...stage.kinds],
      archetypes: [...stage.archetypes],
    })),
    recent: snapshot.memories.slice(-12).map((memory) => ({
      id: memory.id,
      stage: memory.stage,
      kind: memory.kind,
      archetype: memory.archetype,
      status: memory.status,
      summary: memory.summary,
      parentIds: memory.parentIds,
    })),
  };
}

function analyzeHarnessTrace(transcript) {
  const finalText = [
    transcript.consolidated?.normalized ?? "",
    transcript.commit?.normalized ?? "",
  ].join("\n");
  const lowValue = [
    "num predict",
    "writes approved memory",
    "action mode",
    "agent orbit",
    "border radius",
    "box shadow",
    "cubic bezier",
    "align items",
    "allowed tools",
    "requires judge use",
    "required yes",
  ].filter((term) => finalText.toLowerCase().includes(term));
  for (const term of lowValue) {
    transcript.polish.push({
      stage: "message_normalizer",
      issue: `Low-value implementation concept leaked: ${term}`,
      recommendation: "Keep support/style/implementation-token memories out of final synthesis unless they are the only changed surface.",
    });
  }
  if (transcript.harness && transcript.harness.pending > 1) {
    transcript.polish.push({
      stage: "memory_curator",
      issue: `${transcript.harness.pending} pending memories remain after finalization.`,
      recommendation: "Supersede or reject unused proposed memories after normalization.",
    });
  }
}

function printTranscript(transcript) {
  console.log(`[commit-probe] ${transcript.mode} changes in ${transcript.cwd}`);
  console.log(`[commit-probe] model: ${transcript.model}`);
  for (const file of transcript.files) {
    console.log(`\n[file] ${file.path}`);
    for (const chunk of file.chunks) {
      console.log(`  [chunk ${chunk.index}/${chunk.total} lines ${chunk.lineRange}]`);
      console.log(`    raw: ${singleLine(chunk.raw)}`);
      console.log(`    normalized: ${singleLine(chunk.summary)}`);
    }
    console.log(`  [file summary raw] ${singleLine(file.rawFileSummary)}`);
    console.log(`  [file summary] ${singleLine(file.fileSummary)}`);
  }
  console.log("\n[consolidated summary]");
  console.log(`  raw: ${singleLine(transcript.consolidated.raw)}`);
  console.log(`  normalized: ${singleLine(transcript.consolidated.normalized)}`);
  console.log("\n[commit message]");
  console.log(`  raw: ${singleLine(transcript.commit.raw)}`);
  console.log(`  normalized:\n${transcript.commit.normalized}`);
  if (transcript.judge) {
    console.log("\n[judge]");
    console.log(
      `  verdict: ${transcript.judge.verdict} (${transcript.judge.yes}Y/${transcript.judge.no}N/${transcript.judge.invalid} invalid, required ${transcript.judge.requiredYes}/${transcript.judge.totalVotes})`,
    );
    for (const vote of transcript.judge.votes) {
      console.log(
        `  judge ${vote.index + 1} ${vote.dimension}: raw=${JSON.stringify(vote.raw)} vote=${vote.vote} attempts=${vote.attempts.length}`,
      );
    }
  }
  if (args.traceHarness === true && transcript.harness) {
    console.log("\n[harness memory]");
    console.log(
      `  memories: ${transcript.harness.memories} total, ${transcript.harness.approved} approved, ${transcript.harness.pending} pending, ${transcript.harness.rejected} rejected, ${transcript.harness.superseded} superseded`,
    );
    for (const stage of transcript.harness.stages) {
      console.log(
        `  [${stage.stage}] ${stage.total} memories (${stage.approved} approved) via ${stage.archetypes.join(", ")} -> ${stage.kinds.join(", ")}`,
      );
    }
    console.log("  recent:");
    for (const memory of transcript.harness.recent) {
      console.log(
        `    ${memory.id} ${memory.status} ${memory.stage}/${memory.kind}: ${singleLine(memory.summary)}`,
      );
    }
  }
  if (transcript.polish.length > 0) {
    console.log("\n[polish]");
    for (const item of transcript.polish) {
      console.log(`  - ${item.stage}: ${item.issue}`);
      console.log(`    ${item.recommendation}`);
    }
  }
  if (transcript.warnings.length > 0) {
    console.log("\n[warnings]");
    for (const warning of transcript.warnings) console.log(`  - ${warning}`);
  } else {
    console.log("\n[validation] PASS");
  }
}

function pathFragments(filePath) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.at(-1) ?? normalized;
  return [...new Set([
    normalized,
    normalized.replace(/\.[^.]+$/, ""),
    file,
    file.replace(/\.[^.]+$/, ""),
  ])].filter(isDistinctPathFragment);
}

function isDistinctPathFragment(fragment) {
  if (fragment.length < 4) return false;
  if (GENERIC_PATH_FRAGMENT_WORDS.has(fragment)) return false;
  if (fragment.includes("/")) return fragment.length >= 8;
  if (fragment.includes(".")) return fragment.length >= 6;
  if (/^[a-z]+$/.test(fragment) && fragment.length < 8) return false;
  return true;
}

function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
