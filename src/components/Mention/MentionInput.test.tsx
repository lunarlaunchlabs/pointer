/**
 * MentionInput tests.
 *
 * The mirror overlay is the trickiest part: it has to render the same
 * text the textarea shows, but with mention tokens wrapped in styled
 * spans. We verify:
 *   • The mirror renders confirmed tokens with the `.pn-mention-token`
 *     class so the CSS can paint them.
 *   • Plain text (and any in-progress `@…` typing) stays unstyled.
 *   • The mirror updates as new tokens are registered.
 *   • Editing the textarea fires the onChange callback verbatim.
 */

import { useState } from "@/lib/preactSignalCompat";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MentionInput } from "./MentionInput";

describe("MentionInput", () => {
  it("renders tokens with the styled span and leaves the rest plain", () => {
    const { container } = render(
      <MentionInput
        value="fix @src/foo.ts please"
        onChange={() => {}}
        highlightTokens={["@src/foo.ts"]}
      />,
    );
    const tokens = container.querySelectorAll(".pn-mention-token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].textContent).toBe("@src/foo.ts");
    // The rest of the text is present in the mirror but unstyled.
    expect(container.textContent).toContain("fix");
    expect(container.textContent).toContain("please");
  });

  it("does NOT style the in-progress @query the user is still typing", () => {
    const { container } = render(
      <MentionInput
        value="look at @bar"
        onChange={() => {}}
        highlightTokens={["@src/foo.ts"]}
      />,
    );
    expect(container.querySelectorAll(".pn-mention-token")).toHaveLength(0);
  });

  it("highlights the longest matching token when multiple overlap", () => {
    const { container } = render(
      <MentionInput
        value="@src/foo.ts"
        onChange={() => {}}
        highlightTokens={["@src", "@src/foo.ts"]}
      />,
    );
    const tokens = container.querySelectorAll(".pn-mention-token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].textContent).toBe("@src/foo.ts");
  });

  it("fires onChange with the textarea value on input", async () => {
    const onChange = vi.fn();
    render(
      <MentionInput
        value=""
        onChange={onChange}
        highlightTokens={[]}
        placeholder="placeholder"
      />,
    );
    const ta = screen.getByPlaceholderText("placeholder");
    await userEvent.type(ta, "ab");
    // Preact preserves the textarea's DOM value between synthetic
    // keystrokes, so each change reports the actual visible text.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(
      "ab",
      expect.objectContaining({ selectionStart: 2, selectionEnd: 2 }),
    );
  });

  it("keeps normal typed text as the textarea's visible source of truth", async () => {
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <MentionInput
          value={value}
          onChange={(next) => setValue(next)}
          highlightTokens={[]}
          placeholder="composer"
        />
      );
    }

    render(<Harness />);
    const ta = screen.getByPlaceholderText("composer") as HTMLTextAreaElement;
    await userEvent.type(ta, "ask plan agent");
    expect(ta.value).toBe("ask plan agent");
  });

  it("handles an empty token list without crashing", () => {
    const { container } = render(
      <MentionInput
        value="no tokens here"
        onChange={() => {}}
        highlightTokens={[]}
      />,
    );
    expect(container.textContent).toContain("no tokens here");
    expect(container.querySelectorAll(".pn-mention-token")).toHaveLength(0);
  });
});
