//! Segreti nel keychain di sistema (macOS Keychain, Windows Credential
//! Manager, Linux Secret Service) via crate `keyring`.
//!
//! Convenzione chiavi:
//! - `ai.key.<provider>`  — API key BYOK del provider AI
//! - `accounts.v1`        — JSON degli account mail (incluse password IMAP/SMTP)
//!
//! Le operazioni keyring sono sincrone → `spawn_blocking` per non bloccare
//! il runtime Tauri.

use keyring::Entry;

const SERVICE: &str = "Medea";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        entry(&key)?.set_password(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_delete(key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}
