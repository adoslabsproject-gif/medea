//! I comandi con cui l'applicazione decide se Medea resta al lavoro.
//!
//! Due interruttori distinti, perché rispondono a due domande diverse:
//! restare in funzione quando si chiude la finestra, e ripartire da soli dopo
//! che il computer si è riavviato. Il primo senza il secondo copre la giornata;
//! il secondo senza il primo non serve a niente.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::background::{stays_alive_when_closed, STAY_ALIVE_KEY};
use crate::db::settings;

/// Lo stato dei due interruttori, per la schermata delle impostazioni.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    /// Se chiudere la finestra lascia Medea al lavoro.
    pub stay_alive: bool,
    /// Se Medea riparte da sola all'accesso al computer.
    pub autostart: bool,
}

#[tauri::command]
pub fn background_status(app: AppHandle) -> Result<BackgroundStatus, String> {
    Ok(BackgroundStatus {
        stay_alive: stays_alive_when_closed(),
        // Lo stato vero lo conosce il sistema operativo, non una nostra
        // preferenza: qualcuno può aver tolto Medea dagli elementi di avvio
        // senza passare da qui.
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    })
}

#[tauri::command]
pub fn background_set_stay_alive(enabled: bool) -> Result<(), String> {
    settings::set_bool(STAY_ALIVE_KEY, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn background_set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())
}
