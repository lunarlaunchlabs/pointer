//! File ingestion: take an arbitrary attachment a developer is likely to
//! drop into chat (image, PDF, spreadsheet, plain text) and turn it into
//! text Pointer can stuff into a prompt.
//!
//! Design decisions:
//!
//! * Per-purpose model assignment. Images and PDFs that look scanned need a
//!   *vision* model; xlsx/csv/text PDFs can be parsed deterministically and
//!   then summarised by a *document* model the user chose specifically for
//!   that job. We never silently reuse the chat model — the user asked for
//!   explicit picks per type and we honour that.
//!
//! * We always run the chosen model with `keep_alive: 0`. That instructs
//!   Ollama to drop the model from VRAM the moment the response completes,
//!   which is exactly the "spin up, get info, shut off" lifecycle the user
//!   asked for. Foreground latency takes the hit of reloading next time,
//!   which is the right tradeoff for ad-hoc attachments.
//!
//! * Pure-Rust deps only (calamine, pdf-extract, image, csv). Office docs
//!   like docx/pptx need real zip+xml parsing — we error clearly rather
//!   than mis-extract.

use crate::error::{AppError, AppResult};
use crate::services::inference::{acquire_inference, InferenceClaim, InferencePolicy};
use crate::state::AppState;
use base64::Engine;
use calamine::Reader;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

static HTTP: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .pool_max_idle_per_host(4)
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("http client")
});

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// Raster image. Requires a multimodal vision model.
    Image,
    /// PDF document. We try text extraction first; if empty we report that
    /// the file is scanned and the user needs to OCR / rasterize externally.
    Pdf,
    /// Spreadsheet — xlsx, xls, ods, csv. Parsed deterministically.
    Spreadsheet,
    /// Plain text — txt, md, json, yaml, toml. No model required.
    Plain,
    /// Office docs we can't read in pure Rust yet (docx / pptx). We refuse
    /// politely instead of trying to misinterpret zipped XML.
    Unsupported,
}

/// Information about the *requirement*, before we've done any work. The UI
/// uses this to disable the attach button or prompt the user to set up the
/// right model.
#[derive(Debug, Serialize)]
pub struct FileKindInfo {
    pub kind: FileKind,
    /// One of "vision", "document", or null when no model is required.
    pub required_purpose: Option<String>,
    /// Friendly label for the UI: "Image", "PDF document", …
    pub label: String,
    /// Reason the file is unsupported, when `kind == Unsupported`.
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn classify_file(path: String) -> AppResult<FileKindInfo> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::Msg(format!("file does not exist: {path}")));
    }
    Ok(classify(&p))
}

fn classify(path: &Path) -> FileKindInfo {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => FileKindInfo {
            kind: FileKind::Image,
            required_purpose: Some("vision".into()),
            label: "Image".into(),
            reason: None,
        },
        "pdf" => FileKindInfo {
            kind: FileKind::Pdf,
            required_purpose: Some("document".into()),
            label: "PDF".into(),
            reason: None,
        },
        "xlsx" | "xls" | "xlsm" | "ods" => FileKindInfo {
            kind: FileKind::Spreadsheet,
            required_purpose: Some("document".into()),
            label: "Spreadsheet".into(),
            reason: None,
        },
        "csv" | "tsv" => FileKindInfo {
            kind: FileKind::Spreadsheet,
            required_purpose: Some("document".into()),
            label: "CSV".into(),
            reason: None,
        },
        "docx" | "doc" | "pptx" | "ppt" => FileKindInfo {
            kind: FileKind::Unsupported,
            required_purpose: None,
            label: ext.to_uppercase(),
            reason: Some(
                "Word and PowerPoint files aren't supported in this build. Export to PDF or text first."
                    .into(),
            ),
        },
        "txt" | "md" | "markdown" | "json" | "yaml" | "yml" | "toml" | "ini" | "log"
        | "rst" | "html" | "htm" | "xml" => FileKindInfo {
            kind: FileKind::Plain,
            required_purpose: None,
            label: "Text".into(),
            reason: None,
        },
        _ => FileKindInfo {
            kind: FileKind::Unsupported,
            required_purpose: None,
            label: ext.to_uppercase(),
            reason: Some(
                "Unrecognised extension — Pointer only ingests image, PDF, spreadsheet and text files."
                    .into(),
            ),
        },
    }
}

#[derive(Debug, Deserialize)]
pub struct ProcessFileArgs {
    pub path: String,
    /// Model name to drive ingestion. Required for everything but
    /// `FileKind::Plain` (where we just read the bytes).
    pub model: Option<String>,
    /// Free-form hint forwarded to the model, e.g. "what's the key insight
    /// in this chart". When None we use a generic extraction prompt.
    pub instruction: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProcessFileResult {
    pub kind: FileKind,
    pub label: String,
    /// The extracted/summarised content, ready to be appended to a chat
    /// prompt. Always plain text.
    pub content: String,
    /// Byte size of the raw file.
    pub raw_bytes: u64,
    /// True iff we invoked a model. When false, `content` is the verbatim
    /// file contents (Plain) or a deterministic extraction (Spreadsheet).
    pub used_model: bool,
    /// The model we ran with `keep_alive: 0`. Echoed back so the UI can
    /// label the resulting reference clearly.
    pub model_name: Option<String>,
}

#[tauri::command]
pub async fn process_file(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ProcessFileArgs,
) -> AppResult<ProcessFileResult> {
    let path = PathBuf::from(&args.path);
    if !path.exists() {
        return Err(AppError::Msg(format!("file does not exist: {}", args.path)));
    }
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::Msg(format!("stat {}: {e}", path.display())))?;
    let raw_bytes = meta.len();
    let info = classify(&path);

    match info.kind {
        FileKind::Plain => {
            let text = read_text_capped(&path)?;
            Ok(ProcessFileResult {
                kind: info.kind,
                label: info.label,
                content: text,
                raw_bytes,
                used_model: false,
                model_name: None,
            })
        }
        FileKind::Spreadsheet => {
            let extracted = extract_spreadsheet(&path)?;
            // Document model is optional for spreadsheets: when none is set we
            // hand the raw extraction to the chat directly. With a document
            // model the user gets a summarised version that fits in context.
            match args.model.as_deref().filter(|s| !s.is_empty()) {
                Some(m) => {
                    let request_id = format!("file_{}", uuid::Uuid::new_v4().simple());
                    let _permit = acquire_inference(
                        &app,
                        &state,
                        InferenceClaim::new(
                            request_id.clone(),
                            m.to_string(),
                            "document",
                            format!("Process {}", path.display()),
                        ),
                        InferencePolicy::RejectBusy,
                    )
                    .await?;
                    let mut cancel = state.cancels.lock().issue(&request_id);
                    let summary = summarise_text(
                        m,
                        &info.label,
                        &extracted,
                        args.instruction.as_deref(),
                        &mut cancel,
                    )
                    .await;
                    state.cancels.lock().clear(&request_id);
                    let summary = summary?;
                    Ok(ProcessFileResult {
                        kind: info.kind,
                        label: info.label,
                        content: summary,
                        raw_bytes,
                        used_model: true,
                        model_name: Some(m.to_string()),
                    })
                }
                None => Ok(ProcessFileResult {
                    kind: info.kind,
                    label: info.label,
                    content: extracted,
                    raw_bytes,
                    used_model: false,
                    model_name: None,
                }),
            }
        }
        FileKind::Pdf => {
            let extracted = extract_pdf_text(&path)?;
            if extracted.trim().is_empty() {
                return Err(AppError::Msg(
                    "This PDF has no extractable text — it's likely scanned. Rasterised \
                     PDFs aren't supported yet; convert it to images first and attach those."
                        .into(),
                ));
            }
            let model = args
                .model
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::Msg(
                        "No document model set — pick one in AI Control Panel → Models.".into(),
                    )
                })?;
            let summary = {
                let request_id = format!("file_{}", uuid::Uuid::new_v4().simple());
                let _permit = acquire_inference(
                    &app,
                    &state,
                    InferenceClaim::new(
                        request_id.clone(),
                        model.to_string(),
                        "document",
                        format!("Process {}", path.display()),
                    ),
                    InferencePolicy::RejectBusy,
                )
                .await?;
                let mut cancel = state.cancels.lock().issue(&request_id);
                let summary = summarise_text(
                    model,
                    "PDF",
                    &extracted,
                    args.instruction.as_deref(),
                    &mut cancel,
                )
                .await;
                state.cancels.lock().clear(&request_id);
                summary?
            };
            Ok(ProcessFileResult {
                kind: info.kind,
                label: info.label,
                content: summary,
                raw_bytes,
                used_model: true,
                model_name: Some(model.to_string()),
            })
        }
        FileKind::Image => {
            let model = args
                .model
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::Msg(
                        "No vision model set — pick one in AI Control Panel → Models.".into(),
                    )
                })?;
            let request_id = format!("file_{}", uuid::Uuid::new_v4().simple());
            let _permit = acquire_inference(
                &app,
                &state,
                InferenceClaim::new(
                    request_id.clone(),
                    model.to_string(),
                    "vision",
                    format!("Process {}", path.display()),
                ),
                InferencePolicy::RejectBusy,
            )
            .await?;
            let mut cancel = state.cancels.lock().issue(&request_id);
            let summary =
                describe_image(model, &path, args.instruction.as_deref(), &mut cancel).await;
            state.cancels.lock().clear(&request_id);
            let summary = summary?;
            Ok(ProcessFileResult {
                kind: info.kind,
                label: info.label,
                content: summary,
                raw_bytes,
                used_model: true,
                model_name: Some(model.to_string()),
            })
        }
        FileKind::Unsupported => Err(AppError::Msg(
            info.reason
                .unwrap_or_else(|| "Unsupported file type.".into()),
        )),
    }
}

// --------- extraction helpers ---------

/// Read a text file but cap it so we don't blow up the chat prompt or RSS.
fn read_text_capped(path: &Path) -> AppResult<String> {
    const MAX: usize = 256 * 1024; // 256KB of text is plenty for a single attachment.
    let bytes = std::fs::read(path).map_err(|e| AppError::Msg(format!("read: {e}")))?;
    if bytes.len() <= MAX {
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        let head = String::from_utf8_lossy(&bytes[..MAX]).into_owned();
        Ok(format!(
            "{head}\n\n…[truncated: file is {} bytes, only the first {MAX} were attached]…",
            bytes.len()
        ))
    }
}

/// Best-effort text extraction from a PDF. `pdf-extract` only handles
/// text-embedded PDFs — scanned/image-only PDFs come back empty and we
/// surface that to the user.
fn extract_pdf_text(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path).map_err(|e| AppError::Msg(format!("read pdf: {e}")))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| AppError::Msg(format!("pdf parse: {e}")))?;
    Ok(text)
}

/// Parse xlsx/xls/ods/csv into a markdown-ish text dump. We cap rows/cols so
/// the prompt stays bounded.
fn extract_spreadsheet(path: &Path) -> AppResult<String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if ext == "csv" || ext == "tsv" {
        return extract_csv(path, if ext == "tsv" { b'\t' } else { b',' });
    }

    let mut workbook = calamine::open_workbook_auto(path)
        .map_err(|e| AppError::Msg(format!("open spreadsheet: {e}")))?;
    let names = workbook.sheet_names().to_vec();
    if names.is_empty() {
        return Err(AppError::Msg("spreadsheet has no sheets".into()));
    }

    const MAX_ROWS_PER_SHEET: usize = 200;
    const MAX_COLS: usize = 24;
    let mut out = String::new();
    for sheet in names.iter().take(8) {
        let range = workbook
            .worksheet_range(sheet)
            .map_err(|e| AppError::Msg(format!("read sheet {sheet}: {e}")))?;
        out.push_str(&format!("\n## Sheet: {sheet}\n\n"));
        for (row_idx, row) in range.rows().take(MAX_ROWS_PER_SHEET).enumerate() {
            let cells: Vec<String> = row
                .iter()
                .take(MAX_COLS)
                .map(|c| c.to_string().replace('\n', " "))
                .collect();
            out.push_str("| ");
            out.push_str(&cells.join(" | "));
            out.push_str(" |\n");
            if row_idx == 0 {
                // markdown header separator
                out.push('|');
                for _ in 0..cells.len() {
                    out.push_str("---|");
                }
                out.push('\n');
            }
        }
        if range.height() > MAX_ROWS_PER_SHEET {
            out.push_str(&format!(
                "\n…[truncated: sheet has {} rows total, showing first {MAX_ROWS_PER_SHEET}]…\n",
                range.height()
            ));
        }
    }
    Ok(out)
}

fn extract_csv(path: &Path, delim: u8) -> AppResult<String> {
    const MAX_ROWS: usize = 500;
    const MAX_COLS: usize = 32;
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| AppError::Msg(format!("open csv: {e}")))?;
    let mut out = String::new();
    let mut printed = 0usize;
    let mut headers_written = false;
    for result in rdr.records() {
        let record = match result {
            Ok(r) => r,
            Err(_) => continue,
        };
        let cells: Vec<String> = record
            .iter()
            .take(MAX_COLS)
            .map(|s| s.replace('\n', " "))
            .collect();
        out.push_str("| ");
        out.push_str(&cells.join(" | "));
        out.push_str(" |\n");
        if !headers_written {
            out.push('|');
            for _ in 0..cells.len() {
                out.push_str("---|");
            }
            out.push('\n');
            headers_written = true;
        }
        printed += 1;
        if printed >= MAX_ROWS {
            out.push_str(&format!("\n…[truncated to first {MAX_ROWS} rows]…\n"));
            break;
        }
    }
    Ok(out)
}

// --------- model invocations (always with keep_alive=0) ---------

/// Hand a chunk of text to a text-only model and ask for an extraction
/// suitable for chat. The response is the content the user effectively sees
/// as "the file's contents" from the chat's perspective.
async fn summarise_text(
    model: &str,
    label: &str,
    body: &str,
    instruction: Option<&str>,
    cancel: &mut tokio::sync::broadcast::Receiver<()>,
) -> AppResult<String> {
    let system =
        "You are an extractor. Read the attached document content and produce a faithful, \
                  structured summary in markdown. Preserve numbers, headers and key tables. \
                  Never invent facts — if a section is missing, omit it.";
    let user = format!(
        "Document type: {label}\n\n\
         {hint}\
         <<<DOCUMENT>>>\n{body}\n<<<END DOCUMENT>>>",
        hint = match instruction {
            Some(i) if !i.is_empty() => format!("User intent: {i}\n\n"),
            _ => String::new(),
        }
    );
    chat_once_unload(model, system, &user, None, cancel).await
}

/// Run a vision model on a single image. We send the base64 inside the
/// `images` field of `/api/chat`, which Ollama wires through to the
/// multimodal model's image input.
async fn describe_image(
    model: &str,
    path: &Path,
    instruction: Option<&str>,
    cancel: &mut tokio::sync::broadcast::Receiver<()>,
) -> AppResult<String> {
    let bytes = std::fs::read(path).map_err(|e| AppError::Msg(format!("read image: {e}")))?;
    // Re-encode large images down to a reasonable size. Vision models choke
    // on huge inputs and Ollama will just OOM. 1600px on the long edge is a
    // good ceiling for most.
    let bytes = downscale_if_huge(&bytes).unwrap_or(bytes);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let system = "You are a vision assistant. Describe the attached image faithfully. \
                  If it contains text, transcribe it verbatim. If it's a UI, describe layout. \
                  If it's a chart, surface the data points.";
    let user = instruction
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            "Describe this image with everything that would be useful to a developer.".to_string()
        });
    chat_once_unload(model, system, &user, Some(vec![b64]), cancel).await
}

/// Downscale an image only when it exceeds the long-edge threshold. We keep
/// the original encoding so PNG screenshots don't get JPEG'd unless huge.
fn downscale_if_huge(bytes: &[u8]) -> Option<Vec<u8>> {
    const MAX_EDGE: u32 = 1600;
    let img = image::load_from_memory(bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    if w <= MAX_EDGE && h <= MAX_EDGE {
        return None;
    }
    let scale = (MAX_EDGE as f32) / (w.max(h) as f32);
    let nw = ((w as f32) * scale) as u32;
    let nh = ((h as f32) * scale) as u32;
    let resized = img.resize(nw, nh, image::imageops::FilterType::Lanczos3);
    let mut buf: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    resized
        .write_to(&mut cursor, image::ImageFormat::Jpeg)
        .ok()?;
    Some(buf)
}

/// One-shot chat round trip that *also* tells Ollama to drop the model from
/// memory immediately after responding. This is the "spin up → use → shut
/// off" lifecycle the user asked for, expressed in the API's native vocab.
async fn chat_once_unload(
    model: &str,
    system: &str,
    user: &str,
    images_b64: Option<Vec<String>>,
    cancel: &mut tokio::sync::broadcast::Receiver<()>,
) -> AppResult<String> {
    let mut user_msg = json!({
        "role": "user",
        "content": user,
    });
    if let Some(imgs) = &images_b64 {
        user_msg["images"] = Value::Array(imgs.iter().map(|s| Value::String(s.clone())).collect());
    }

    let body = json!({
        "model": model,
        "stream": false,
        // keep_alive: 0 → unload from VRAM the moment we get a response.
        // This is the contract the user wants: "once it has done its job,
        // shut off".
        "keep_alive": 0,
        "messages": [
            { "role": "system", "content": system },
            user_msg,
        ],
        "options": {
            // Modest, deterministic. The user can always re-attach with a
            // different instruction if they want creative description.
            "temperature": 0.2,
            "num_predict": 1024,
        }
    });

    let send = HTTP
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&body)
        .send();
    let resp = tokio::select! {
        _ = cancel.recv() => {
            return Err(AppError::Msg("model call cancelled".into()));
        }
        resp = send => resp.map_err(|e| AppError::Msg(format!("model call: {e}")))?,
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(AppError::Msg(format!(
            "model call {model}: HTTP {status} — {txt}"
        )));
    }
    let parse = resp.json();
    let v: Value = tokio::select! {
        _ = cancel.recv() => {
            return Err(AppError::Msg("model call cancelled".into()));
        }
        parsed = parse => parsed
            .map_err(|e| AppError::Msg(format!("parse model response: {e}")))?,
    };
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    if content.is_empty() {
        return Err(AppError::Msg(
            "model returned empty content — try a different model or a smaller file".into(),
        ));
    }
    Ok(content)
}
