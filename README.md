# Pointer

An AI-first code editor powered by open-source models running locally.

Pointer abstracts away running models on your computer. You pick the model you
want from Ollama's model library, and Pointer handles loading, inference, and
integration with the editor. Everything stays on your machine.

## Features

- **Chat sidebar** (`⌘L`) — talk to your code with `@file`, `@selection`, `@codebase`.
- **Inline edit** (`⌘K`) — describe what you want; review and accept the diff.
- **Tab completion** — fill-in-the-middle ghost text from a small fast model.
- **Agent mode** — a tool-calling loop that can read, search, and propose edits with your approval.
- **Codebase context engine** — Tree-sitter-style chunking + Merkle-hash incremental indexing + local embeddings stored in SQLite.
- **Beautiful dark theme** — Pointer Noir. Deep blacks, a single neon-magenta accent for AI affordances, pastel syntax.
- **Lightweight** — Tauri + Rust + native webview. Smaller binary and lower RAM than Electron-based editors.

## Architecture

Three layers mirror Cursor:

- **Shell** — Tauri + Monaco (`src/`, `src-tauri/`).
- **Orchestration** — token-budgeted prompt builder (`src/lib/prompt.ts`, `src-tauri/src/services/prompt.rs`).
- **Context engine** — chunker + Merkle hashes + embeddings + SQLite (`src-tauri/src/services/`, `src-tauri/src/commands/context.rs`).

All inference is delegated to a managed [Ollama](https://ollama.com) daemon, which
exposes an OpenAI-compatible API on `localhost:11434`. The marketplace fetches
Ollama's upstream library list, overlays your locally installed models, and
pulls through Ollama.

```
┌─ Renderer ────────────────────────────┐
│  React + Monaco + Tailwind            │
│  Chat · Cmd+K · Tab · Cmd Palette     │
└──────────────── Tauri IPC ────────────┘
┌─ Rust backend ────────────────────────┐
│  FS · watcher · Tree-sitter-ish       │
│  chunker · Merkle · embeddings        │
│  Ollama client · library catalog      │
└────── HTTP localhost:11434 ───────────┘
┌─ Ollama daemon (managed) ─────────────┐
│  Qwen2.5-Coder · DeepSeek-Coder-V2    │
│  nomic-embed-text · your pulls        │
└───────────────────────────────────────┘
```

## Requirements

- macOS, Linux, or Windows
- Node.js 20+ and npm
- Rust toolchain (`rustup`)
- [Ollama](https://ollama.com) (Pointer offers to install it on first run)

## Running

```bash
npm install
npm run tauri:dev
```

The first run walks you through:

1. Installing/starting Ollama.
2. Picking models tuned to your RAM (tab completion + chat + embeddings).

## Recommended models

| Purpose          | Default                       | Notes                     |
| ---------------- | ----------------------------- | ------------------------- |
| Tab completion   | `qwen2.5-coder:1.5b-base`     | FIM tokens, <200ms        |
| Chat / Cmd+K     | `qwen2.5-coder:7b-instruct`   | sweet spot for 8–16 GB    |
| Chat (more RAM)  | `qwen2.5-coder:14b-instruct`  | 16–32 GB                  |
| Embeddings       | `nomic-embed-text`            | for `@codebase` retrieval |

## Keyboard

| Shortcut    | Action                |
| ----------- | --------------------- |
| `⌘O`        | Open folder           |
| `⌘P`        | Find file             |
| `⌘⇧P`       | Command palette       |
| `⌘S`        | Save                  |
| `⌘L`        | Toggle chat sidebar   |
| `⌘K`        | Inline edit selection |
| `Tab`       | Accept completion     |
| `Esc`       | Dismiss overlay       |

## Privacy

Pointer never sends your code over the network. The only outbound calls are:

- Ollama library metadata for the model browser.
- Model downloads from Ollama (when you click Pull).

All prompts and embeddings stay between Pointer and your local Ollama on `127.0.0.1`.
