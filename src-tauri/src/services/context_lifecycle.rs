//! Context lifecycle helpers for local-model calls.
//!
//! Ollama itself does not carry conversation state across `/api/chat` or
//! `/api/generate` requests unless the caller sends it. Pointer owns that
//! lifecycle, so every caller should make the retained history explicit:
//! recent turns stay verbatim, older turns become a compact memory packet.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy)]
pub struct CompactOptions {
    pub max_total_chars: usize,
    pub recent_tail: usize,
    pub max_summary_chars: usize,
    pub max_message_chars: usize,
}

impl CompactOptions {
    pub fn ollama_chat() -> Self {
        Self {
            max_total_chars: 24_000,
            recent_tail: 12,
            max_summary_chars: 4_000,
            max_message_chars: 8_000,
        }
    }

    pub fn opencode_prompt() -> Self {
        Self {
            max_total_chars: 18_000,
            recent_tail: 8,
            max_summary_chars: 3_000,
            max_message_chars: 4_000,
        }
    }

    pub fn opencode_resume() -> Self {
        Self {
            max_total_chars: 12_000,
            recent_tail: 6,
            max_summary_chars: 2_400,
            max_message_chars: 2_400,
        }
    }
}

pub fn compact_dialogue(
    messages: &[CompactMessage],
    options: CompactOptions,
) -> Vec<CompactMessage> {
    if messages.is_empty() {
        return Vec::new();
    }

    let mut preserved_prefix = Vec::new();
    let mut body_start = 0usize;
    while body_start < messages.len() && messages[body_start].role.eq_ignore_ascii_case("system") {
        preserved_prefix.push(CompactMessage {
            role: messages[body_start].role.clone(),
            content: trim_message(&messages[body_start].content, options.max_message_chars),
        });
        body_start += 1;
    }

    let body = &messages[body_start..];
    let total_chars = messages.iter().map(|m| m.content.len()).sum::<usize>();
    let over_budget = total_chars > options.max_total_chars;
    let needs_tail_compaction = body.len() > options.recent_tail;
    let has_huge_message = messages
        .iter()
        .any(|m| m.content.len() > options.max_message_chars);

    if !over_budget && !needs_tail_compaction && !has_huge_message {
        return messages
            .iter()
            .map(|m| CompactMessage {
                role: m.role.clone(),
                content: trim_message(&m.content, options.max_message_chars),
            })
            .collect();
    }

    let tail_len = options.recent_tail.min(body.len());
    let split = body.len().saturating_sub(tail_len);
    let older = &body[..split];
    let recent = &body[split..];

    let mut out = preserved_prefix;
    if !older.is_empty() {
        out.push(CompactMessage {
            role: "system".into(),
            content: compacted_history_packet(older, options.max_summary_chars),
        });
    }
    for message in recent {
        out.push(CompactMessage {
            role: message.role.clone(),
            content: trim_message(&message.content, options.max_message_chars),
        });
    }
    out
}

pub fn compacted_history_packet(messages: &[CompactMessage], max_chars: usize) -> String {
    let mut out = String::from(
        "<compacted_context>\nPointer compacted older conversation turns to avoid stale or overflowing local-model context. Treat this as loose continuity, not source-code evidence.\n",
    );
    for message in messages {
        if out.len() >= max_chars {
            break;
        }
        let role = safe_role(&message.role);
        let line = format!(
            "- {}: {}\n",
            role,
            collapse_whitespace(&message.content, 280)
        );
        if out
            .len()
            .saturating_add(line.len())
            .saturating_add("</compacted_context>".len())
            > max_chars
        {
            out.push_str("…older turns omitted…\n");
            break;
        }
        out.push_str(&line);
    }
    out.push_str("</compacted_context>");
    out
}

pub fn trim_message(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        return content.to_string();
    }
    let keep_head = max_chars.saturating_mul(7) / 10;
    let keep_tail = max_chars.saturating_sub(keep_head).saturating_sub(80);
    let head = content.chars().take(keep_head).collect::<String>();
    let tail = content
        .chars()
        .rev()
        .take(keep_tail)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}\n…[Pointer compacted the middle of this message]…\n{tail}")
}

fn collapse_whitespace(content: &str, max_chars: usize) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let preview = collapsed.chars().take(max_chars).collect::<String>();
    format!("{preview}…")
}

fn safe_role(role: &str) -> &str {
    match role {
        "system" | "user" | "assistant" | "tool" => role,
        _ => "message",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> CompactMessage {
        CompactMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn keeps_short_dialogue_verbatim() {
        let messages = vec![msg("system", "rules"), msg("user", "hello")];
        assert_eq!(
            compact_dialogue(&messages, CompactOptions::ollama_chat()),
            messages
        );
    }

    #[test]
    fn compacts_older_turns_and_preserves_recent_tail() {
        let messages = vec![
            msg("system", "rules"),
            msg("user", "old one"),
            msg("assistant", "old two"),
            msg("user", "recent one"),
            msg("assistant", "recent two"),
        ];
        let out = compact_dialogue(
            &messages,
            CompactOptions {
                max_total_chars: 32,
                recent_tail: 2,
                max_summary_chars: 500,
                max_message_chars: 500,
            },
        );
        assert_eq!(out[0], msg("system", "rules"));
        assert_eq!(out[1].role, "system");
        assert!(out[1].content.contains("<compacted_context>"));
        assert!(out[1].content.contains("old one"));
        assert_eq!(out[2], msg("user", "recent one"));
        assert_eq!(out[3], msg("assistant", "recent two"));
    }

    #[test]
    fn trims_single_huge_recent_message() {
        let huge = "x".repeat(1000);
        let out = compact_dialogue(
            &[msg("user", &huge)],
            CompactOptions {
                max_total_chars: 10_000,
                recent_tail: 4,
                max_summary_chars: 500,
                max_message_chars: 100,
            },
        );
        assert!(out[0].content.len() < huge.len());
        assert!(out[0].content.contains("Pointer compacted"));
    }
}
