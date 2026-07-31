//! Repository promemoria locali (Tier F dei tool AI).
//! Notifiche OS-native gestite dal frontend tramite `tauri-plugin-notification`.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRow {
    pub id: i64,
    pub text: String,
    pub due_at: String,
    pub organization_id: Option<i64>,
    pub organization_name: Option<String>,
    pub message_id: Option<i64>,
    pub status: String,
    pub completed_at: Option<String>,
    pub last_fired_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub text: String,
    pub due_at: String,
    pub organization_id: Option<i64>,
    pub message_id: Option<i64>,
    pub notes: Option<String>,
}

pub fn add(conn: &Connection, r: &ReminderInput) -> Result<i64> {
    if r.text.trim().is_empty() {
        anyhow::bail!("Il testo del promemoria non può essere vuoto");
    }
    if r.due_at.trim().is_empty() {
        anyhow::bail!("La scadenza (dueAt) è obbligatoria");
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO reminders (text, due_at, organization_id, message_id, notes, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
        params![r.text.trim(), r.due_at, r.organization_id, r.message_id, r.notes, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Modifica un evento esistente. I campi `None` restano invariati.
/// È la primitiva dietro `calendar_update`: evita che spostare un
/// appuntamento crei un duplicato.
pub fn update(
    conn: &Connection,
    id: i64,
    title: Option<&str>,
    due_at: Option<&str>,
    notes: Option<&str>,
) -> Result<()> {
    if title.is_none() && due_at.is_none() && notes.is_none() {
        anyhow::bail!("Nessun campo da aggiornare (title, when o notes)");
    }
    let now = Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE reminders
            SET text    = COALESCE(?1, text),
                due_at  = COALESCE(?2, due_at),
                notes   = COALESCE(?3, notes),
                updated_at = ?4
          WHERE id = ?5 AND status IN ('pending','snoozed')",
        params![title, due_at, notes, now, id],
    )?;
    if updated == 0 {
        anyhow::bail!("Evento id={id} non trovato o già chiuso");
    }
    Ok(())
}

/// Ricerca eventi per testo o note (case-insensitive).
pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<ReminderRow>> {
    let needle = format!("%{query}%");
    let mut stmt = conn.prepare(
        "SELECT r.id, r.text, r.due_at, r.organization_id, o.display_name,
                r.message_id, r.status, r.completed_at, r.last_fired_at,
                r.created_at, r.updated_at, r.notes
           FROM reminders r
           LEFT JOIN organizations o ON o.id = r.organization_id
          WHERE r.text LIKE ?1 COLLATE NOCASE
             OR COALESCE(r.notes, '') LIKE ?1 COLLATE NOCASE
          ORDER BY r.due_at ASC
          LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![needle, limit], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn snooze(conn: &Connection, id: i64, new_due_at: &str) -> Result<()> {
    if new_due_at.trim().is_empty() {
        anyhow::bail!("newDueAt non può essere vuoto");
    }
    let now = Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE reminders
            SET due_at = ?1, status = 'snoozed', last_fired_at = COALESCE(last_fired_at, ?2), updated_at = ?2
          WHERE id = ?3 AND status IN ('pending','snoozed')",
        params![new_due_at, now, id],
    )?;
    if updated == 0 {
        anyhow::bail!("Promemoria id={id} non trovato o già completato");
    }
    Ok(())
}

pub fn mark_done(conn: &Connection, id: i64) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE reminders
            SET status = 'done', completed_at = ?1, updated_at = ?1
          WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn cancel(conn: &Connection, id: i64) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE reminders SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<ReminderRow>> {
    conn.query_row(
        "SELECT r.id, r.text, r.due_at, r.organization_id, o.display_name,
                r.message_id, r.status, r.completed_at, r.last_fired_at,
                r.created_at, r.updated_at, r.notes
           FROM reminders r
           LEFT JOIN organizations o ON o.id = r.organization_id
          WHERE r.id = ?1",
        params![id],
        map_row,
    )
    .optional()
    .map_err(anyhow::Error::from)
}

pub fn list_pending(conn: &Connection, limit: u32) -> Result<Vec<ReminderRow>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.text, r.due_at, r.organization_id, o.display_name,
                r.message_id, r.status, r.completed_at, r.last_fired_at,
                r.created_at, r.updated_at, r.notes
           FROM reminders r
           LEFT JOIN organizations o ON o.id = r.organization_id
          WHERE r.status IN ('pending','snoozed')
          ORDER BY r.due_at ASC
          LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_due_before(conn: &Connection, iso_now: &str) -> Result<Vec<ReminderRow>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.text, r.due_at, r.organization_id, o.display_name,
                r.message_id, r.status, r.completed_at, r.last_fired_at,
                r.created_at, r.updated_at, r.notes
           FROM reminders r
           LEFT JOIN organizations o ON o.id = r.organization_id
          WHERE r.status IN ('pending','snoozed')
            AND r.due_at <= ?1
            -- Già notificati dopo l'ultima scadenza: non li ripresentiamo.
            -- Uno snooze sposta `due_at` in avanti e li rende di nuovo idonei.
            AND (r.last_fired_at IS NULL OR r.last_fired_at < r.due_at)
          ORDER BY r.due_at ASC",
    )?;
    let rows = stmt
        .query_map(params![iso_now], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn mark_fired(conn: &Connection, id: i64) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE reminders SET last_fired_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReminderRow> {
    Ok(ReminderRow {
        id: r.get(0)?,
        text: r.get(1)?,
        due_at: r.get(2)?,
        organization_id: r.get(3)?,
        organization_name: r.get(4)?,
        message_id: r.get(5)?,
        status: r.get(6)?,
        completed_at: r.get(7)?,
        last_fired_at: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        notes: r.get(11)?,
    })
}
