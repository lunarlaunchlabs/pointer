use ignore::{DirEntry, WalkBuilder};
use std::path::{Component, Path};

const NOISE_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".pointer",
    "node_modules",
    "target",
    "dist",
    "dist-ssr",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".vite",
    ".gradle",
    ".idea",
    ".vscode",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "env",
    "vendor",
    "Pods",
    "DerivedData",
];

pub fn is_noise_component(name: &str) -> bool {
    NOISE_DIRS
        .iter()
        .any(|noise| name.eq_ignore_ascii_case(noise))
}

pub fn path_has_noise_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(is_noise_component),
        _ => false,
    })
}

pub fn path_has_noise_component_under(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    path_has_noise_component(relative)
}

pub fn allow_walk_entry(root: &Path, entry: &DirEntry) -> bool {
    entry.path() == root || !path_has_noise_component_under(root, entry.path())
}

pub fn workspace_walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    let root = root.to_path_buf();
    builder
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .filter_entry(move |entry| allow_walk_entry(&root, entry));
    builder
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detects_generated_noise_under_workspace() {
        let root = Path::new("/repo");
        assert!(path_has_noise_component_under(
            root,
            Path::new("/repo/src-tauri/target/debug/app")
        ));
        assert!(path_has_noise_component_under(
            root,
            Path::new("/repo/node_modules/pkg/index.js")
        ));
        assert!(path_has_noise_component_under(
            root,
            Path::new("/repo/.pointer/merkle.json")
        ));
        assert!(!path_has_noise_component_under(
            root,
            Path::new("/repo/src/app/App.tsx")
        ));
    }
}
