import { languageFromPath } from "@/lib/lang";

export type DebugCapability = {
  language: string;
  label: string;
  adapter: string;
  installHint: string;
  launchKinds: string[];
  frameworks: string[];
};

const BASE: DebugCapability[] = [
  {
    language: "javascript",
    label: "JavaScript / Node / browser",
    adapter: "js-debug",
    installHint: "Bundled in VS Code; Pointer can drive js-debug when the adapter is installed.",
    launchKinds: ["node", "browser", "test"],
    frameworks: ["node", "vite", "next", "react", "jest", "vitest"],
  },
  {
    language: "typescript",
    label: "TypeScript / Node / browser",
    adapter: "js-debug",
    installHint: "Use js-debug with source maps enabled.",
    launchKinds: ["node", "browser", "test"],
    frameworks: ["node", "vite", "next", "react", "jest", "vitest"],
  },
  {
    language: "python",
    label: "Python",
    adapter: "debugpy",
    installHint: "Install debugpy in the active Python environment.",
    launchKinds: ["script", "module", "pytest"],
    frameworks: ["django", "flask", "fastapi", "pytest"],
  },
  {
    language: "rust",
    label: "Rust",
    adapter: "CodeLLDB / lldb-dap",
    installHint: "Install CodeLLDB or ensure lldb-dap is on PATH.",
    launchKinds: ["cargo run", "cargo test"],
    frameworks: ["cargo", "tokio", "tauri"],
  },
  {
    language: "go",
    label: "Go",
    adapter: "dlv dap",
    installHint: "Install Delve (`go install github.com/go-delve/delve/cmd/dlv@latest`).",
    launchKinds: ["package", "test"],
    frameworks: ["go test", "go run"],
  },
  {
    language: "csharp",
    label: ".NET",
    adapter: "netcoredbg",
    installHint: "Install netcoredbg or use a compatible C# debug adapter.",
    launchKinds: ["project", "test"],
    frameworks: ["aspnet", "xunit", "nunit"],
  },
  {
    language: "java",
    label: "Java",
    adapter: "java-debug",
    installHint: "Install the Java debug server and language support.",
    launchKinds: ["class", "test"],
    frameworks: ["maven", "gradle", "spring"],
  },
  {
    language: "php",
    label: "PHP",
    adapter: "xdebug",
    installHint: "Install Xdebug and configure a debug listener.",
    launchKinds: ["listen", "script"],
    frameworks: ["laravel", "symfony", "phpunit"],
  },
  {
    language: "ruby",
    label: "Ruby",
    adapter: "rdbg",
    installHint: "Install the debug gem (`bundle add debug`).",
    launchKinds: ["script", "test", "rails"],
    frameworks: ["rails", "rspec", "minitest"],
  },
];

export function debuggerCapabilitiesForPath(path: string): DebugCapability[] {
  const language = languageFromPath(path);
  const normal = normalize(language);
  return BASE.filter((cap) => cap.language === normal);
}

export function inferDebuggerCapabilities(files: string[]): DebugCapability[] {
  const langs = new Set(files.map((file) => normalize(languageFromPath(file))));
  const manifestText = files.join("\n").toLowerCase();
  const out = BASE.filter((cap) => langs.has(cap.language));

  if (/package\.json|vite\.config|next\.config|jest\.config|vitest\.config/.test(manifestText)) {
    pushUnique(out, BASE.find((cap) => cap.language === "typescript"));
  }
  if (/pyproject\.toml|requirements\.txt|manage\.py|pytest\.ini/.test(manifestText)) {
    pushUnique(out, BASE.find((cap) => cap.language === "python"));
  }
  if (/cargo\.toml|src-tauri\/cargo\.toml/.test(manifestText)) {
    pushUnique(out, BASE.find((cap) => cap.language === "rust"));
  }
  if (/go\.mod/.test(manifestText)) pushUnique(out, BASE.find((cap) => cap.language === "go"));
  if (/\.csproj|\.sln/.test(manifestText)) pushUnique(out, BASE.find((cap) => cap.language === "csharp"));
  if (/pom\.xml|build\.gradle/.test(manifestText)) pushUnique(out, BASE.find((cap) => cap.language === "java"));
  if (/composer\.json/.test(manifestText)) pushUnique(out, BASE.find((cap) => cap.language === "php"));
  if (/gemfile|\.gemspec/.test(manifestText)) pushUnique(out, BASE.find((cap) => cap.language === "ruby"));

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function pushUnique(list: DebugCapability[], cap: DebugCapability | undefined) {
  if (!cap || list.some((item) => item.language === cap.language)) return;
  list.push(cap);
}

function normalize(language: string): string {
  if (language === "javascriptreact" || language === "jsx") return "javascript";
  if (language === "typescriptreact" || language === "tsx") return "typescript";
  if (language === "csharp") return "csharp";
  return language;
}
