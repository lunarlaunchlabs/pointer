use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::services::workspace_filter::workspace_walker;

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct MerkleSnapshot {
    pub files: BTreeMap<PathBuf, String>,
}

impl MerkleSnapshot {
    /// On-disk filename. Stored inside the per-workspace `.pointer/` dir so
    /// each project keeps its own snapshot. Without persistence, every
    /// cold start re-hashes + re-embeds the entire workspace, which
    /// dominates startup time on large repos.
    pub const FILE_NAME: &'static str = "merkle.json";

    /// Load a previously-persisted snapshot from `<root>/.pointer/merkle.json`.
    /// Missing file or malformed JSON both yield `None` — the caller treats
    /// that as a cold start and rebuilds from scratch.
    pub fn load(root: &Path) -> Option<Self> {
        let path = Self::snapshot_path(root);
        let bytes = std::fs::read(&path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Persist this snapshot beside the workspace. Creates `.pointer/`
    /// lazily and writes atomically (write-to-tempfile, then rename) so a
    /// crash mid-write can't leave a half-serialised JSON document on
    /// disk to confuse the next load.
    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        let dir = root.join(".pointer");
        std::fs::create_dir_all(&dir)?;
        let final_path = dir.join(Self::FILE_NAME);
        let tmp_path = dir.join(format!("{}.tmp", Self::FILE_NAME));
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp_path, json)?;
        std::fs::rename(&tmp_path, &final_path)?;
        Ok(())
    }

    fn snapshot_path(root: &Path) -> PathBuf {
        root.join(".pointer").join(Self::FILE_NAME)
    }

    pub fn build(root: &Path) -> Self {
        let mut files = BTreeMap::new();
        let walker = workspace_walker(root).build();
        for dent in walker.flatten() {
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let p = dent.path();
            let bytes = match std::fs::read(p) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = hex::encode(hasher.finalize());
            files.insert(p.to_path_buf(), hash);
        }
        Self { files }
    }

    pub fn diff(&self, other: &MerkleSnapshot) -> Diff {
        let mut added = vec![];
        let mut changed = vec![];
        let mut removed = vec![];
        for (p, h) in &other.files {
            match self.files.get(p) {
                None => added.push(p.clone()),
                Some(prev) if prev != h => changed.push(p.clone()),
                _ => {}
            }
        }
        for p in self.files.keys() {
            if !other.files.contains_key(p) {
                removed.push(p.clone());
            }
        }
        Diff {
            added,
            changed,
            removed,
        }
    }
}

#[derive(Default)]
pub struct Diff {
    pub added: Vec<PathBuf>,
    pub changed: Vec<PathBuf>,
    pub removed: Vec<PathBuf>,
}
