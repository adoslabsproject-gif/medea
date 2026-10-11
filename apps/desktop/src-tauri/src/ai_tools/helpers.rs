//! Helper di parsing argomenti tool — usati da tutti i moduli `tools_*`.

use anyhow::{anyhow, Result};
use serde_json::Value;

pub fn s(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
pub fn i(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}
pub fn f(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| v.as_f64())
}
pub fn ar<'a>(args: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    args.get(key).and_then(|v| v.as_array())
}

/// Account su cui operare: `accountId` se il modello lo passa, altrimenti
/// l'unico account configurato.
///
/// Un modello chiama volentieri `email_recent {count}` senza dire su quale
/// casella: con un solo account la risposta è ovvia, e senza questo fallback
/// riceverebbe un errore di argomento mancante.
pub fn account_id(args: &Value) -> Result<String> {
    if let Some(id) = s(args, "accountId").filter(|v| !v.trim().is_empty()) {
        return Ok(id);
    }
    let accounts = crate::db::with_db(|c| crate::db::accounts::list(c))?;
    match accounts.len() {
        0 => Err(anyhow!(
            "Nessun account email configurato in Medea: l'utente deve aggiungerne uno."
        )),
        _ => Ok(accounts[0].id.clone()),
    }
}
