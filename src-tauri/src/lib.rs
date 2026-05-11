use std::path::Path;

use serde::{Deserialize, Serialize};

use krill_desktop_core::{fs as kfs, state as kstate, dev as kdev};

const SLUG: &str = "krill-document-viewer";

#[derive(Debug, Serialize)]
struct DocumentRead {
    path: String,
    bytes: Vec<u8>,
    mime: String,
}

#[tauri::command]
fn read_document(path: String) -> Result<DocumentRead, String> {
    let p = Path::new(&path);
    let bytes = kfs::read_bytes(p)?;
    Ok(DocumentRead {
        path: kfs::absolute_path(p),
        bytes,
        mime: "application/pdf".to_string(),
    })
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<kstate::WindowGeometry>,
    recent: Option<Vec<String>>,
    panel_visible: Option<bool>,
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    kstate::load(SLUG, "state.json")
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    kstate::save(SLUG, "state.json", &state)
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    kdev::test_file(env!("CARGO_MANIFEST_DIR"), &["test.pdf"])
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
