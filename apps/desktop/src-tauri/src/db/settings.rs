//! Le preferenze dell'applicazione, in chiave e valore.
//!
//! Vivono nel database e non nel browser perché servono anche a chi il browser
//! non ce l'ha: quando Medea deve decidere se restare al lavoro a finestra
//! chiusa, la domanda arriva dal lato Rust, mentre la pagina si sta smontando.
//! Una preferenza in `localStorage` lì non è leggibile.
//!
//! La tabella `app_settings` esiste dalla versione 6 dello schema.

use anyhow::Result;

use super::with_db;

/// Legge una preferenza. `None` se non è mai stata scritta.
pub fn get(key: &str) -> Result<Option<String>> {
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        match rows.next()? {
            Some(row) => Ok(row.get::<_, Option<String>>(0)?),
            None => Ok(None),
        }
    })
}

/// Scrive una preferenza, sovrascrivendo quella che c'era.
pub fn set(key: &str, value: &str) -> Result<()> {
    with_db(|conn| {
        conn.execute(
            "INSERT INTO app_settings(key, value, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
            rusqlite::params![key, value],
        )?;
        Ok(())
    })
}

/// Legge una preferenza booleana. Un valore mai scritto vale `false`: le cose
/// che cambiano il comportamento dell'applicazione si accendono di proposito.
pub fn get_bool(key: &str) -> bool {
    matches!(get(key).ok().flatten().as_deref(), Some("true"))
}

/// Scrive una preferenza booleana.
pub fn set_bool(key: &str, value: bool) -> Result<()> {
    set(key, if value { "true" } else { "false" })
}
