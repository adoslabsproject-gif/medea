//! Tauri commands per il tool registry deterministico AI.

use serde_json::Value;

use crate::ai_tools;

#[tauri::command]
pub fn ai_tools_list() -> Vec<ai_tools::ToolDescriptor> {
    ai_tools::registry()
}

/// Esegue uno strumento.
///
/// Fuori dal filo principale: uno strumento può andare in rete o leggere un
/// allegato grosso, e un comando sincrono terrebbe ferma tutta la finestra
/// finché non ha finito.
#[tauri::command]
pub async fn ai_tools_call(name: String, args: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || ai_tools::execute(&name, &args).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("lo strumento si è interrotto: {e}"))?
}
