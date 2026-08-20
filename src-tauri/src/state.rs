use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::imaging::LoadedImage;

/// A loaded photo plus the id the frontend uses to refer to it (photo strip,
/// active-selection, removal) - `LoadedImage` itself carries no identity of
/// its own since it used to be the only one.
pub struct Photo {
    pub id: String,
    pub image: LoadedImage,
}

pub struct AppState {
    /// Every photo currently loaded (drag&drop, paste, or file picker can add
    /// more than one). Export runs every selected gradient across all of
    /// these; which one is "active" for the live preview is a frontend-only
    /// concept the backend doesn't need to track.
    pub images: Mutex<Vec<Photo>>,
    pub app_dir: PathBuf,
    next_id: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self { images: Mutex::new(Vec::new()), app_dir: resolve_app_dir(), next_id: AtomicU64::new(1) }
    }

    pub fn gradients_dir(&self) -> PathBuf {
        self.app_dir.join("gradients")
    }

    pub fn next_id(&self) -> String {
        format!("img-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
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
