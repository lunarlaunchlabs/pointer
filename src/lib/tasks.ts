import { ipc } from "@/lib/ipc";

/**
 * Workspace task — analogous to a single VS Code `tasks.json`
 * entry, deliberately simplified to the fields users actually
 * touch.
 *
 *   label    – name shown in the picker
 *   command  – shell line passed straight to the user's shell
 *   cwd      – optional, relative to workspace root if not absolute
 *   group    – optional category for visual grouping
 *
 * We don't model "problem matchers", "dependsOn", or "presentation"
 * because the average user never reads them and they're a constant
 * source of footguns. Power users can chain shell commands.
 */
export type WorkspaceTask = {
  label: string;
  command: string;
  cwd?: string;
  group?: string;
};

const TASKS_FILENAME = ".pointer/tasks.json";

const SEED: WorkspaceTask[] = [
  { label: "Build", command: "npm run build", group: "build" },
  { label: "Test", command: "npm test", group: "test" },
  { label: "Dev", command: "npm run dev", group: "watch" },
];

/** Load workspace tasks from `.pointer/tasks.json`. Returns an empty
 *  array if the file doesn't exist or is malformed — surfacing a
 *  parse error here is more noise than signal, so the caller can
 *  treat "no tasks" uniformly. */
export async function loadWorkspaceTasks(
  workspaceRoot: string | null,
): Promise<WorkspaceTask[]> {
  if (!workspaceRoot) return [];
  const target = `${workspaceRoot}/${TASKS_FILENAME}`;
  try {
    const text = await ipc.readTextFile(target);
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json
        .filter(
          (t): t is WorkspaceTask =>
            typeof t === "object" &&
            t !== null &&
            typeof t.label === "string" &&
            typeof t.command === "string",
        )
        .map((t) => ({
          label: t.label,
          command: t.command,
          cwd: typeof t.cwd === "string" ? t.cwd : undefined,
          group: typeof t.group === "string" ? t.group : undefined,
        }));
    }
    return [];
  } catch {
    return [];
  }
}

/** Create or open `.pointer/tasks.json`, seeding a minimal example
 *  if none exists. Mirrors how VS Code's "Configure Tasks" command
 *  bootstraps the file. */
export async function ensureWorkspaceTasksFile(
  workspaceRoot: string,
): Promise<string> {
  const target = `${workspaceRoot}/${TASKS_FILENAME}`;
  try {
    await ipc.readTextFile(target);
  } catch {
    try {
      await ipc.createDir(`${workspaceRoot}/.pointer`);
    } catch {
      /* dir may already exist; ignore */
    }
    await ipc.writeTextFile(target, JSON.stringify(SEED, null, 2));
  }
  return target;
}
