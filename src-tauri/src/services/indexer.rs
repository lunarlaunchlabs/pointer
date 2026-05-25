//! Local code index. Chunks files at function/class-like boundaries via simple
//! heuristics (we avoid tree-sitter's C-grammar build cost for v1), embeds chunks
//! via Ollama `nomic-embed-text`, and stores them in a SQLite database.
//!
//! Similarity search is implemented in pure Rust (cosine on stored f32 blobs).
//! This works well for typical project sizes; sqlite-vec can be wired in later.

use crate::services::merkle::MerkleSnapshot;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredChunk {
    pub chunk: Chunk,
    pub score: f32,
}

pub struct Indexer {
    pub state: Mutex<IndexState>,
    pub db: Mutex<Option<Connection>>,
}

pub struct IndexState {
    pub root: Option<PathBuf>,
    pub last_snapshot: Option<MerkleSnapshot>,
    pub indexed_files: usize,
    pub indexed_chunks: usize,
    pub in_progress: bool,
}

impl Indexer {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(IndexState {
                root: None,
                last_snapshot: None,
                indexed_files: 0,
                indexed_chunks: 0,
                in_progress: false,
            }),
            db: Mutex::new(None),
        }
    }

    pub fn open_db_for(&self, root: &Path) -> rusqlite::Result<()> {
        let dir = root.join(".pointer");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("index.sqlite");
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              path TEXT NOT NULL,
              start_line INTEGER NOT NULL,
              end_line INTEGER NOT NULL,
              language TEXT NOT NULL,
              text TEXT NOT NULL,
              embedding BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
            CREATE TABLE IF NOT EXISTS files (
              path TEXT PRIMARY KEY,
              hash TEXT NOT NULL
            );
            "#,
        )?;
        *self.db.lock() = Some(conn);
        Ok(())
    }
}

pub fn detect_language(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "cpp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "sh" | "bash" | "zsh" => "shell",
        _ => "text",
    }
}

/// Chunk a file at function/class-like boundaries with line-based heuristics.
/// Falls back to sliding-window chunks for non-code files.
pub fn chunk_text(path: &Path, text: &str) -> Vec<Chunk> {
    let language = detect_language(path).to_string();
    let path_str = path.display().to_string();
    let lines: Vec<&str> = text.lines().collect();
    let max_chunk_lines = 80usize;
    let min_chunk_lines = 6usize;
    let window_overlap = 8usize;

    let is_boundary = |line: &str| -> bool {
        let trimmed = line.trim_start();
        match language.as_str() {
            "rust" => trimmed.starts_with("fn ")
                || trimmed.starts_with("pub fn ")
                || trimmed.starts_with("pub(crate) fn ")
                || trimmed.starts_with("async fn ")
                || trimmed.starts_with("pub async fn ")
                || trimmed.starts_with("struct ")
                || trimmed.starts_with("pub struct ")
                || trimmed.starts_with("enum ")
                || trimmed.starts_with("impl ")
                || trimmed.starts_with("trait ")
                || trimmed.starts_with("mod "),
            "typescript" | "javascript" => trimmed.starts_with("export function ")
                || trimmed.starts_with("export async function ")
                || trimmed.starts_with("function ")
                || trimmed.starts_with("async function ")
                || trimmed.starts_with("export class ")
                || trimmed.starts_with("class ")
                || trimmed.starts_with("export const ")
                || trimmed.starts_with("export default ")
                || trimmed.starts_with("export interface ")
                || trimmed.starts_with("interface ")
                || trimmed.starts_with("type "),
            "python" => trimmed.starts_with("def ")
                || trimmed.starts_with("async def ")
                || trimmed.starts_with("class "),
            "go" => trimmed.starts_with("func ") || trimmed.starts_with("type "),
            _ => false,
        }
    };

    let mut chunks: Vec<Chunk> = vec![];
    let mut starts: Vec<usize> = vec![0];
    for (i, l) in lines.iter().enumerate() {
        if i > 0 && is_boundary(l) {
            starts.push(i);
        }
    }
    starts.push(lines.len());

    let mut boundaries: Vec<(usize, usize)> = starts
        .windows(2)
        .map(|w| (w[0], w[1]))
        .filter(|(a, b)| b > a)
        .collect();

    // Further split oversized blocks via sliding windows.
    let mut split_boundaries = vec![];
    for (a, b) in boundaries.drain(..) {
        if b - a <= max_chunk_lines {
            split_boundaries.push((a, b));
        } else {
            let mut s = a;
            while s < b {
                let e = (s + max_chunk_lines).min(b);
                split_boundaries.push((s, e));
                if e == b {
                    break;
                }
                s = e.saturating_sub(window_overlap);
            }
        }
    }

    for (a, b) in split_boundaries {
        if b - a < min_chunk_lines && chunks.last_mut().is_some() {
            if let Some(prev) = chunks.last_mut() {
                if prev.path == path_str {
                    let extra = lines[a..b].join("\n");
                    prev.text.push('\n');
                    prev.text.push_str(&extra);
                    prev.end_line = b;
                    continue;
                }
            }
        }
        let body = lines[a..b].join("\n");
        chunks.push(Chunk {
            path: path_str.clone(),
            start_line: a + 1,
            end_line: b,
            text: body,
            language: language.clone(),
        });
    }
    chunks
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    let n = a.len().min(b.len());
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

pub fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
