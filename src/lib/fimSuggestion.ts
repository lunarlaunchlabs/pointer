export type NormalizeFimSuggestionInput = {
  raw: string;
  prefix: string;
  suffix: string;
};

const FIM_TOKENS = [
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|endoftext|>",
  "<|file_sep|>",
  "<|im_end|>",
  "<｜fim▁begin｜>",
  "<｜fim▁hole｜>",
  "<｜fim▁end｜>",
  "<fim_prefix>",
  "<fim_suffix>",
  "<fim_middle>",
  "<PRE>",
  "<SUF>",
  "<MID>",
  "<EOT>",
];

const PROSE_PREFIX =
  /^(sure|here(?:'s| is)|the completion|i would|you can|this code)\b/i;

export function normalizeFimSuggestion({
  raw,
  prefix,
  suffix,
}: NormalizeFimSuggestionInput): string {
  let text = raw.replace(/\r\n?/g, "\n");

  for (const token of FIM_TOKENS) {
    text = text.split(token).join("");
  }

  text = stripMarkdownFence(text);
  text = stripPrefixEcho(text, prefix);
  text = stripSuffixEcho(text, suffix);

  if (!text.trim()) return "";
  if (PROSE_PREFIX.test(text.trimStart())) return "";

  return text;
}

function stripMarkdownFence(text: string): string {
  const fullFence = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fullFence) return fullFence[1] ?? "";

  return text
    .replace(/^\s*```[^\n]*\n?/, "")
    .replace(/\n?```\s*$/, "");
}

function stripPrefixEcho(text: string, prefix: string): string {
  const overlap = longestOverlap(prefix, text, Math.min(512, text.length));
  if (overlap < 2 && !isSingleCharEcho(prefix, text)) return text;
  return text.slice(Math.max(overlap, 1));
}

function stripSuffixEcho(text: string, suffix: string): string {
  if (!suffix) return text;
  const overlap = longestOverlap(text, suffix, Math.min(512, text.length));
  if (overlap <= 0) return text;
  return text.slice(0, text.length - overlap);
}

function longestOverlap(left: string, right: string, maxLength: number): number {
  const max = Math.min(left.length, right.length, maxLength);
  for (let length = max; length > 0; length--) {
    if (left.slice(left.length - length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

function isSingleCharEcho(prefix: string, text: string): boolean {
  if (!prefix || !text) return false;
  const char = prefix[prefix.length - 1];
  return char === text[0] && /[\])}"'`;]/.test(char);
}
