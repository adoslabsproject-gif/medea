//! Comandi Tauri per i template email (carta intestata dei messaggi in uscita).

use crate::db;
use crate::db::templates::{EmailTemplate, EmailTemplateInput};

#[tauri::command]
pub fn db_template_list() -> Result<Vec<EmailTemplate>, String> {
    db::with_db(|c| db::templates::list(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_template_default() -> Result<Option<EmailTemplate>, String> {
    db::with_db(|c| db::templates::get_default(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_template_upsert(template: EmailTemplateInput) -> Result<i64, String> {
    db::with_db(|c| db::templates::upsert(c, &template)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_template_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::templates::delete(c, id)).map_err(|e| e.to_string())
}
