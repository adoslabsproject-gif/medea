//! I comandi con cui la pagina accende e spegne il canale verso l'esterno.
//!
//! La pagina non apre più il WebSocket da sé: chiede, e ascolta l'evento
//! `relay://stato` per sapere com'è andata. Così l'indirizzo del relay può
//! essere qualunque — anche un server di chi usa Medea — senza dover elencare
//! le destinazioni permesse nella CSP.

use tauri::AppHandle;

use crate::relay::{self, RelayState};

#[tauri::command]
pub fn relay_start(app: AppHandle, base_url: String, token: String) -> Result<(), String> {
    relay::start(app, base_url, token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn relay_stop(app: AppHandle) {
    relay::stop(&app);
}

#[tauri::command]
pub fn relay_status() -> RelayState {
    relay::status()
}
