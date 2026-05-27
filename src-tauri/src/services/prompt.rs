//! Priompt-inspired prompt builder: pieces with priorities, dropped lowest-first
//! to fit a token budget. We approximate tokens as chars/4.
//!
//! The Rust-side builder is exposed for future server-side prompt assembly; the
//! TypeScript frontend has its own implementation in `src/lib/prompt.ts` that is
//! used today.

#![allow(dead_code)]

#[derive(Debug, Clone)]
pub struct Piece {
    pub priority: i32,
    pub text: String,
    pub tag: &'static str,
}

pub struct PromptBudget {
    pub max_tokens: usize,
    pieces: Vec<Piece>,
}

impl PromptBudget {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            pieces: vec![],
        }
    }
    pub fn push(&mut self, priority: i32, tag: &'static str, text: impl Into<String>) {
        self.pieces.push(Piece {
            priority,
            tag,
            text: text.into(),
        });
    }
    pub fn assemble(&self) -> (String, Vec<&'static str>) {
        let mut ordered: Vec<&Piece> = self.pieces.iter().collect();
        ordered.sort_by_key(|p| -p.priority);

        let budget_chars = self.max_tokens.saturating_mul(4);
        let mut included: Vec<&Piece> = vec![];
        let mut used = 0usize;
        for p in ordered {
            let cost = p.text.len() + 2;
            if used + cost <= budget_chars {
                included.push(p);
                used += cost;
            }
        }
        // Re-sort by original insertion order for assembly.
        included.sort_by_key(|p| {
            self.pieces
                .iter()
                .position(|q| std::ptr::eq(q, *p))
                .unwrap_or(0)
        });
        let mut out = String::with_capacity(used);
        let mut tags = vec![];
        for p in included {
            out.push_str(&p.text);
            out.push('\n');
            tags.push(p.tag);
        }
        (out, tags)
    }
}
