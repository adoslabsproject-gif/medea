//! Repository contacts: auto-populated dalle email viste.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};

/// Inserisce o aggiorna un contatto a partire da un indirizzo email + nome.
/// Aggiorna `last_seen_at` e incrementa `message_count`.
/// Auto-collega all'organizzazione tramite dominio (se esiste, altrimenti la crea).
pub fn touch(
    conn: &Connection,
    email: &str,
    name: Option<&str>,
    seen_at: &str,
) -> Result<i64> {
    let email_norm = email.trim().to_lowercase();
    if email_norm.is_empty() {
        anyhow::bail!("Empty email");
    }
    let now = Utc::now().to_rfc3339();
    let domain = email_norm.rsplit('@').next().unwrap_or("").to_string();

    // Trova o crea organizzazione per dominio
    let org_id: Option<i64> = if !domain.is_empty() {
        conn.execute(
            "INSERT OR IGNORE INTO organizations (domain, display_name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![domain, guess_org_name(&domain), now, now],
        )?;
        conn.query_row(
            "SELECT id FROM organizations WHERE domain = ?1",
            params![domain],
            |r| r.get::<_, i64>(0),
        )
        .ok()
    } else {
        None
    };

    // Upsert contatto
    conn.execute(
        "INSERT INTO contacts (email_address, display_name, organization_id,
                               first_seen_at, last_seen_at, message_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5, ?5)
         ON CONFLICT(email_address) DO UPDATE SET
             display_name = COALESCE(NULLIF(excluded.display_name, ''), contacts.display_name),
             organization_id = COALESCE(contacts.organization_id, excluded.organization_id),
             last_seen_at = MAX(contacts.last_seen_at, excluded.last_seen_at),
             message_count = contacts.message_count + 1,
             updated_at = excluded.updated_at",
        params![email_norm, name.unwrap_or(""), org_id, seen_at, now],
    )?;

    let id: i64 = conn.query_row(
        "SELECT id FROM contacts WHERE email_address = ?1",
        params![email_norm],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// Heuristica iniziale per il nome organizzazione: "acme.it" → "Acme".
/// L'utente potrà editarlo manualmente.
fn guess_org_name(domain: &str) -> String {
    let core = domain.split('.').next().unwrap_or(domain);
    let mut c = core.chars();
    match c.next() {
        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
        None => domain.to_string(),
    }
}
