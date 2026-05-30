import { create } from "@/lib/signalStore";
import { ipc } from "@/lib/ipc";

export type ModelWorkflowStatus = "running" | "cancelling";

export type ModelWorkflowKind =
  | "git_commit"
  | "assistant"
  | "agent"
  | "plan"
  | "other";

export type ModelWorkflow = {
  id: string;
  kind: ModelWorkflowKind;
  title: string;
  startedAtMs: number;
  updatedAtMs: number;
  status: ModelWorkflowStatus;
  currentStep: string;
  activeRequestIds: string[];
  completedSteps: number;
  totalSteps?: number;
};

type StartWorkflowInput = {
  id: string;
  kind: ModelWorkflowKind;
  title: string;
  currentStep?: string;
  totalSteps?: number;
};

type State = {
  workflows: ModelWorkflow[];
  startWorkflow: (input: StartWorkflowInput) => void;
  updateWorkflow: (
    id: string,
    patch: Partial<
      Pick<ModelWorkflow, "currentStep" | "completedSteps" | "totalSteps">
    >,
  ) => void;
  attachRequest: (id: string, requestId: string, currentStep?: string) => void;
  detachRequest: (id: string, requestId: string) => void;
  finishWorkflow: (id: string) => void;
  cancelWorkflow: (id: string) => Promise<number>;
  isCancelling: (id: string) => boolean;
};

export const useModelWorkflows = create<State>((set, get) => ({
  workflows: [],

  startWorkflow: (input) => {
    const now = Date.now();
    const workflow: ModelWorkflow = {
      id: input.id,
      kind: input.kind,
      title: input.title,
      startedAtMs: now,
      updatedAtMs: now,
      status: "running",
      currentStep: input.currentStep ?? input.title,
      activeRequestIds: [],
      completedSteps: 0,
      totalSteps: input.totalSteps,
    };
    set((state) => ({
      workflows: [
        ...state.workflows.filter((item) => item.id !== input.id),
        workflow,
      ],
    }));
  },

  updateWorkflow: (id, patch) => {
    set((state) => ({
      workflows: state.workflows.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              updatedAtMs: Date.now(),
            }
          : item,
      ),
    }));
  },

  attachRequest: (id, requestId, currentStep) => {
    set((state) => ({
      workflows: state.workflows.map((item) =>
        item.id === id
          ? {
              ...item,
              currentStep: currentStep ?? item.currentStep,
              updatedAtMs: Date.now(),
              activeRequestIds: unique([...item.activeRequestIds, requestId]),
            }
          : item,
      ),
    }));
  },

  detachRequest: (id, requestId) => {
    set((state) => ({
      workflows: state.workflows.map((item) =>
        item.id === id
          ? {
              ...item,
              updatedAtMs: Date.now(),
              activeRequestIds: item.activeRequestIds.filter(
                (candidate) => candidate !== requestId,
              ),
            }
          : item,
      ),
    }));
  },

  finishWorkflow: (id) => {
    set((state) => ({
      workflows: state.workflows.filter((item) => item.id !== id),
    }));
  },

  cancelWorkflow: async (id) => {
    const workflow = get().workflows.find((item) => item.id === id);
    if (!workflow) return 0;
    set((state) => ({
      workflows: state.workflows.map((item) =>
        item.id === id
          ? { ...item, status: "cancelling", updatedAtMs: Date.now() }
          : item,
      ),
    }));
    const requestIds = [...workflow.activeRequestIds];
    await Promise.all(
      requestIds.map((requestId) =>
        ipc.inferenceCancel(requestId).catch(() => false),
      ),
    );
    return requestIds.length;
  },

  isCancelling: (id) =>
    get().workflows.some(
      (item) => item.id === id && item.status === "cancelling",
    ),
}));

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}
