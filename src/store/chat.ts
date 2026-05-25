/**
 * @deprecated Use `@/store/assistant` instead. This store is kept on
 * disk for one release window so the new `assistant.sessions.v1`
 * migration can re-run if it landed buggy in any user's profile.
 * The store is no longer wired into any view — it exists only so
 * `useAssistant.init()` can read `chat.sessions.v1` once on first
 * boot under the new build. Remove the entire file in the release
 * after migration is confirmed safe in the wild.
 */
import { create } from "zustand";
import { ipc, listenEvent, newRequestId } from "@/lib/ipc";
import { getItem, persistAsync } from "@/lib/persist";
import { getWorkspaceBrief } from "@/lib/workspaceBrief";
import { useWorkspace } from "@/store/workspace";

export type ChatRole = "system" | "user" | "assistant";
export type ReferenceKind =
  | "file"
  | "folder"
  | "selection"
  | "codebase"
  | "symbol"
  | "diagnostic"
  | "processed";

export type Reference =
  | { kind: "file"; path: string }
  /** A directory included as context — backend expands to a shallow listing. */
  | { kind: "folder"; path: string }
  | {
      kind: "selection";
      path: string;
      startLine: number;
      endLine: number;
      text: string;
    }
  | { kind: "codebase"; query: string }
  | { kind: "symbol"; path: string; name: string }
  /**
   * A diagnostic (lint / type / parse error) lifted from Monaco markers.
   * The exact code snippet at the reported range is included so the model
   * can quote the offending lines without us re-reading the file.
   */
  | {
      kind: "diagnostic";
      path: string;
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
      severity: "error" | "warning" | "info" | "hint";
      message: string;
      /** Where the diagnostic came from — "ts", "eslint", "json", etc. */
      source: string;
      /** Optional language-specific error code. */
      code?: string;
      /** The offending line(s) verbatim — small, prompt-ready. */
      snippet: string;
    }
  /**
   * A binary or document file that has already been processed by a vision /
   * document model. We carry the extracted text inline so the chat prompt
   * doesn't need to re-run ingestion on every turn.
   */
  | {
      kind: "processed";
      path: string;
      /** "image" | "pdf" | "spreadsheet" | "plain" */
      fileKind: string;
      /** Friendly label: "Image", "PDF", "Spreadsheet", etc. */
      label: string;
      /** The model that produced `content` (null when no model ran). */
      model: string | null;
      /** Extracted/summarised text, ready to embed in a prompt. */
      content: string;
      raw_bytes: number;
    };

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  references?: Reference[];
  streaming?: boolean;
};

/** A persisted chat conversation. The `model` is locked once the session has
 *  any turn — switching the global default in settings does NOT alter past
 *  sessions, so each conversation stays internally consistent. */
export type ChatSession = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type State = {
  hydrated: boolean;
  sessions: ChatSession[];
  activeSessionId: string | null;
  streamingId: string | null;
  currentRequest: string | null;
  pendingRefs: Reference[];

  init: () => Promise<void>;
  newSession: (model: string) => string;
  selectSession: (id: string | null) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  ensureActive: (defaultModel: string) => ChatSession;

  addRef: (r: Reference) => void;
  removeRef: (idx: number) => void;
  clearRefs: () => void;

  cancel: () => Promise<void>;
  clearActive: () => void;

  send: (
    text: string,
    opts: {
      defaultModel: string;
      buildContext: (refs: Reference[]) => Promise<string | undefined>;
    },
  ) => Promise<void>;

  // Selectors — convenient subscriptions.
  getActive: () => ChatSession | null;
};

const SESSIONS_KEY = "chat.sessions.v1";
const ACTIVE_KEY = "chat.active.v1";

let unlisten: undefined | (() => void);

export const useChat = create<State>((set, get) => ({
  hydrated: false,
  sessions: [],
  activeSessionId: null,
  streamingId: null,
  currentRequest: null,
  pendingRefs: [],

  init: async () => {
    const [sessions, active] = await Promise.all([
      getItem<ChatSession[]>(SESSIONS_KEY).catch(() => undefined),
      getItem<string | null>(ACTIVE_KEY).catch(() => null),
    ]);
    set({
      sessions: sessions ?? [],
      activeSessionId: active ?? null,
      hydrated: true,
    });
  },

  newSession: (model) => {
    const s: ChatSession = {
      id: `chat_${crypto.randomUUID().slice(0, 12)}`,
      title: "New chat",
      model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    set((st) => ({
      sessions: [s, ...st.sessions],
      activeSessionId: s.id,
      pendingRefs: [],
    }));
    flush(get());
    return s.id;
  },

  selectSession: (id) => {
    set({ activeSessionId: id, pendingRefs: [] });
    persistAsync(ACTIVE_KEY, id);
  },

  deleteSession: (id) => {
    const st = get();
    const next = st.sessions.filter((x) => x.id !== id);
    const activeSessionId =
      st.activeSessionId === id ? next[0]?.id ?? null : st.activeSessionId;
    set({ sessions: next, activeSessionId });
    flush(get());
  },

  renameSession: (id, title) => {
    set((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
      ),
    }));
    flush(get());
  },

  ensureActive: (defaultModel) => {
    const st = get();
    const found = st.sessions.find((s) => s.id === st.activeSessionId);
    if (found) return found;
    const id = get().newSession(defaultModel);
    return get().sessions.find((s) => s.id === id)!;
  },

  addRef: (r) => set((s) => ({ pendingRefs: [...s.pendingRefs, r] })),
  removeRef: (idx) =>
    set((s) => ({ pendingRefs: s.pendingRefs.filter((_, i) => i !== idx) })),
  clearRefs: () => set({ pendingRefs: [] }),

  cancel: async () => {
    const rid = get().currentRequest;
    if (rid) await ipc.ollamaCancel(rid);
  },

  clearActive: () => {
    const st = get();
    if (!st.activeSessionId) return;
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === st.activeSessionId
          ? { ...sess, messages: [], title: "New chat", updatedAt: Date.now() }
          : sess,
      ),
      pendingRefs: [],
      streamingId: null,
    }));
    flush(get());
  },

  send: async (text, { defaultModel, buildContext }) => {
    // Refuse to start a turn without a model — empty string means the user
    // has no chat model picked. The composer is already disabled in this
    // state, but defending here too keeps the store honest.
    if (!defaultModel) return;
    let active = get().ensureActive(defaultModel);
    if (!active.model) return;

    const refs = get().pendingRefs;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      references: refs.length ? refs : undefined,
    };
    appendMessage(set, get, active.id, userMsg);
    set({ pendingRefs: [] });

    // Auto-title from the first user turn.
    active = get().sessions.find((s) => s.id === active.id)!;
    if (active.messages.filter((m) => m.role === "user").length === 1) {
      const title = derivedTitle(text);
      get().renameSession(active.id, title);
    }

    const context = await buildContext(refs);
    // Fetch the workspace brief before building the system message so
    // the model sees what project it's looking at (name, top-level
    // listing, manifest highlights, README excerpt) without needing
    // to grep around first. Silent fallback to "" — we never want a
    // brief miss to block a chat send.
    const brief = await getWorkspaceBrief(useWorkspace.getState().root);
    const system = chatSystemPrompt(context, brief);

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      streaming: true,
    };
    appendMessage(set, get, active.id, assistantMsg);
    set({ streamingId: assistantMsg.id });

    // Build the history snapshot from the canonical store state — this avoids
    // accidentally double-counting the user message we already pushed via
    // appendMessage above.
    const sessionNow = get().sessions.find((s) => s.id === active.id)!;
    const history = sessionNow.messages
      .filter((m) => m.id !== assistantMsg.id)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const rid = newRequestId("chat");
    set({ currentRequest: rid });

    if (unlisten) unlisten();
    const off = await listenEvent<
      | { token: string }
      | { done: true }
      | { cancelled: true; done: true }
      | { error: string; done: true }
    >(`ollama:chat:${rid}`, (p) => {
      if ("token" in p) appendToken(set, get, active.id, assistantMsg.id, p.token);
      if ("error" in p)
        appendToken(set, get, active.id, assistantMsg.id, `\n\n_Error: ${p.error}_`);
      if ("done" in p && p.done) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id !== active.id
              ? sess
              : {
                  ...sess,
                  messages: sess.messages.map((m) =>
                    m.id === assistantMsg.id ? { ...m, streaming: false } : m,
                  ),
                  updatedAt: Date.now(),
                },
          ),
          streamingId: null,
          currentRequest: null,
        }));
        flush(get());
        off();
      }
    });
    unlisten = off;

    await ipc.ollamaChat(rid, {
      model: active.model,
      messages: history,
      system,
      // 0.2 hit the sweet spot in the offline harness: enough warmth
      // for natural prose, low enough to avoid the ordering/edge-case
      // regressions we saw at 0.3 with small local coders. Bump if
      // chats start feeling robotic; lower if logic regressions
      // creep back.
      temperature: 0.2,
    });
  },

  getActive: () => {
    const st = get();
    return st.sessions.find((s) => s.id === st.activeSessionId) ?? null;
  },
}));

function derivedTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? text;
  const trimmed = first.trim().slice(0, 64);
  return trimmed.length === 0 ? "New chat" : trimmed;
}

function appendMessage(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  msg: ChatMessage,
) {
  set((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id !== sessionId
        ? sess
        : {
            ...sess,
            messages: [...sess.messages, msg],
            updatedAt: Date.now(),
          },
    ),
  }));
  // Persist on user turns immediately; the streamed assistant turn flushes on `done`.
  if (msg.role === "user") flush(get());
}

function appendToken(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  msgId: string,
  token: string,
) {
  void get;
  set((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id !== sessionId
        ? sess
        : {
            ...sess,
            messages: sess.messages.map((m) =>
              m.id === msgId ? { ...m, content: m.content + token } : m,
            ),
          },
    ),
  }));
}

function flush(s: State) {
  // Trim messages we'd never need (kept simple — full history per session).
  persistAsync(SESSIONS_KEY, s.sessions);
  persistAsync(ACTIVE_KEY, s.activeSessionId);
}

function chatSystemPrompt(context?: string, brief?: string): string {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

BEFORE WRITING CODE, think briefly (silently) about:
  - what's the smallest patch that satisfies the request,
  - which edge cases (empty inputs, invalid arguments, ordering of
    checks) the user cares about,
  - whether new guards must run BEFORE existing returns to actually
    fire — placing them last makes them unreachable.
Then produce a single, self-consistent edit.

OUTPUT FORMAT FOR CODE CHANGES — these are the ONLY shapes Pointer's
parser accepts. Anything else is silently dropped, so the user sees
nothing happen. Treat this as a hard contract.

1. EDIT an existing file. Required when modifying a file the user
   already has. The SEARCH block MUST match the file byte-for-byte
   (whitespace, indentation, line endings included), and the path is
   REQUIRED on the SAME line as the word SEARCH.

   <<<<<<< SEARCH path/to/file
   ...exact existing text...
   =======
   ...replacement text...
   >>>>>>> REPLACE

2. CREATE a new file. Use either an empty-SEARCH SEARCH/REPLACE block,
   OR a <file> tag — both go through the same code path.

   <<<<<<< SEARCH path/to/new_file
   =======
   ENTIRE FILE CONTENTS HERE
   >>>>>>> REPLACE

   <file path="path/to/new_file">
   ENTIRE FILE CONTENTS HERE
   </file>

HARD RULES

- NEVER reply with the full updated file inside a triple-backtick
  fence ( \`\`\`lang path \`\`\` ). The parser ignores fenced blocks;
  the user sees no change. If you only want to change a few lines, use
  a SEARCH/REPLACE block targeting JUST those lines. If you really do
  need to rewrite the whole file, use the create-file form above.
- NEVER include narration INSIDE the SEARCH/REPLACE markers. Put
  prose explanations BEFORE or AFTER the block, never between the
  markers.
- Match the workspace's existing module system, language, naming, and
  import style. If the workspace brief shows ESM ("type": "module"),
  use \`export\`/\`import\`. If it shows CommonJS, use
  \`module.exports\`/\`require\`. Never mix the two.
- Paths are relative to the workspace root unless absolute. Use forward
  slashes. Always include the path on every edit/create block.

${brief && brief.trim().length ? "Workspace brief — a compact snapshot of the project the user has open. Use it for orientation; if you need more, ask or wait for the next turn.\n\n" + brief + "\n" : ""}${context ? "User-provided context follows.\n\n" + context : ""}`;
}
