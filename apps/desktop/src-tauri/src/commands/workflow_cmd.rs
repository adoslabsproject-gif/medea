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
