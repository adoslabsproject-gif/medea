//! Medea desktop shell — entry point.
//!
//! In Fase 0 questo file contiene SOLO la Tauri Builder con i plugin minimi.
//! Tutti i `#[tauri::command]` arriveranno in Fase 1 (mail-core) e saranno
//! registrati nel crate `mail-tauri` (workspace package) e qui solo riesportati.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::ping])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                eprintln!("[medea] starting in dev mode");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Medea desktop app");
}
