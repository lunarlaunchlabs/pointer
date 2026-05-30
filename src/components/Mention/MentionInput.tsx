/**
 * Textarea + mirror overlay that visually highlights mention tokens.
 *
 * Why a mirror? Native `<textarea>` doesn't support inline rich text.
 * Instead, we stack a transparent textarea on top of an aria-hidden
 * `<div>` that re-renders the same text with mention spans styled as
 * coloured chips. As long as both layers share font / sizing / line-
 * height / padding, the highlights track the textarea content exactly.
 *
 * The mirror only paints *confirmed* tokens (ones that match a registered
 * mention string, supplied by the parent). The in-progress `@query` the
 * user is still typing is intentionally NOT styled — that's the picker's
 * job, and bouncing the colour around would feel jittery.
 */

import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "@/lib/preactSignalCompat";
import { buildMentionRegex } from "@/lib/mentions";

export type MentionInputSelection = {
  selectionStart: number;
  selectionEnd: number;
};

export type MentionInputProps = {
  value: string;
  onChange: (next: string, selection: MentionInputSelection) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  /** Tokens to highlight in the mirror. Order doesn't matter; the
   *  matcher dedupes & sorts them by length (longest first). */
  highlightTokens: string[];
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  /** Maximum height in pixels — beyond this the textarea scrolls. */
  maxHeightPx?: number;
  /** Optional className for the wrapping container (positioning etc.). */
  className?: string;
  /** Optional className applied to the textarea itself (z-index, etc). */
  textareaClassName?: string;
  /** Optional aria-label for screen readers. */
  ariaLabel?: string;
};

export const MentionInput = forwardRef<HTMLTextAreaElement, MentionInputProps>(
  function MentionInput(
    {
      value,
      onChange,
      onKeyDown,
      highlightTokens,
      placeholder,
      disabled,
      rows = 1,
      maxHeightPx = 200,
      className,
      textareaClassName,
      ariaLabel,
    },
    forwardedRef,
  ) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const mirrorRef = useRef<HTMLDivElement | null>(null);

    const setTextAreaRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        taRef.current = node;
        if (typeof forwardedRef === "function") {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef],
    );

    useLayoutEffect(() => {
      resizeTextarea(taRef.current, maxHeightPx);
    }, [maxHeightPx, value]);

    // Autosize the textarea on every change (capped by maxHeightPx). We
    // also re-measure in a layout effect above so programmatic clears
    // (send/cancel/session switches) collapse the input immediately.
    const onChangeInternal = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;
      onChange(ta.value, {
        selectionStart: ta.selectionStart,
        selectionEnd: ta.selectionEnd,
      });
      resizeTextarea(ta, maxHeightPx);
    };

    // Sync mirror's scroll position with the textarea — when the user
    // scrolls a long composer, the highlights need to scroll too.
    const onScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
      if (mirrorRef.current) {
        mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
        mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
      }
    };

    const segments = useMemo(
      () => segmentize(value, highlightTokens),
      [value, highlightTokens],
    );

    return (
      <div className={`pn-mention-input relative ${className ?? ""}`}>
        {/* Mirror layer — aria-hidden because the textarea is the
            interactive surface; screen readers read the textarea. */}
        <div
          ref={mirrorRef}
          aria-hidden
          className="pn-mention-mirror absolute inset-0 pointer-events-none select-none overflow-hidden whitespace-pre-wrap break-words"
        >
          {segments.map((seg, i) =>
            seg.token ? (
              <span key={i} className="pn-mention-token">
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
          {/* Force a trailing newline so the textarea's height grows
              past the last printable line — same trick contenteditable
              implementations use to keep the caret line visible. */}
          <span>{"\u200B"}</span>
        </div>
        <textarea
          ref={setTextAreaRef}
          value={value}
          onChange={onChangeInternal}
          onKeyDown={onKeyDown}
          onScroll={onScroll}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          className={`pn-mention-textarea relative bg-transparent text-noir-text caret-noir-text outline-none resize-none placeholder-noir-mute ${textareaClassName ?? ""}`}
        />
      </div>
    );
  },
);

function resizeTextarea(
  ta: HTMLTextAreaElement | null,
  maxHeightPx: number,
) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, maxHeightPx)}px`;
  ta.style.overflowY = ta.scrollHeight > maxHeightPx ? "auto" : "hidden";
}

/** Split `text` into segments — each segment is either a literal run or
 *  a mention token. Used by the mirror to wrap tokens in styled spans. */
function segmentize(
  text: string,
  tokens: string[],
): { text: string; token: boolean }[] {
  if (tokens.length === 0 || !text) {
    return [{ text, token: false }];
  }
  const re = buildMentionRegex(tokens);
  const out: { text: string; token: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index!;
    if (start > last) out.push({ text: text.slice(last, start), token: false });
    out.push({ text: m[0], token: true });
    last = start + m[0].length;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last), token: false });
  }
  return out;
}
