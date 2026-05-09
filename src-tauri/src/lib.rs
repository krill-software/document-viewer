use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
struct DocumentRead {
    path: String,
    bytes: Vec<u8>,
    mime: String,
}

#[tauri::command]
fn read_document(path: String) -> Result<DocumentRead, String> {
    let p = Path::new(&path);
    let bytes = fs::read(p).map_err(|e| format_io_err(&path, e))?;
    Ok(DocumentRead {
        path: absolute_path(p),
        bytes,
        mime: "application/pdf".to_string(),
    })
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<WindowState>,
    recent: Option<Vec<String>>,
    panel_visible: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

fn state_path() -> Option<PathBuf> {
    let base = dirs::state_dir().or_else(dirs::data_local_dir)?;
    Some(base.join("krill-document-viewer").join("state.json"))
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    let p = state_path()?;
    let raw = fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    let p = state_path().ok_or_else(|| "no state dir available".to_string())?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let manifest = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(manifest).parent()?.join("test.pdf");
    if path.exists() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn absolute_path(p: &Path) -> String {
    fs::canonicalize(p)
        .map(|abs| abs.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

fn format_io_err(path: &str, e: io::Error) -> String {
    format!("{path}: {e}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_document,
            load_state,
            save_state,
            dev_test_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
