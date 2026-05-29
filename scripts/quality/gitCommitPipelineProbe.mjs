#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const cwd = path.resolve(args.cwd ?? process.cwd());
const mock = args.mock === true;
const json = args.json === true;
const staged = args.unstaged !== true;
const ollamaBaseUrl = args.ollamaUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

const server = await createServer({
  appType: "custom",
  configFile: path.join(cwd, "vite.config.ts"),
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const workflow = await server.ssrLoadModule("/src/lib/gitWorkflow.ts");
  const { Judge } = await server.ssrLoadModule("/src/lib/harnessCore.ts");
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
    warnings: [],
  };

  const fileMemories = [];
  for (const file of files) {
    const diff = await gitDiff(cwd, file.path, staged);
    const fallback = workflow.fallbackSummaryFromDiff(file.path, file.status, diff);
    const chunks = workflow.chunkDiffForSummary(file.path, diff || `${file.path} changed.`);
    const chunkSummaries = [];
    const fileRecord = {
      path: file.path,
      status: file.status,
      chunks: [],
      rawFileSummary: "",
      fileSummary: "",
      fallback,
    };

    for (const chunk of chunks) {
      const chunkFallback = workflow.fallbackSummaryFromDiff(file.path, file.status, chunk.text);
      const rawChunk = await generate({
        model,
        prompt: workflow.buildDiffChunkSummaryPrompt(chunk),
        title: `chunk ${file.path} ${chunk.index}/${chunk.total}`,
        numPredict: 72,
      });
      const compactChunk = await maybeRetryShortSummary({
        raw: rawChunk,
        title: `compress ${file.path} ${chunk.index}/${chunk.total}`,
        maxWords: 24,
        maxSentences: 1,
        model,
      });
      const summary = workflow.normalizeChunkSummary(
        compactChunk,
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
      fileRecord.chunks.push(chunkRecord);
    }

    const rawFileSummary =
      chunkSummaries.length <= 1
        ? (chunkSummaries[0]?.summary ?? "")
        : await generate({
            model,
            prompt: workflow.buildFileConsolidationPrompt(file.path, chunkSummaries),
            title: `file ${file.path}`,
            numPredict: 96,
          });
    const compactFile = await maybeRetryShortSummary({
      raw: rawFileSummary,
      title: `shorten ${file.path}`,
      maxWords: 35,
      maxSentences: 2,
      model,
    });
    const fileSummary = workflow.normalizeFileSummary(
      compactFile,
      file.path,
      file.status,
      fallback,
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

  const rawConsolidated = await generate({
    model,
    prompt: workflow.buildChangeConsolidationPrompt(summaries),
    title: "consolidated summary",
    numPredict: 180,
  });
  const compactConsolidated = await maybeRetryShortSummary({
    raw: rawConsolidated,
    title: "shorten consolidated summary",
    maxWords: 65,
    maxSentences: 3,
    model,
  });
  const consolidatedSummary = workflow.normalizeChangeSummary(compactConsolidated, summaries);
  transcript.consolidated = {
    raw: rawConsolidated,
    normalized: consolidatedSummary,
  };

  const rawCommit = await generate({
    model,
    prompt: workflow.buildCommitMessagePrompt(summaries, consolidatedSummary),
    title: "commit message",
    numPredict: 180,
  });
  const commitMessage = workflow.normalizeGeneratedCommitMessage(rawCommit, summaries);
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
  }

  validateTranscript(transcript);
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

async function maybeRetryShortSummary({ raw, title, maxWords, maxSentences, model }) {
  if (sentenceCount(raw) <= maxSentences && wordCount(raw) <= maxWords + 6) {
    return raw;
  }
  return generate({
    model,
    title,
    numPredict: Math.max(48, Math.min(120, maxWords * 3)),
    prompt: [
      "Compress this summary. Return only the compressed summary.",
      `Use at most ${maxSentences} sentence${maxSentences === 1 ? "" : "s"} and ${maxWords} words.`,
      "Do not add new facts, file paths, filenames, or changed symbols.",
      "",
      raw.trim(),
    ].join("\n"),
  });
}

async function generate({ model, prompt, title, numPredict }) {
  if (mock) return mockGenerate(prompt, title);
  const response = await fetch(`${ollamaBaseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: numPredict,
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
  ])].filter((item) => item.length >= 4);
}

function sentenceCount(text) {
  return text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.length ?? 0;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
