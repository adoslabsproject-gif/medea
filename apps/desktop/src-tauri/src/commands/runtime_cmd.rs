//! Comandi Tauri per il runtime dei workflow.

use crate::runtime::{self, RuntimeStatus};
use tauri::Manager;

/// Avvia il runtime se non è già in piedi, e restituisce dove trovarlo.
#[tauri::command]
pub fn workflow_runtime_start(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(runtime::start(&resource_dir, &data_dir))
}

#[tauri::command]
pub fn workflow_runtime_status() -> RuntimeStatus {
    runtime::status()
}

#[tauri::command]
pub fn workflow_runtime_stop() {
    runtime::stop();
}

/// Dove parlare al runtime e con quale token.
///
/// Un comando solo perché sono una cosa sola: un indirizzo senza sessione non
/// serve a niente, e chiederli separatamente vorrebbe dire che la UI possa
/// ritrovarsi con l'uno e non con l'altro.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSession {
    pub base_url: String,
    pub token: String,
}

#[tauri::command]
pub fn workflow_runtime_session(app: tauri::AppHandle) -> Result<RuntimeSession, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let status = runtime::start(&resource_dir, &data_dir);
    let base_url = status.base_url.ok_or_else(|| {
        status
            .error
            .unwrap_or_else(|| "runtime non disponibile".into())
    })?;

    let token = runtime::session::authenticate(&base_url).map_err(|e| e.to_string())?;
    Ok(RuntimeSession { base_url, token })
}

/// Dimentica le credenziali locali: serve se il database del runtime viene
/// azzerato e la password salvata non corrisponde più a niente.
#[tauri::command]
pub fn workflow_runtime_forget() -> Result<(), String> {
    runtime::session::forget().map_err(|e| e.to_string())
}
