mod export;
mod grd;
mod gradient;
mod imaging;
mod state;

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::{Manager, State};

use export::{ExportRequest, ExportResult};
use gradient::{GradientDef, GradientMeta};
use imaging::ImageInfo;
use state::AppState;

#[tauri::command]
fn list_gradients(state: State<AppState>) -> Vec<GradientMeta> {
    gradient::list_meta(&state.gradients_dir())
}

#[tauri::command]
fn get_gradient(state: State<AppState>, id: String) -> Result<GradientDef, String> {
    gradient::get_def(&state.gradients_dir(), &id)
}

#[tauri::command]
fn save_gradient(state: State<AppState>, id: Option<String>, def: GradientDef) -> Result<String, String> {
    gradient::save(&state.gradients_dir(), id.as_deref(), &def)
}

#[tauri::command]
fn delete_gradient(state: State<AppState>, id: String) -> Result<(), String> {
    gradient::delete(&state.gradients_dir(), &id)
}

#[tauri::command]
fn load_image_path(state: State<AppState>, path: String) -> Result<ImageInfo, String> {
    let loaded = imaging::load_from_path(std::path::Path::new(&path))?;
    let info = imaging::info_for(&loaded);
    *state.image.lock().unwrap() = Some(loaded);
    Ok(info)
}

/// Reads whatever image is currently on the Windows clipboard (Ctrl+V). Goes
/// straight through the OS clipboard API (arboard) rather than the webview's
/// `navigator.clipboard`, which is inconsistent about raw bitmap clipboard
/// formats across WebView2 versions.
#[tauri::command]
fn load_image_clipboard(state: State<AppState>) -> Result<ImageInfo, String> {
    let loaded = imaging::read_clipboard_image()?;
    let info = imaging::info_for(&loaded);
    *state.image.lock().unwrap() = Some(loaded);
    Ok(info)
}

#[tauri::command]
fn run_export(state: State<AppState>, request: ExportRequest) -> Result<ExportResult, String> {
    let guard = state.image.lock().unwrap();
    let image = guard.as_ref().ok_or("no image loaded")?;
    Ok(export::run(&state.gradients_dir(), image, &request))
}

// ---------------------------------------------------------------- settings

fn settings_file() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join("regradient").join("settings.json")
}

/// Deep merge: `patch` wins per-key, but keys `patch` doesn't mention survive.
/// Keeps saving from one panel from ever clobbering settings a different part
/// of the UI already wrote.
fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                match base_map.get_mut(key) {
                    Some(base_value) => merge(base_value, patch_value),
                    None => {
                        base_map.insert(key.clone(), patch_value.clone());
                    }
                }
            }
        }
        (slot, patch_value) => *slot = patch_value.clone(),
    }
}

#[tauri::command]
fn load_settings() -> Result<Value, String> {
    let path = settings_file();
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

#[tauri::command]
fn save_settings(patch: Value) -> Result<(), String> {
    let path = settings_file();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let mut current: Value = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Map::new())),
        Err(_) => Value::Object(Map::new()),
    };
    merge(&mut current, &patch);
    let text = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Rounds the window frame itself so the acrylic backdrop (painted by DWM
/// over the whole window rectangle) doesn't poke square corners out past the
/// CSS-rounded panel.
#[cfg(windows)]
fn round_corners(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};

    let Ok(handle) = window.hwnd() else { return };
    unsafe {
        let preference = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            HWND(handle.0 as *mut core::ffi::c_void),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    round_corners(&window);
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_gradients,
            get_gradient,
            save_gradient,
            delete_gradient,
            load_image_path,
            load_image_clipboard,
            run_export,
            load_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
