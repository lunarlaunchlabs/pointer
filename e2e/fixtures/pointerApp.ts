import { expect, test as base, type Page } from "@playwright/test";

export const ROOT = "/workspace/pointer-e2e";

export const paths = {
  app: `${ROOT}/src/App.tsx`,
  button: `${ROOT}/src/components/Button.tsx`,
  greeting: `${ROOT}/src/utils/greeting.ts`,
  completion: `${ROOT}/src/Completion.ts`,
  server: `${ROOT}/server/index.js`,
  router: `${ROOT}/server/router.js`,
  python: `${ROOT}/python/app.py`,
  rust: `${ROOT}/rust/src/lib.rs`,
  go: `${ROOT}/go/main.go`,
  java: `${ROOT}/java/src/main/java/com/example/App.java`,
  csharp: `${ROOT}/dotnet/Program.cs`,
  vue: `${ROOT}/vue/App.vue`,
  svelte: `${ROOT}/svelte/App.svelte`,
  css: `${ROOT}/styles/theme.css`,
  json: `${ROOT}/package.json`,
  markdown: `${ROOT}/README.md`,
};

export type PointerFixtures = {
  appPage: Page;
};

export const test = base.extend<PointerFixtures>({
  appPage: async ({ page }, use) => {
    await page.addInitScript(mockPointerDesktop, makeFixture());
    await page.goto("/");
    await waitForPointer(page);
    await use(page);
  },
});

export { expect };

export async function waitForPointer(page: Page) {
  await page.waitForFunction(() => window.__POINTER_E2E__?.appReady === true);
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
  await page.waitForFunction(
    (path) => window.__POINTER_E2E__?.editor?.activeTab?.()?.path === path,
    paths.app,
  );
}

export async function openE2EFile(page: Page, path: string) {
  await page.evaluate(async (targetPath) => {
    await window.__POINTER_E2E__?.editor?.openFile?.(targetPath);
  }, path);
  await page.waitForFunction(
    (targetPath) => window.__POINTER_E2E__?.editor?.activeTab?.()?.path === targetPath,
    path,
  );
}

export async function activeTab(page: Page) {
  return page.evaluate(() => window.__POINTER_E2E__?.editor?.activeTab?.());
}

export async function editorLanguage(page: Page) {
  return page.evaluate(() => window.__POINTER_E2E__?.editor?.language?.());
}

export async function editorMarkers(page: Page) {
  return page.evaluate(() => window.__POINTER_E2E__?.editor?.markers?.() ?? []);
}

export async function pendingRefs(page: Page) {
  return page.evaluate(() => window.__POINTER_E2E__?.assistant?.pendingRefs?.() ?? []);
}

export async function commandLog(page: Page) {
  return page.evaluate(() => window.__POINTER_E2E__?.commandLog ?? []);
}

export async function dropPathsIntoAssistant(page: Page, filePaths: string[]) {
  const target = page.locator('[data-pointer-drop-context="assistant"]');
  const dt = await page.evaluateHandle((items) => {
    const data = new DataTransfer();
    data.setData("application/x-pointer-paths", JSON.stringify(items));
    data.setData("text/plain", items[0] ?? "");
    return data;
  }, filePaths);
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await dt.dispose();
}

export async function dropBreakpointIntoAssistant(page: Page, breakpoint: unknown) {
  const target = page.locator('[data-pointer-drop-context="assistant"]');
  const dt = await page.evaluateHandle((bp) => {
    const data = new DataTransfer();
    data.setData("application/x-pointer-breakpoint", JSON.stringify(bp));
    data.setData("text/plain", "pointer breakpoint context");
    return data;
  }, breakpoint);
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await dt.dispose();
}

export async function dropDebugValueIntoAssistant(page: Page, value: unknown) {
  const target = page.locator('[data-pointer-drop-context="assistant"]');
  const dt = await page.evaluateHandle((debugValue) => {
    const data = new DataTransfer();
    data.setData("application/x-pointer-debug-value", JSON.stringify(debugValue));
    data.setData(
      "text/plain",
      `${(debugValue as { name?: string }).name} = ${(debugValue as { value?: string }).value}`,
    );
    return data;
  }, value);
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await dt.dispose();
}

export async function emitLspDiagnostics(
  page: Page,
  path: string,
  diagnostics: Array<{
    message: string;
    severity?: number;
    source?: string;
    code?: string;
    range?: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    };
  }>,
) {
  await page.evaluate(
    ({ targetPath, items }) => {
      window.__POINTER_E2E__?.emitTauri?.("lsp:diagnostics", {
        path: targetPath,
        uri: `file://${targetPath}`,
        diagnostics: items.map((item) => ({
          message: item.message,
          severity: item.severity ?? 1,
          source: item.source ?? "e2e-lsp",
          code: item.code ?? "E2E001",
          range: item.range ?? {
            startLine: 5,
            startColumn: 10,
            endLine: 5,
            endColumn: 18,
          },
        })),
      });
    },
    { targetPath: path, items: diagnostics },
  );
}

function makeFixture() {
  const files = {
    [paths.json]: JSON.stringify(
      {
        scripts: {
          dev: "vite --host 127.0.0.1",
          test: "vitest run",
          lint: "eslint .",
        },
        dependencies: {
          "@vitejs/plugin-react": "latest",
          express: "latest",
          fastapi: "latest",
          react: "latest",
          "react-dom": "latest",
          vite: "latest",
          vue: "latest",
          svelte: "latest",
        },
        devDependencies: {
          typescript: "latest",
          vitest: "latest",
        },
      },
      null,
      2,
    ),
    [paths.app]: [
      "import { Button } from './components/Button';",
      "import { renderGreeting } from './utils/greeting';",
      "",
      "export default function App() {",
      "  const title = renderGreeting('Pointer');",
      "  return (",
      "    <main className=\"app-shell\">",
      "      <h1>{title}</h1>",
      "      <Button label=\"Launch\" onClick={() => console.log(title)} />",
      "    </main>",
      "  );",
      "}",
    ].join("\n"),
    [paths.button]: [
      "export type ButtonProps = {",
      "  label: string;",
      "  onClick: () => void;",
      "};",
      "",
      "export function Button({ label, onClick }: ButtonProps) {",
      "  return <button onClick={onClick}>{label}</button>;",
      "}",
    ].join("\n"),
    [paths.greeting]: [
      "export function renderGreeting(name: string): string {",
      "  return `Hello, ${name}`;",
      "}",
    ].join("\n"),
    [paths.completion]: [
      "import { renderGreeting } from './utils/greeting';",
      "",
      "export function completionProbe() {",
      "  return render",
      "}",
    ].join("\n"),
    [paths.server]: [
      "import express from 'express';",
      "import { makeRouter } from './router.js';",
      "",
      "const app = express();",
      "app.use('/api', makeRouter());",
      "app.listen(3000);",
    ].join("\n"),
    [paths.router]: [
      "import { Router } from 'express';",
      "",
      "export function makeRouter() {",
      "  const router = Router();",
      "  router.get('/health', (_req, res) => res.json({ ok: true }));",
      "  return router;",
      "}",
    ].join("\n"),
    [paths.python]: [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      "@app.get('/health')",
      "def health() -> dict[str, bool]:",
      "    return {'ok': True}",
    ].join("\n"),
    [paths.rust]: [
      "pub fn render_greeting(name: &str) -> String {",
      "    format!(\"Hello, {name}\")",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "",
      "    #[test]",
      "    fn greets() {",
      "        assert_eq!(render_greeting(\"Pointer\"), \"Hello, Pointer\");",
      "    }",
      "}",
    ].join("\n"),
    [paths.go]: [
      "package main",
      "",
      "import \"fmt\"",
      "",
      "func renderGreeting(name string) string {",
      "    return fmt.Sprintf(\"Hello, %s\", name)",
      "}",
      "",
      "func main() {",
      "    fmt.Println(renderGreeting(\"Pointer\"))",
      "}",
    ].join("\n"),
    [paths.java]: [
      "package com.example;",
      "",
      "public class App {",
      "  public static String renderGreeting(String name) {",
      "    return \"Hello, \" + name;",
      "  }",
      "}",
    ].join("\n"),
    [paths.csharp]: [
      "var builder = WebApplication.CreateBuilder(args);",
      "var app = builder.Build();",
      "",
      "app.MapGet(\"/health\", () => Results.Ok(new { ok = true }));",
      "app.Run();",
    ].join("\n"),
    [paths.vue]: [
      "<template>",
      "  <button @click=\"count++\">{{ label }} {{ count }}</button>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "import { ref } from 'vue';",
      "const label = 'Pointer';",
      "const count = ref(0);",
      "</script>",
    ].join("\n"),
    [paths.svelte]: [
      "<script lang=\"ts\">",
      "  let count = 0;",
      "  export let label = 'Pointer';",
      "</script>",
      "",
      "<button on:click={() => count += 1}>{label} {count}</button>",
    ].join("\n"),
    [paths.css]: [
      ":root {",
      "  --pointer-pink: #ff2d8d;",
      "}",
      "",
      ".app-shell {",
      "  display: grid;",
      "  gap: 0.75rem;",
      "  color: var(--pointer-pink);",
      "}",
    ].join("\n"),
    [paths.markdown]: [
      "# Pointer E2E Fixture",
      "",
      "A deliberately polyglot workspace for IDE interaction tests.",
    ].join("\n"),
  };

  return {
    root: ROOT,
    files,
    initialStore: {
      onboarded: true,
      "settings.v1": {
        chatModel: "qwen2.5-coder:7b-instruct",
        agentModel: "qwen2.5-coder:7b-instruct",
        fimModel: "qwen2.5-coder:1.5b-base",
        embedModel: "nomic-embed-text",
        chatEnabled: true,
        agentEnabled: true,
        fimEnabled: true,
        indexingEnabled: true,
        inlineEditEnabled: true,
        ollamaAutostart: false,
        editorMinimap: false,
        editorStickyScroll: false,
        reduceMotion: true,
      },
      "session.v1": {
        root: ROOT,
        openTabs: [paths.app],
        activePath: paths.app,
        dockView: "assistant",
        fileTreeWidth: 280,
        rightDockWidth: 430,
      },
      "assistant.sessions.v1": [],
      "assistant.active.v1": null,
      "debug.breakpoints.v1": [
        {
          id: "bp_seed_app_9",
          path: paths.app,
          line: 9,
          enabled: true,
          createdAt: 1,
        },
      ],
      "debug.values.v1": [
        {
          id: "dbg_seed_title",
          name: "title",
          value: "Hello, Pointer",
          type: "string",
          path: paths.app,
          line: 5,
          scope: "render",
          createdAt: 1,
        },
      ],
    },
  };
}

function mockPointerDesktop(fixture: {
  root: string;
  files: Record<string, string>;
  initialStore: Record<string, unknown>;
}) {
  type TauriListener = { event: string; eventId: number; handler: number };
  type FsEntry = {
    name: string;
    path: string;
    is_dir: boolean;
    size: number | null;
    mtime?: number | null;
  };

  const files = new Map<string, string>(Object.entries(fixture.files));
  const dirs = new Set<string>([fixture.root]);
  const fixturePaths = {
    app: `${fixture.root}/src/App.tsx`,
    button: `${fixture.root}/src/components/Button.tsx`,
    greeting: `${fixture.root}/src/utils/greeting.ts`,
    router: `${fixture.root}/server/router.js`,
    python: `${fixture.root}/python/app.py`,
    rust: `${fixture.root}/rust/src/lib.rs`,
    go: `${fixture.root}/go/main.go`,
  };
  const stores = new Map<number, Map<string, unknown>>();
  const storePaths = new Map<string, number>();
  const listeners = new Map<string, TauriListener[]>();
  const callbacks = new Map<number, (data: unknown) => void>();
  const commandLog: Array<{ command: string; args: unknown; at: number }> = [];
  const unknownCommands: Array<{ command: string; args: unknown }> = [];
  let gitStatusOverride: Record<string, unknown> | null = null;
  let nextCallback = 1;
  let nextRid = 1;
  let nextEventId = 1;

  for (const path of files.keys()) {
    ensureParentDirs(path);
  }

  const bridge = {
    commandLog,
    unknownCommands,
    fixture,
    appReady: false,
    markAppReady: () => {
      bridge.appReady = true;
    },
    emitTauri,
    fs: {
      read: (path: string) => files.get(path),
      write: (path: string, content: string) => {
        files.set(path, content);
        ensureParentDirs(path);
      },
      entries: () => Array.from(files.keys()).sort(),
    },
    git: {
      setStatus: (status: Record<string, unknown> | null) => {
        gitStatusOverride = status;
      },
    },
  };
  (window as any).__POINTER_E2E__ = bridge;

  (window as any).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {
      path: { sep: "/", delimiter: ":" },
    },
    callbacks,
    transformCallback: (callback: (data: unknown) => void, once = false) => {
      const id = nextCallback++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        callback?.(data);
      });
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
    convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    invoke,
  };
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, id: number) => {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter(
          (listener) => listener.eventId !== id && listener.handler !== id,
        ),
      );
    },
  };

  async function invoke(command: string, args: any = {}) {
    commandLog.push({ command, args, at: Date.now() });

    if (command.startsWith("plugin:event|")) {
      return handleEventPlugin(command, args);
    }
    if (command.startsWith("plugin:store|")) {
      return handleStorePlugin(command, args);
    }
    if (command.startsWith("plugin:window|")) return null;
    if (command.startsWith("plugin:shell|")) return null;
    if (command.startsWith("plugin:dialog|")) return null;
    if (command.startsWith("plugin:fs|")) return handleFsPlugin(command, args);

    switch (command) {
      case "watch_workspace":
      case "unwatch_workspace":
        return null;
      case "read_workspace_tree":
        return readWorkspaceTree(args.path);
      case "read_text_file":
        return readTextFile(args.path);
      case "write_text_file":
        return writeTextFile(args.path, args.contents);
      case "create_file":
        return createFile(args.path);
      case "create_dir":
        return createDir(args.path);
      case "delete_path":
        return deletePath(args.path);
      case "rename_path":
        return renamePath(args.from, args.to);
      case "search_files":
        return searchFiles(args.query, args.limit ?? 50);
      case "search_directories":
        return searchDirectories(args.query, args.limit ?? 50);
      case "search_text":
        return searchText(args.query, args.limit ?? 200, args.options);
      case "replace_text":
        return { files_changed: 0, replacements: 0 };
      case "format_text":
        return { content: args.content, formatted: false, formatter: "e2e", error: null };
      case "workspace_brief":
        return {
          text: "Pointer E2E fixture: React/Vite frontend, Express server, FastAPI service, Rust, Go, Java, C#, Vue, Svelte, CSS, and Markdown files.",
          bytes: 148,
          generated_at: Date.now(),
        };
      case "project_check_detect":
        return { kind: "node", command: "npm test" };
      case "project_check_run":
        return {
          detected: { kind: "node", command: "npm test" },
          diagnostics: [],
          rawOutput: "e2e project check passed",
          exitCode: 0,
          timedOut: false,
        };
      case "lsp_status":
        return lspStatus();
      case "lsp_did_open":
      case "lsp_did_change":
        return null;
      case "lsp_hover":
        return lspHover(args.req);
      case "lsp_definition":
        return lspDefinition(args.req);
      case "lsp_references":
        return lspReferences(args.req);
      case "lsp_completion":
        return lspCompletion(args.req);
      case "lsp_completion_resolve":
        return lspCompletionResolve(args.req);
      case "lsp_document_symbols":
        return lspDocumentSymbols(args.doc);
      case "git_status_for_workspace":
        return gitStatus();
      case "git_blame_file":
        return [];
      case "git_branches":
        return [
          {
            name: "main",
            current: true,
            remote: false,
            last_commit: "E2E fixture",
            upstream: "origin/main",
          },
        ];
      case "git_log":
        return [];
      case "git_diff":
      case "git_show_file":
      case "git_stage":
      case "git_unstage":
      case "git_commit":
      case "git_push":
      case "git_pull":
      case "git_fetch":
      case "git_credential_respond":
      case "git_checkout":
      case "git_create_branch":
      case "git_create_branch_from":
      case "git_merge":
      case "git_merge_continue":
      case "git_merge_abort":
      case "git_rebase":
      case "git_rebase_continue":
      case "git_rebase_abort":
      case "git_discard":
        return "";
      case "terminal_open":
        return { id: args.id, shell: "/bin/zsh" };
      case "terminal_write":
      case "terminal_resize":
      case "terminal_close":
        return null;
      case "ollama_status":
        return {
          installed: true,
          running: true,
          version: "e2e",
          base_url: "http://127.0.0.1:11434",
        };
      case "ollama_list_models":
        return [
          { name: "qwen2.5-coder:7b-instruct", size: 4_700_000_000, modified_at: "2026-05-28T00:00:00Z" },
          { name: "qwen2.5-coder:1.5b-base", size: 1_100_000_000, modified_at: "2026-05-28T00:00:00Z" },
          { name: "nomic-embed-text", size: 274_000_000, modified_at: "2026-05-28T00:00:00Z" },
        ];
      case "ollama_ps":
        return [];
      case "inference_status":
        return { active: [], active_count: 0, updated_at_ms: Date.now() };
      case "inference_cancel":
      case "ollama_cancel":
      case "agent_cancel":
        return true;
      case "ollama_start":
      case "ollama_stop":
      case "ollama_unload_model":
      case "ollama_delete_model":
      case "ollama_install":
      case "ollama_pull":
      case "ollama_chat":
      case "ollama_embed":
      case "index_workspace":
      case "search_codebase":
      case "chunk_file":
        return null;
      case "ollama_generate":
        return ollamaGenerate(args.requestId, args.request);
      case "index_status":
        return { in_progress: false, indexed_files: 0, indexed_chunks: 0, root: fixture.root };
      case "recommend_models":
        return [];
      case "system_memory_gb":
        return 32;
      case "hardware_profile":
        return {
          cpu_count: 10,
          cpu_name: "E2E CPU",
          cpu_brand: "E2E CPU",
          total_ram_bytes: 34_359_738_368,
          available_ram_bytes: 20_000_000_000,
          swap_total: 0,
          gpu_label: "E2E GPU",
          os_name: "macOS",
          os_version: "15",
          host_name: "pointer-e2e",
          arch: "aarch64",
        };
      case "system_snapshot":
        return systemSnapshot();
      case "classify_file":
        return { kind: "plain", required_purpose: null, label: "Text", reason: null };
      case "process_file":
        return {
          kind: "plain",
          label: "Text",
          content: readTextFile(args.args.path),
          raw_bytes: readTextFile(args.args.path).length,
          used_model: false,
          model_name: null,
        };
      case "assistant_ask":
        return assistantAsk(args.requestId, args.request);
      case "agent_run":
        return agentRun(args.requestId, args.request);
      case "agent_continue":
        return agentRun(args.requestId, args.request);
      case "agent_execute_plan":
        return executePlan(args.requestId, args.request);
      case "agent_change_diff":
        return { before: "", after: files.get(fixturePaths.greeting) ?? "", binary: false };
      case "agent_undo_change":
      case "agent_keep_change":
      case "agent_purge_changes":
        return null;
      case "mcp_load_config":
        return { mcpServers: {} };
      case "mcp_save_config":
      case "mcp_upsert_server":
      case "mcp_remove_server":
        return args.config ?? { mcpServers: {} };
      case "mcp_list_servers":
        return [];
      case "mcp_start_server":
      case "mcp_restart_server":
        return {
          name: args.name,
          config: { command: "", args: [], env: {}, disabled: false },
          status: "ready",
          error: null,
          server_info: null,
          started_at_ms: Date.now(),
          tool_count: 0,
        };
      case "mcp_stop_server":
        return null;
      case "mcp_list_tools":
        return [];
      case "mcp_call_tool":
        return { result: null };
      case "mcp_get_logs":
        return [];
      case "ollama_library_catalog":
        return [];
      case "ollama_fast_apply":
        return { proposed: args.request?.original ?? "", validated: true, elapsed_ms: 1, chars_per_sec: 1000 };
      case "reset_app_state":
        return { steps: [] };
      case "kill_owned_process":
        return true;
      case "reveal_in_filer":
        return null;
      default:
        unknownCommands.push({ command, args });
        return null;
    }
  }

  function handleEventPlugin(command: string, args: any) {
    if (command === "plugin:event|listen") {
      const id = nextEventId++;
      const event = args.event;
      const list = listeners.get(event) ?? [];
      list.push({ event, eventId: id, handler: args.handler });
      listeners.set(event, list);
      return id;
    }
    if (command === "plugin:event|unlisten") {
      const event = args.event;
      const id = args.eventId ?? args.id;
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter(
          (listener) => listener.eventId !== id && listener.handler !== id,
        ),
      );
      return null;
    }
    if (command === "plugin:event|emit") {
      emitTauri(args.event, args.payload);
      return null;
    }
    return null;
  }

  function handleStorePlugin(command: string, args: any) {
    if (command === "plugin:store|load") {
      if (storePaths.has(args.path)) return storePaths.get(args.path);
      const rid = nextRid++;
      stores.set(rid, new Map(Object.entries(fixture.initialStore)));
      storePaths.set(args.path, rid);
      return rid;
    }
    if (command === "plugin:store|get_store") {
      return storePaths.get(args.path) ?? null;
    }
    const store = stores.get(args.rid);
    if (!store) return command.endsWith("|get") ? [null, false] : null;
    switch (command) {
      case "plugin:store|get": {
        const exists = store.has(args.key);
        return [exists ? store.get(args.key) : null, exists];
      }
      case "plugin:store|set":
        store.set(args.key, args.value);
        return null;
      case "plugin:store|has":
        return store.has(args.key);
      case "plugin:store|delete":
        return store.delete(args.key);
      case "plugin:store|clear":
      case "plugin:store|reset":
        store.clear();
        return null;
      case "plugin:store|keys":
        return Array.from(store.keys());
      case "plugin:store|values":
        return Array.from(store.values());
      case "plugin:store|entries":
        return Array.from(store.entries());
      case "plugin:store|length":
        return store.size;
      case "plugin:store|reload":
      case "plugin:store|save":
        return null;
      default:
        return null;
    }
  }

  function handleFsPlugin(_command: string, args: any) {
    const target = args.path ?? args.paths?.[0];
    if (!target) return null;
    if (files.has(target)) {
      return { isFile: true, isDirectory: false, size: files.get(target)?.length ?? 0 };
    }
    if (dirs.has(target)) {
      return { isFile: false, isDirectory: true, size: 0 };
    }
    throw new Error(`missing path: ${target}`);
  }

  function emitTauri(event: string, payload: unknown) {
    const list = listeners.get(event) ?? [];
    for (const listener of list) {
      callbacks.get(listener.handler)?.({
        event,
        id: listener.handler,
        payload,
      });
    }
  }

  function readWorkspaceTree(path: string): FsEntry[] {
    if (!dirs.has(path)) throw new Error(`not a directory: ${path}`);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children = new Map<string, FsEntry>();
    const now = Math.floor(Date.now() / 1000);
    for (const dir of dirs) {
      if (!dir.startsWith(prefix) || dir === path) continue;
      const rest = dir.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      children.set(dir, {
        name: rest,
        path: dir,
        is_dir: true,
        size: null,
        mtime: now,
      });
    }
    for (const [filePath, content] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      children.set(filePath, {
        name: rest,
        path: filePath,
        is_dir: false,
        size: content.length,
        mtime: now,
      });
    }
    return Array.from(children.values()).sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function readTextFile(path: string): string {
    if (!files.has(path)) throw new Error(`missing file: ${path}`);
    return files.get(path) ?? "";
  }

  function writeTextFile(path: string, contents: string) {
    files.set(path, contents ?? "");
    ensureParentDirs(path);
    emitTauri("fs:change", { kind: "write", paths: [path] });
    return null;
  }

  function createFile(path: string) {
    if (!files.has(path)) files.set(path, "");
    ensureParentDirs(path);
    emitTauri("fs:change", { kind: "create", paths: [path] });
    return null;
  }

  function createDir(path: string) {
    dirs.add(path);
    ensureParentDirs(path);
    emitTauri("fs:change", { kind: "create", paths: [path] });
    return null;
  }

  function deletePath(path: string) {
    files.delete(path);
    for (const filePath of Array.from(files.keys())) {
      if (filePath.startsWith(`${path}/`)) files.delete(filePath);
    }
    dirs.delete(path);
    for (const dir of Array.from(dirs)) {
      if (dir.startsWith(`${path}/`)) dirs.delete(dir);
    }
    emitTauri("fs:change", { kind: "delete", paths: [path] });
    return null;
  }

  function renamePath(from: string, to: string) {
    if (files.has(from)) {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
      ensureParentDirs(to);
    } else if (dirs.has(from)) {
      dirs.add(to);
      for (const dir of Array.from(dirs)) {
        if (dir.startsWith(`${from}/`)) {
          dirs.delete(dir);
          dirs.add(`${to}${dir.slice(from.length)}`);
        }
      }
      for (const [filePath, content] of Array.from(files.entries())) {
        if (filePath.startsWith(`${from}/`)) {
          files.delete(filePath);
          files.set(`${to}${filePath.slice(from.length)}`, content);
        }
      }
      dirs.delete(from);
    } else {
      throw new Error(`missing path: ${from}`);
    }
    emitTauri("fs:change", { kind: "rename", paths: [from, to] });
    return null;
  }

  function searchFiles(query = "", limit = 50) {
    const q = query.trim().toLowerCase();
    return Array.from(files.keys())
      .filter((path) => !q || basename(path).toLowerCase().includes(q) || path.toLowerCase().includes(q))
      .sort()
      .slice(0, limit)
      .map((path) => ({ path, name: basename(path) }));
  }

  function searchDirectories(query = "", limit = 50) {
    const q = query.trim().toLowerCase();
    return Array.from(dirs)
      .filter((path) => path !== fixture.root)
      .filter((path) => !q || basename(path).toLowerCase().includes(q) || path.toLowerCase().includes(q))
      .sort()
      .slice(0, limit)
      .map((path) => ({ path, name: basename(path) }));
  }

  function searchText(query = "", limit = 200, options: any = {}) {
    const hits: Array<{ path: string; line: number; text: string; col: number; match_len: number }> = [];
    let regex: RegExp | null = null;
    if (options?.regex) {
      try {
        regex = new RegExp(query, options.case_sensitive ? "" : "i");
      } catch {
        regex = null;
      }
    }
    const needle = options?.case_sensitive ? query : query.toLowerCase();
    for (const [path, content] of files) {
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        let col = -1;
        let len = query.length;
        if (regex) {
          const match = line.match(regex);
          if (!match) continue;
          col = match.index ?? 0;
          len = match[0].length;
        } else {
          const haystack = options?.case_sensitive ? line : line.toLowerCase();
          col = haystack.indexOf(needle);
          if (col < 0) continue;
          if (options?.whole_word) {
            const before = line[col - 1] ?? "";
            const after = line[col + query.length] ?? "";
            if (/\w/.test(before) || /\w/.test(after)) continue;
          }
        }
        hits.push({ path, line: index + 1, text: line, col, match_len: len });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  function lspStatus() {
    return [
      "tsx",
      "javascript",
      "typescript",
      "python",
      "rust",
      "go",
      "java",
      "csharp",
      "vue",
      "svelte",
      "css",
      "json",
    ].map((language) => ({
      language,
      label: language,
      status: language === "json" || language === "css" ? "monaco" : "ready",
      detail: "E2E language service ready",
      command: language === "json" || language === "css" ? null : `${language}-language-server`,
      source: "e2e",
      capabilities: ["completion", "definition", "hover", "diagnostics"],
    }));
  }

  function lspHover(req: any) {
    const word = wordAt(req.content, req.line, req.column);
    if (!word) return null;
    return {
      contents: `**${word}**\n\nE2E language service hover for ${word}.`,
      range: null,
    };
  }

  function lspDefinition(req: any) {
    const word = wordAt(req.content, req.line, req.column);
    if (word === "Button") return [loc(fixturePaths.button, 6, 17, 6, 23)];
    if (word === "renderGreeting" && req.language === "go") return [loc(fixturePaths.go, 5, 6, 5, 20)];
    if (word === "renderGreeting") return [loc(fixturePaths.greeting, 1, 17, 1, 31)];
    if (word === "makeRouter") return [loc(fixturePaths.router, 3, 17, 3, 27)];
    if (word === "health") return [loc(fixturePaths.python, 6, 5, 6, 11)];
    if (word === "render_greeting") return [loc(fixturePaths.rust, 1, 8, 1, 23)];
    return [];
  }

  function lspReferences(req: any) {
    const word = wordAt(req.content, req.line, req.column);
    if (!word) return [];
    return searchText(word, req.limit ?? 20, { whole_word: true, case_sensitive: true }).map((hit) =>
      loc(hit.path, hit.line, hit.col + 1, hit.line, hit.col + 1 + hit.match_len),
    );
  }

  function lspCompletion(_req: any) {
    return [
      completion("renderGreeting", "function renderGreeting(name: string): string", "Function"),
      completion("Button", "React component", "Class"),
      completion("makeRouter", "Express router factory", "Function"),
      completion("health", "FastAPI handler", "Function"),
    ];
  }

  function lspCompletionResolve(args: any) {
    return {
      ...args.item,
      documentation: args.item.documentation ?? `Resolved docs for ${args.item.label}`,
    };
  }

  function lspDocumentSymbols(doc: any) {
    const content = doc?.content ?? "";
    const symbols: any[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const match = line.match(/\b(function|class|const|def|fn|func)\s+([A-Za-z_]\w*)/);
      if (match) {
        const column = line.indexOf(match[2]) + 1;
        symbols.push({
          name: match[2],
          kind: 12,
          detail: match[1],
          line: index + 1,
          column,
          endLine: index + 1,
          endColumn: column + match[2].length,
          children: [],
        });
      }
    }
    return symbols;
  }

  function gitStatus() {
    return {
      is_repo: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      files: {},
      entries: [],
      dirty_count: 0,
      operation: null,
      error: null,
      ...(gitStatusOverride ?? {}),
    };
  }

  function systemSnapshot() {
    return {
      cpu_percent: 11,
      cpu_count: 10,
      mem_total: 34_359_738_368,
      mem_used: 12_000_000_000,
      swap_total: 0,
      swap_used: 0,
      uptime_secs: 120,
      host_name: "pointer-e2e",
      os_name: "macOS",
      processes: [],
      pointer_cpu_percent: 3,
      pointer_mem_bytes: 220_000_000,
    };
  }

  function assistantAsk(requestId: string, request: any) {
    window.setTimeout(() => {
      emitTauri(`ollama:chat:${requestId}`, {
        token:
          "App.tsx renders the Pointer E2E React shell. It imports Button and renderGreeting, builds a title, and wires the Launch button to log that title.",
      });
      emitTauri(`assistant:ledger:${request.session_id}`, {
        entry: {
          turn: 1,
          timestamp_ms: Date.now(),
          mode: "ask",
          kind: { type: "answered_only", summary: "Explained App.tsx" },
        },
        opencode_session_id: "oc_e2e_ask",
      });
      emitTauri(`ollama:chat:${requestId}`, { done: true, stats: {} });
    }, 120);
    return null;
  }

  function ollamaGenerate(requestId: string, request: any) {
    return new Promise((resolve) => {
      window.setTimeout(() => {
        const prompt = String(request?.prompt ?? "");
        const token = prompt.includes("Write a polished git commit message")
          ? "Improve source control workflow\n\n- Adds visual git operation controls\n- Drafts commit messages from file summaries"
          : "Adds visual git workflow support.";
        emitTauri(`ollama:gen:${requestId}`, { token });
        emitTauri(`ollama:gen:${requestId}`, { done: true, stats: {} });
        resolve(null);
      }, 10);
    });
  }

  function agentRun(requestId: string, request: any) {
    const isPlan = request.mode === "plan";
    window.setTimeout(() => {
      emitTauri(`agent:event:${requestId}`, {
        kind: "started",
        mode: request.mode ?? "auto",
        depth: 0,
        workspace: request.workspace ?? fixture.root,
        runtime: "opencode-e2e",
      });
      emitTauri(`agent:event:${requestId}`, {
        kind: "step_start",
        step: 1,
        model: request.model,
        elapsed_ms: 1,
      });
      emitTauri(`agent:event:${requestId}`, { kind: "first_token", step: 1, warmup_ms: 5 });
      if (isPlan) {
        emitTauri(`agent:event:${requestId}`, {
          kind: "tool_call",
          step: 1,
          tool: "read_file",
          attrs: { path: "src/App.tsx" },
          args: JSON.stringify({ path: fixturePaths.app }),
        });
        emitTauri(`agent:event:${requestId}`, {
          kind: "tool_result",
          step: 1,
          tool: "read_file",
          status: "ok",
          result: "Read src/App.tsx and related imports.",
          extra: { path: "src/App.tsx" },
        });
        emitTauri(`agent:event:${requestId}`, {
          kind: "plan",
          step: 1,
          text: [
            "1. Inspect `src/App.tsx` and its imported component boundaries.",
            "2. Add the requested UI component near the existing Button usage.",
            "3. Validate TypeScript diagnostics and run the project check.",
          ].join("\n"),
        });
        emitTauri(`agent:event:${requestId}`, {
          kind: "final",
          step: 1,
          text: "Plan ready. I inspected App.tsx and identified the component insertion path.",
        });
      } else {
        const next = `${readTextFile(fixturePaths.greeting)}\n\nexport function farewell(name: string): string {\n  return \`Goodbye, \${name}\`;\n}\n`;
        writeTextFile(fixturePaths.greeting, next);
        emitTauri(`agent:event:${requestId}`, {
          kind: "tool_result",
          step: 1,
          tool: "edit_file",
          status: "ok",
          result: "Updated src/utils/greeting.ts",
          extra: {
            path: "src/utils/greeting.ts",
            change: {
              id: "chg_greeting_1",
              step: 1,
              kind: "modify",
              path: "src/utils/greeting.ts",
              before_bytes: 70,
              after_bytes: next.length,
              status: "pending",
            },
          },
        });
        emitTauri(`agent:event:${requestId}`, {
          kind: "final",
          step: 1,
          text: "Implemented the greeting helper change and left it ready for review.",
        });
      }
      emitTauri(`agent:event:${requestId}`, {
        kind: "transcript_snapshot",
        messages: [
          { role: "user", content: request.goal ?? request.user_message ?? "agent task" },
          { role: "assistant", content: isPlan ? "Plan ready" : "Change implemented" },
        ],
        opencode_session_id: "oc_e2e_agent",
      });
      emitTauri(`agent:event:${requestId}`, {
        kind: "ledger_snapshot",
        entries: [
          {
            turn: 1,
            timestamp_ms: Date.now(),
            mode: isPlan ? "plan" : "agent",
            kind: { type: "answered_only", summary: isPlan ? "Planned change" : "Edited greeting helper" },
          },
        ],
      });
      emitTauri(`agent:event:${requestId}`, { kind: "done", termination: "completed", elapsed_ms: 20 });
    }, 30);
    return null;
  }

  function executePlan(requestId: string, request: any) {
    window.setTimeout(() => {
      emitTauri(`agent:event:${requestId}`, {
        kind: "started",
        mode: "auto",
        depth: 0,
        workspace: request.workspace ?? fixture.root,
        runtime: "opencode-e2e",
      });
      emitTauri(`agent:event:${requestId}`, { kind: "first_token", step: 1, warmup_ms: 5 });
      emitTauri(`agent:event:${requestId}`, {
        kind: "final",
        step: 1,
        text: "Executed the approved plan with the carried transcript and ledger.",
      });
      emitTauri(`agent:event:${requestId}`, { kind: "done", termination: "completed", elapsed_ms: 15 });
    }, 30);
    return null;
  }

  function ensureParentDirs(path: string) {
    const parts = path.split("/");
    let cursor = "";
    for (let i = 1; i < parts.length - 1; i += 1) {
      cursor += `/${parts[i]}`;
      if (cursor.startsWith(fixture.root)) dirs.add(cursor);
    }
  }

  function basename(path: string) {
    return path.split("/").pop() ?? path;
  }

  function wordAt(content: string, lineNumber: number, column: number) {
    const line = content.split(/\r?\n/)[lineNumber - 1] ?? "";
    let start = Math.max(0, column - 1);
    while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start -= 1;
    let end = Math.max(0, column - 1);
    while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end += 1;
    return line.slice(start, end);
  }

  function loc(path: string, line: number, column: number, endLine: number, endColumn: number) {
    return { path, line, column, endLine, endColumn };
  }

  function completion(label: string, detail: string, documentation: string) {
    return {
      label,
      detail,
      documentation,
      kind: 3,
      insertText: label,
      insertTextFormat: null,
      filterText: label,
      sortText: label,
      preselect: label === "renderGreeting",
      range: null,
      additionalTextEdits: [],
      data: null,
    };
  }
}

declare global {
  interface Window {
    __POINTER_E2E__?: {
      appReady?: boolean;
      commandLog?: Array<{ command: string; args: unknown; at: number }>;
      emitTauri?: (event: string, payload: unknown) => void;
      editor?: {
        activeTab?: () => unknown;
        openFile?: (path: string) => Promise<void>;
        language?: () => string | null;
        markers?: () => unknown[];
        visibleTokenClasses?: () => string[];
        triggerSuggest?: (line: number, column: number) => Promise<void>;
        gotoDefinitionAt?: (line: number, column: number) => Promise<string | null>;
      };
      assistant?: {
        pendingRefs?: () => unknown[];
      };
      git?: {
        setStatus?: (status: Record<string, unknown> | null) => void;
      };
      debug?: {
        breakpoints?: () => unknown[];
        values?: () => unknown[];
      };
    };
  }
}
