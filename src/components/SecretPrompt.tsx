import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, X } from "lucide-react";

type SecretPromptOptions = {
  title: string;
  prompt: string;
  secret?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

type Pending = SecretPromptOptions & {
  resolve: (value: string | null) => void;
};

type Listener = (prompt: Pending | null) => void;
const listeners = new Set<Listener>();
let current: Pending | null = null;

function setCurrent(prompt: Pending | null) {
  current = prompt;
  for (const listener of listeners) listener(prompt);
}

export function secretPrompt(opts: SecretPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (current) current.resolve(null);
    setCurrent({ ...opts, resolve });
  });
}

export function SecretPromptHost() {
  const [prompt, setPrompt] = useState<Pending | null>(current);
  const [value, setValue] = useState("");

  useEffect(() => {
    const listener: Listener = (next) => {
      setPrompt(next);
      setValue("");
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const cancel = useCallback(() => {
    if (!prompt) return;
    prompt.resolve(null);
    setCurrent(null);
  }, [prompt]);

  const submit = useCallback(() => {
    if (!prompt) return;
    prompt.resolve(value);
    setCurrent(null);
  }, [prompt, value]);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, cancel, submit]);

  if (!prompt) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-pn-modal flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <form
        className="w-[460px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="secret-prompt-title"
      >
        <header className="px-5 py-4 border-b border-noir-line flex items-start gap-3">
          <KeyRound
            size={16}
            className="text-noir-accent shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h3
              id="secret-prompt-title"
              className="font-sans text-[14px] text-noir-text leading-tight"
            >
              {prompt.title}
            </h3>
            <p className="mt-1 text-[11.5px] text-noir-mute leading-relaxed">
              Git is waiting for input. Pointer will pass this directly to the
              running Git process.
            </p>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="p-1 -m-1 text-noir-mute hover:text-noir-text shrink-0"
            aria-label="Cancel"
            title="Cancel (Esc)"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>
        <div className="px-5 py-4 space-y-3">
          <pre className="whitespace-pre-wrap break-words rounded border border-noir-line/70 bg-noir-canvas/70 px-3 py-2 text-[11px] font-mono text-noir-subtext">
            {prompt.prompt}
          </pre>
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            type={prompt.secret === false ? "text" : "password"}
            className="pn-input w-full font-mono"
            placeholder={prompt.secret === false ? "Response" : "Passphrase"}
            aria-label={prompt.secret === false ? "Git prompt response" : "Git passphrase"}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <footer className="px-5 py-3 border-t border-noir-line bg-noir-canvas/30 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="px-3 py-1.5 rounded border border-noir-line text-[12px] text-noir-subtext hover:text-noir-text hover:border-noir-subtext/40"
          >
            {prompt.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="submit"
            className="px-3 py-1.5 rounded bg-noir-accent text-white text-[12px] hover:bg-noir-accent/90"
          >
            {prompt.confirmLabel ?? "Continue"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
