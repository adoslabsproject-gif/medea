//! Tauri commands per il tool registry deterministico AI.

use serde_json::Value;

use crate::ai_tools;

#[tauri::command]
pub fn ai_tools_list() -> Vec<ai_tools::ToolDescriptor> {
    ai_tools::registry()
}

#[tauri::command]
pub fn ai_tools_call(name: String, args: Value) -> Result<Value, String> {
    ai_tools::execute(&name, &args).map_err(|e| e.to_string())
}
