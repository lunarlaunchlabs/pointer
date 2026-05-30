import { create } from "@/lib/signalStore";
import type { StoppedLanguageServer } from "@/lib/ipc";

type RestartAnnouncement = {
  language: string;
  label: string;
};

type State = {
  idleStopped: Record<string, { label: string; stoppedAt: number }>;
  starting: Record<string, { label: string; startedAt: number }>;
  markIdleStopped: (servers: StoppedLanguageServer[]) => void;
  beginRestartIfIdleStopped: (language: string) => RestartAnnouncement | null;
  finishRestart: (language: string) => void;
  clear: () => void;
};

export const useLspRuntime = create<State>((set, get) => ({
  idleStopped: {},
  starting: {},
  markIdleStopped: (servers) => {
    if (servers.length === 0) return;
    const stoppedAt = Date.now();
    set((state) => {
      const next = { ...state.idleStopped };
      for (const server of servers) {
        next[normalizeRuntimeLanguage(server.language)] = {
          label: server.label,
          stoppedAt,
        };
      }
      return { idleStopped: next };
    });
  },
  beginRestartIfIdleStopped: (language) => {
    const key = normalizeRuntimeLanguage(language);
    const stopped = get().idleStopped[key];
    if (!stopped) return null;
    set((state) => {
      const idleStopped = { ...state.idleStopped };
      delete idleStopped[key];
      return {
        idleStopped,
        starting: {
          ...state.starting,
          [key]: { label: stopped.label, startedAt: Date.now() },
        },
      };
    });
    return { language: key, label: stopped.label };
  },
  finishRestart: (language) => {
    const key = normalizeRuntimeLanguage(language);
    set((state) => {
      if (!state.starting[key]) return state;
      const starting = { ...state.starting };
      delete starting[key];
      return { starting };
    });
  },
  clear: () => set({ idleStopped: {}, starting: {} }),
}));

export function normalizeRuntimeLanguage(language: string): string {
  switch (language) {
    case "typescriptreact":
    case "tsx":
    case "ts":
      return "typescript";
    case "javascriptreact":
    case "jsx":
    case "js":
      return "javascript";
    case "scss":
    case "less":
      return "css";
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "shell";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "cxx":
    case "cc":
      return "cpp";
    case "rb":
      return "ruby";
    case "mdx":
      return "markdown";
    case "gql":
      return "graphql";
    default:
      return language || "plaintext";
  }
}
