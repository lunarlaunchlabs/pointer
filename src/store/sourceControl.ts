import { create } from "@/lib/signalStore";
import type { CommitGenerationMemory } from "@/lib/gitWorkflow";

export type SourceControlOutput = {
  kind: "info" | "error";
  body: string;
};

type State = {
  workspaceRoot: string;
  commitMessage: string;
  commitDraft: CommitGenerationMemory | null;
  output: SourceControlOutput | null;
  setWorkspaceRoot: (root: string) => void;
  setCommitMessage: (message: string) => void;
  setCommitDraft: (draft: CommitGenerationMemory | null) => void;
  setOutput: (output: SourceControlOutput | null) => void;
  resetComposer: () => void;
};

export const useSourceControl = create<State>((set, get) => ({
  workspaceRoot: "",
  commitMessage: "",
  commitDraft: null,
  output: null,

  setWorkspaceRoot: (root) => {
    if (get().workspaceRoot === root) return;
    set({
      workspaceRoot: root,
      commitMessage: "",
      commitDraft: null,
      output: null,
    });
  },
  setCommitMessage: (commitMessage) => set({ commitMessage }),
  setCommitDraft: (commitDraft) => set({ commitDraft }),
  setOutput: (output) => set({ output }),
  resetComposer: () => set({ commitMessage: "", commitDraft: null }),
}));
