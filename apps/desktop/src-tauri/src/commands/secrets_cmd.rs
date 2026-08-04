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

/// Quanto si aspetta il portachiavi prima di rinunciare.
///
/// La lettura di un segreto è istantanea quando il portachiavi è sbloccato.
/// Quando non lo è, il sistema mostra una richiesta di password e la chiamata
/// resta ferma **finché qualcuno non risponde** — o per sempre, se quella
/// finestra viene ignorata o non compare affatto.
///
/// Da fuori si vede un'applicazione bloccata senza motivo: nessuna richiesta
/// di rete, nessun errore, niente nei log. È così che il wizard restava
/// «in costruzione» per minuti senza aver mai parlato col modello.
const ATTESA_PORTACHIAVI: std::time::Duration = std::time::Duration::from_secs(20);

#[tauri::command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> {
    let nome = key.clone();
    let lettura = tokio::task::spawn_blocking(move || match entry(&key)?.get_password() {
        Ok(v) => Ok::<Option<String>, String>(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    });

    match tokio::time::timeout(ATTESA_PORTACHIAVI, lettura).await {
        Ok(esito) => esito.map_err(|e| e.to_string())?,
        Err(_) => {
            tracing::warn!("Portachiavi: «{nome}» non risponde entro il tempo previsto");
            Err(
                "Il portachiavi di sistema non risponde. Se è comparsa una richiesta di password, \
                 rispondi e riprova; altrimenti riapri Medea."
                    .to_string(),
            )
        }
    }
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
