use std::path::PathBuf;
use std::sync::Mutex;

use crate::imaging::LoadedImage;

pub struct AppState {
    pub image: Mutex<Option<LoadedImage>>,
    pub app_dir: PathBuf,
}

impl AppState {
    pub fn new() -> Self {
        Self { image: Mutex::new(None), app_dir: resolve_app_dir() }
    }

    pub fn gradients_dir(&self) -> PathBuf {
        self.app_dir.join("gradients")
    }
}

/// In development the running binary lives under `src-tauri/target/debug`,
/// far from the `gradients/` folder at the project root; in a shipped build
/// the executable sits next to `gradients/` (bundled as a resource), so the
/// two cases resolve differently.
fn resolve_app_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}
