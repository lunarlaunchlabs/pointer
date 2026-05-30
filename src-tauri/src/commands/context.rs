use crate::error::{AppError, AppResult};
use crate::services::indexer::{blob_to_vec, chunk_text, cosine, vec_to_blob, Chunk, ScoredChunk};
use crate::services::inference::{acquire_inference, InferenceClaim, InferencePolicy};
use crate::services::merkle::MerkleSnapshot;
use crate::services::workspace_filter::workspace_walker;
use crate::state::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

const EMBED_MODEL_DEFAULT: &str = "nomic-embed-text";
const MAX_EMBED_BATCH: usize = 16;

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexStatus {
    pub in_progress: bool,
    pub indexed_files: usize,
    pub indexed_chunks: usize,
    pub root: Option<String>,
}

#[tauri::command]
pub async fn index_status(state: State<'_, AppState>) -> AppResult<IndexStatus> {
    let st = state.indexer.state.lock();
    Ok(IndexStatus {
        in_progress: st.in_progress,
        indexed_files: st.indexed_files,
        indexed_chunks: st.indexed_chunks,
        root: st.root.as_ref().map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub async fn chunk_file(path: String) -> AppResult<Vec<Chunk>> {
    let bytes = std::fs::read(&path)?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(chunk_text(Path::new(&path), &text))
}

#[derive(Debug, Deserialize)]
pub struct IndexRequest {
    pub root: String,
    #[serde(default)]
    pub embed_model: Option<String>,
}

#[tauri::command]
pub async fn index_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    request: IndexRequest,
) -> AppResult<()> {
    let model = request
        .embed_model
        .unwrap_or_else(|| EMBED_MODEL_DEFAULT.to_string());
    let root = PathBuf::from(&request.root);
    if !root.is_dir() {
        return Err(AppError::Msg("workspace root is not a directory".into()));
    }
    state.indexer.open_db_for(&root)?;
    let request_id = format!("index_{}", uuid::Uuid::new_v4().simple());
    let _permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id.clone(),
            model.clone(),
            "indexing",
            format!("Index {}", root.display()),
        ),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&request_id);
    {
        let mut st = state.indexer.state.lock();
        st.root = Some(root.clone());
        st.in_progress = true;
        st.indexed_files = 0;
        st.indexed_chunks = 0;
    }
    let _ = app.emit("index:start", json!({ "root": root.display().to_string() }));

    let snapshot = MerkleSnapshot::build(&root);
    // Try the in-memory snapshot first (fastest), then the on-disk one
    // (next-best — survives app restart), then fall back to "everything
    // is new" so we do a full first-time scan. The on-disk snapshot is
    // what eliminates the cold-start re-embed of every file.
    let prev = state
        .indexer
        .state
        .lock()
        .last_snapshot
        .clone()
        .or_else(|| MerkleSnapshot::load(&root))
        .unwrap_or_default();
    let diff = prev.diff(&snapshot);

    // Remove dead files.
    if let Some(conn) = state.indexer.db.lock().as_mut() {
        for p in &diff.removed {
            let _ = conn.execute(
                "DELETE FROM chunks WHERE path = ?1",
                params![p.display().to_string()],
            );
            let _ = conn.execute(
                "DELETE FROM files WHERE path = ?1",
                params![p.display().to_string()],
            );
        }
    }

    let mut to_process: Vec<PathBuf> = diff.added.clone();
    to_process.extend(diff.changed.clone());
    // If no diff but no files indexed yet, fall back to a full scan.
    if to_process.is_empty() && state.indexer.state.lock().indexed_chunks == 0 {
        let walker = workspace_walker(&root).build();
        for d in walker.flatten() {
            if d.file_type().map(|t| t.is_file()).unwrap_or(false) {
                to_process.push(d.path().to_path_buf());
            }
        }
    }

    let mut file_count = 0usize;
    let mut chunk_count = 0usize;
    let mut cancelled = false;
    for path in to_process {
        if inference_cancelled(&mut cancel) {
            cancelled = true;
            break;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        if bytes.len() > 2_000_000 {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        let chunks = chunk_text(&path, &text);

        if let Some(conn) = state.indexer.db.lock().as_mut() {
            let _ = conn.execute(
                "DELETE FROM chunks WHERE path = ?1",
                params![path.display().to_string()],
            );
            if let Some(hash) = snapshot.files.get(&path) {
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO files(path, hash) VALUES (?1, ?2)",
                    params![path.display().to_string(), hash],
                );
            }
        }

        for batch in chunks.chunks(MAX_EMBED_BATCH) {
            if inference_cancelled(&mut cancel) {
                cancelled = true;
                break;
            }
            let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
            let embeddings = match embed_batch(&model, texts.clone()).await {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("embed batch failed: {e}");
                    continue;
                }
            };
            if let Some(conn) = state.indexer.db.lock().as_mut() {
                let tx = conn.transaction()?;
                for (chunk, emb) in batch.iter().zip(embeddings.iter()) {
                    tx.execute(
                        "INSERT INTO chunks(path, start_line, end_line, language, text, embedding) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            chunk.path,
                            chunk.start_line as i64,
                            chunk.end_line as i64,
                            chunk.language,
                            chunk.text,
                            vec_to_blob(emb),
                        ],
                    )?;
                    chunk_count += 1;
                }
                tx.commit()?;
            }
        }
        if cancelled {
            break;
        }

        file_count += 1;
        let _ = app.emit(
            "index:progress",
            json!({"file": path.display().to_string(), "files": file_count, "chunks": chunk_count}),
        );
        {
            let mut st = state.indexer.state.lock();
            st.indexed_files = file_count;
            st.indexed_chunks = chunk_count;
        }
    }

    // Persist beside the workspace so the next cold start can pick up
    // exactly where we left off. Failures here are non-fatal — the
    // in-memory snapshot stays valid for the rest of the session.
    if let Err(e) = snapshot.save(&root) {
        log::warn!("merkle snapshot save failed for {}: {e}", root.display());
    }
    {
        let mut st = state.indexer.state.lock();
        st.last_snapshot = Some(snapshot);
        st.in_progress = false;
    }
    state.cancels.lock().clear(&request_id);
    let _ = app.emit(
        if cancelled {
            "index:cancelled"
        } else {
            "index:done"
        },
        json!({ "files": file_count, "chunks": chunk_count }),
    );
    Ok(())
}

async fn embed_batch(model: &str, texts: Vec<String>) -> AppResult<Vec<Vec<f32>>> {
    let resp = reqwest::Client::new()
        .post("http://127.0.0.1:11434/api/embed")
        .json(&json!({ "model": model, "input": texts }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!("embed HTTP {}", resp.status())));
    }
    let v: Value = resp.json().await?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("embeddings").and_then(|x| x.as_array()) {
        for emb in arr {
            if let Some(nums) = emb.as_array() {
                out.push(
                    nums.iter()
                        .map(|n| n.as_f64().unwrap_or(0.0) as f32)
                        .collect(),
                );
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub embed_model: Option<String>,
}

#[tauri::command]
pub async fn search_codebase(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SearchRequest,
) -> AppResult<Vec<ScoredChunk>> {
    let model = request
        .embed_model
        .unwrap_or_else(|| EMBED_MODEL_DEFAULT.to_string());
    let limit = request.limit.unwrap_or(8);
    let request_id = format!("search_embed_{}", uuid::Uuid::new_v4().simple());
    let _permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(request_id, model.clone(), "embedding", "Semantic search")
            .non_cancellable(),
        InferencePolicy::RejectBusy,
    )
    .await?;

    let q_embed = embed_batch(&model, vec![request.query]).await?;
    let q = q_embed.into_iter().next().unwrap_or_default();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let conn_opt = state.indexer.db.lock();
    let conn = match conn_opt.as_ref() {
        Some(c) => c,
        None => return Ok(vec![]),
    };
    let mut stmt = conn.prepare(
        "SELECT path, start_line, end_line, language, text, embedding FROM chunks WHERE embedding IS NOT NULL",
    )?;
    let mut rows = stmt.query([])?;

    let mut scored: Vec<ScoredChunk> = Vec::new();
    while let Some(row) = rows.next()? {
        let blob: Vec<u8> = row.get(5)?;
        let vec = blob_to_vec(&blob);
        if vec.is_empty() {
            continue;
        }
        let score = cosine(&q, &vec);
        scored.push(ScoredChunk {
            chunk: Chunk {
                path: row.get(0)?,
                start_line: row.get::<_, i64>(1)? as usize,
                end_line: row.get::<_, i64>(2)? as usize,
                language: row.get(3)?,
                text: row.get(4)?,
            },
            score,
        });
    }
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(limit);
    Ok(scored)
}

fn inference_cancelled(cancel: &mut tokio::sync::broadcast::Receiver<()>) -> bool {
    matches!(
        cancel.try_recv(),
        Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Closed)
    )
}
