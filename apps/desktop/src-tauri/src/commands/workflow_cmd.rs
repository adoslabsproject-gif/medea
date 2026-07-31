//! Comandi Tauri per le automazioni disegnate sul canvas.

use crate::db;
use crate::db::workflows::{WorkflowInput, WorkflowRow, WorkflowSummary};

#[tauri::command]
pub fn workflow_list() -> Result<Vec<WorkflowSummary>, String> {
    db::with_db(|c| db::workflows::list(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_get(id: i64) -> Result<Option<WorkflowRow>, String> {
    db::with_db(|c| db::workflows::get(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_save(workflow: WorkflowInput) -> Result<i64, String> {
    db::with_db(|c| db::workflows::upsert(c, &workflow)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_set_enabled(id: i64, enabled: bool) -> Result<(), String> {
    db::with_db(|c| db::workflows::set_enabled(c, id, enabled)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::workflows::delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_duplicate(id: i64) -> Result<i64, String> {
    db::with_db(|c| db::workflows::duplicate(c, id)).map_err(|e| e.to_string())
}

/// Registra con che nome il runtime conosce questo workflow.
#[tauri::command]
pub fn workflow_set_runtime_id(id: i64, runtime_id: String) -> Result<(), String> {
    db::with_db(|c| db::workflows::set_runtime_id(c, id, &runtime_id)).map_err(|e| e.to_string())
}

// ── Storico delle esecuzioni ────────────────────────────────────────────────

use crate::db::workflow_runs::{RunInput, RunRow, RunSummary};

/// Le ultime esecuzioni di un workflow. Il limite evita di caricare anni di
/// storico per mostrarne dieci righe.
#[tauri::command]
pub fn workflow_run_list(workflow_id: i64, limit: Option<i64>) -> Result<Vec<RunSummary>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    db::with_db(|c| db::workflow_runs::list(c, workflow_id, limit)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_run_get(id: String) -> Result<Option<RunRow>, String> {
    db::with_db(|c| db::workflow_runs::get(c, &id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_run_save(run: RunInput) -> Result<(), String> {
    db::with_db(|c| db::workflow_runs::upsert(c, &run)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_run_delete(id: String) -> Result<(), String> {
    db::with_db(|c| db::workflow_runs::delete(c, &id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_run_clear(workflow_id: i64) -> Result<usize, String> {
    db::with_db(|c| db::workflow_runs::clear(c, workflow_id)).map_err(|e| e.to_string())
}
