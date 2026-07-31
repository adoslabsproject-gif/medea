//! Tauri commands esposti al frontend React.

pub mod ai_cmd;
pub mod ai_tools_cmd;
pub mod claude_cli_cmd;
pub mod db_cmd;
pub mod imap_cmd;
pub mod secrets_cmd;
pub mod smtp_cmd;
pub mod sync_cmd;
pub mod template_cmd;
pub mod workflow_cmd;

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
