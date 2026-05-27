//! Runtime registry for local model work.
//!
//! Ollama will happily accept several requests for the same model at once,
//! which is exactly how a local IDE can make a user's machine feel wedged:
//! chat, agent, indexing, and tab completion all fight the same runner. This
//! registry is Pointer's back-pressure layer. It tracks active model work,
//! enforces one foreground job per model, exposes a live snapshot to the UI,
//! and lets cancellable requests be stopped from one place.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InferenceJobSnapshot {
    pub request_id: String,
    pub model: String,
    pub kind: String,
    pub title: String,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub token_count: u64,
    pub cancellable: bool,
    pub interruptible: bool,
    pub cancelling: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InferenceSnapshot {
    pub active: Vec<InferenceJobSnapshot>,
    pub active_count: usize,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct InferenceClaim {
    pub request_id: String,
    pub model: String,
    pub kind: String,
    pub title: String,
    pub cancellable: bool,
    pub interruptible: bool,
}

impl InferenceClaim {
    pub fn new(
        request_id: impl Into<String>,
        model: impl Into<String>,
        kind: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            model: model.into(),
            kind: kind.into(),
            title: title.into(),
            cancellable: true,
            interruptible: false,
        }
    }

    pub fn non_cancellable(mut self) -> Self {
        self.cancellable = false;
        self
    }

    pub fn interruptible(mut self) -> Self {
        self.interruptible = true;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InferencePolicy {
    RejectBusy,
    ReplaceMatchingInterruptible,
}

#[derive(Debug, Clone)]
pub struct InferenceBusy {
    pub existing: InferenceJobSnapshot,
}

#[derive(Default)]
pub struct InferenceManager {
    active: Mutex<HashMap<String, InferenceJob>>,
    touched_models: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
struct InferenceJob {
    request_id: String,
    model: String,
    kind: String,
    title: String,
    started_at_ms: i64,
    updated_at_ms: i64,
    token_count: u64,
    cancellable: bool,
    interruptible: bool,
    cancelling: bool,
}

impl InferenceJob {
    fn snapshot(&self) -> InferenceJobSnapshot {
        InferenceJobSnapshot {
            request_id: self.request_id.clone(),
            model: self.model.clone(),
            kind: self.kind.clone(),
            title: self.title.clone(),
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            token_count: self.token_count,
            cancellable: self.cancellable,
            interruptible: self.interruptible,
            cancelling: self.cancelling,
        }
    }
}

impl InferenceManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(
        self: &Arc<Self>,
        app: AppHandle,
        claim: InferenceClaim,
    ) -> Result<InferencePermit, InferenceBusy> {
        let model_key = model_key(&claim.model);
        let now = now_ms();
        let mut active = self.active.lock();
        if let Some(existing) = active.get(&model_key) {
            return Err(InferenceBusy {
                existing: existing.snapshot(),
            });
        }
        self.touched_models.lock().insert(claim.model.clone());
        active.insert(
            model_key.clone(),
            InferenceJob {
                request_id: claim.request_id.clone(),
                model: claim.model,
                kind: claim.kind,
                title: claim.title,
                started_at_ms: now,
                updated_at_ms: now,
                token_count: 0,
                cancellable: claim.cancellable,
                interruptible: claim.interruptible,
                cancelling: false,
            },
        );
        drop(active);
        emit_change(&app, self);
        Ok(InferencePermit {
            manager: self.clone(),
            app: Some(app),
            model_key,
            request_id: claim.request_id,
            released: false,
        })
    }

    pub fn replace_interruptible(
        self: &Arc<Self>,
        app: AppHandle,
        claim: InferenceClaim,
        expected_request_id: &str,
    ) -> Result<InferencePermit, InferenceBusy> {
        let model_key = model_key(&claim.model);
        let now = now_ms();
        let mut active = self.active.lock();
        if let Some(existing) = active.get(&model_key) {
            let can_replace = existing.request_id == expected_request_id
                && existing.interruptible
                && existing.kind == claim.kind;
            if !can_replace {
                return Err(InferenceBusy {
                    existing: existing.snapshot(),
                });
            }
        }
        self.touched_models.lock().insert(claim.model.clone());
        active.insert(
            model_key.clone(),
            InferenceJob {
                request_id: claim.request_id.clone(),
                model: claim.model,
                kind: claim.kind,
                title: claim.title,
                started_at_ms: now,
                updated_at_ms: now,
                token_count: 0,
                cancellable: claim.cancellable,
                interruptible: claim.interruptible,
                cancelling: false,
            },
        );
        drop(active);
        emit_change(&app, self);
        Ok(InferencePermit {
            manager: self.clone(),
            app: Some(app),
            model_key,
            request_id: claim.request_id,
            released: false,
        })
    }

    #[cfg(test)]
    fn begin_for_test(
        self: &Arc<Self>,
        claim: InferenceClaim,
    ) -> Result<InferencePermit, InferenceBusy> {
        let model_key = model_key(&claim.model);
        let now = now_ms();
        let mut active = self.active.lock();
        if let Some(existing) = active.get(&model_key) {
            return Err(InferenceBusy {
                existing: existing.snapshot(),
            });
        }
        self.touched_models.lock().insert(claim.model.clone());
        active.insert(
            model_key.clone(),
            InferenceJob {
                request_id: claim.request_id.clone(),
                model: claim.model,
                kind: claim.kind,
                title: claim.title,
                started_at_ms: now,
                updated_at_ms: now,
                token_count: 0,
                cancellable: claim.cancellable,
                interruptible: claim.interruptible,
                cancelling: false,
            },
        );
        Ok(InferencePermit {
            manager: self.clone(),
            app: None,
            model_key,
            request_id: claim.request_id,
            released: false,
        })
    }

    #[cfg(test)]
    fn replace_interruptible_for_test(
        self: &Arc<Self>,
        claim: InferenceClaim,
        expected_request_id: &str,
    ) -> Result<InferencePermit, InferenceBusy> {
        let model_key = model_key(&claim.model);
        let now = now_ms();
        let mut active = self.active.lock();
        if let Some(existing) = active.get(&model_key) {
            let can_replace = existing.request_id == expected_request_id
                && existing.interruptible
                && existing.kind == claim.kind;
            if !can_replace {
                return Err(InferenceBusy {
                    existing: existing.snapshot(),
                });
            }
        }
        self.touched_models.lock().insert(claim.model.clone());
        active.insert(
            model_key.clone(),
            InferenceJob {
                request_id: claim.request_id.clone(),
                model: claim.model,
                kind: claim.kind,
                title: claim.title,
                started_at_ms: now,
                updated_at_ms: now,
                token_count: 0,
                cancellable: claim.cancellable,
                interruptible: claim.interruptible,
                cancelling: false,
            },
        );
        Ok(InferencePermit {
            manager: self.clone(),
            app: None,
            model_key,
            request_id: claim.request_id,
            released: false,
        })
    }

    pub fn snapshot(&self) -> InferenceSnapshot {
        let mut active: Vec<InferenceJobSnapshot> = self
            .active
            .lock()
            .values()
            .map(InferenceJob::snapshot)
            .collect();
        active.sort_by(|a, b| a.started_at_ms.cmp(&b.started_at_ms));
        InferenceSnapshot {
            active_count: active.len(),
            active,
            updated_at_ms: now_ms(),
        }
    }

    pub fn note_tokens(&self, request_id: &str, token_count: u64) {
        let mut active = self.active.lock();
        for job in active.values_mut() {
            if job.request_id == request_id {
                job.token_count = job.token_count.saturating_add(token_count);
                job.updated_at_ms = now_ms();
                break;
            }
        }
    }

    pub fn mark_cancelling(&self, request_id: &str) -> bool {
        let mut changed = false;
        let mut active = self.active.lock();
        for job in active.values_mut() {
            if job.request_id == request_id {
                job.cancelling = true;
                job.updated_at_ms = now_ms();
                changed = true;
                break;
            }
        }
        changed
    }

    pub fn cancel_all_request_ids(&self) -> Vec<String> {
        self.active
            .lock()
            .values()
            .map(|job| job.request_id.clone())
            .collect()
    }

    pub fn touched_models(&self) -> Vec<String> {
        let mut models: Vec<String> = self.touched_models.lock().iter().cloned().collect();
        models.sort();
        models
    }

    fn finish(&self, model_key: &str, request_id: &str) {
        let mut active = self.active.lock();
        let remove = active
            .get(model_key)
            .map(|job| job.request_id == request_id)
            .unwrap_or(false);
        if remove {
            active.remove(model_key);
        }
    }
}

pub struct InferencePermit {
    manager: Arc<InferenceManager>,
    app: Option<AppHandle>,
    model_key: String,
    request_id: String,
    released: bool,
}

impl InferencePermit {
    pub fn note_tokens(&self, token_count: u64) {
        self.manager.note_tokens(&self.request_id, token_count);
    }

    pub fn release(mut self) {
        self.released = true;
        self.manager.finish(&self.model_key, &self.request_id);
        if let Some(app) = &self.app {
            emit_change(app, &self.manager);
        }
    }
}

impl Drop for InferencePermit {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.manager.finish(&self.model_key, &self.request_id);
        if let Some(app) = &self.app {
            emit_change(app, &self.manager);
        }
    }
}

pub async fn acquire_inference(
    app: &AppHandle,
    state: &AppState,
    claim: InferenceClaim,
    policy: InferencePolicy,
) -> AppResult<InferencePermit> {
    match state.inference.begin(app.clone(), claim.clone()) {
        Ok(permit) => Ok(permit),
        Err(busy) if policy == InferencePolicy::ReplaceMatchingInterruptible => {
            if busy.existing.kind == claim.kind && busy.existing.interruptible {
                let _ = state.cancels.lock().cancel(&busy.existing.request_id);
                state.inference.mark_cancelling(&busy.existing.request_id);
                emit_change(app, &state.inference);
                state
                    .inference
                    .replace_interruptible(app.clone(), claim, &busy.existing.request_id)
                    .map_err(|busy| busy_error(&busy.existing))
            } else {
                Err(busy_error(&busy.existing))
            }
        }
        Err(busy) => Err(busy_error(&busy.existing)),
    }
}

pub fn emit_change(app: &AppHandle, manager: &InferenceManager) {
    let _ = app.emit("inference:changed", manager.snapshot());
}

fn busy_error(existing: &InferenceJobSnapshot) -> AppError {
    AppError::Msg(format!(
        "Model `{}` is busy with {}: {}. Cancel that run from Model Activity or wait for it to finish.",
        existing.model, existing.kind, existing.title
    ))
}

fn model_key(model: &str) -> String {
    model.trim().to_ascii_lowercase()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(id: &str, model: &str, kind: &str) -> InferenceClaim {
        InferenceClaim::new(id, model, kind, "test")
    }

    #[test]
    fn snapshot_reports_one_job_per_model() {
        let manager = Arc::new(InferenceManager::new());
        let _permit = manager
            .begin_for_test(claim("a", "qwen:7b", "chat"))
            .unwrap();

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.active_count, 1);
        assert_eq!(snapshot.active[0].request_id, "a");
        assert_eq!(snapshot.active[0].model, "qwen:7b");
    }

    #[test]
    fn same_model_is_busy_until_permit_drops() {
        let manager = Arc::new(InferenceManager::new());
        let permit = manager
            .begin_for_test(claim("a", "Qwen:7B", "chat"))
            .unwrap();

        let busy = manager.begin_for_test(claim("b", "qwen:7b", "agent"));
        assert!(busy.is_err());

        drop(permit);
        assert!(manager
            .begin_for_test(claim("b", "qwen:7b", "agent"))
            .is_ok());
    }

    #[test]
    fn stale_replaced_permit_does_not_clear_new_job() {
        let manager = Arc::new(InferenceManager::new());
        let old = manager
            .begin_for_test(claim("old", "qwen:1.5b", "inline_suggestion").interruptible())
            .unwrap();
        let new = manager
            .replace_interruptible_for_test(
                claim("new", "qwen:1.5b", "inline_suggestion").interruptible(),
                "old",
            )
            .unwrap();

        drop(old);
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.active_count, 1);
        assert_eq!(snapshot.active[0].request_id, "new");

        drop(new);
        assert_eq!(manager.snapshot().active_count, 0);
    }
}
