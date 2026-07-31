//! Tool agenda/promemoria — nomi allineati all'app Liara (`calendar_*`),
//! così il modello fine-tuned li riconosce dal training.
//!
//! Storage: tabella `reminders` (title = `text`, when = `due_at`, notes).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;
use crate::db::reminders::{
    add as add_db, cancel as cancel_db, get as get_db, list_pending, search as search_db,
    snooze as snooze_db, update as update_db, ReminderInput, ReminderRow,
};

use super::helpers::{i, s};

fn row_json(r: &ReminderRow) -> Value {
    json!({
        "id": r.id,
        "title": r.text,
        "when": r.due_at,
        "notes": r.notes,
        "status": r.status,
        "organizationId": r.organization_id,
        "organizationName": r.organization_name,
        "messageId": r.message_id,
    })
}

fn fmt_list(rows: &[ReminderRow], empty: &str) -> String {
    if rows.is_empty() {
        return empty.to_string();
    }
    rows.iter()
        .map(|r| format!("#{} — {} ({})", r.id, r.text, r.due_at))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Crea un evento/appuntamento in agenda.
pub fn calendar_add(args: &Value) -> Result<Value> {
    let title = s(args, "title").ok_or_else(|| anyhow!("manca 'title'"))?;
    let when = s(args, "when").ok_or_else(|| anyhow!("manca 'when' (AAAA-MM-GG HH:MM)"))?;
    let input = ReminderInput {
        text: title.clone(),
        due_at: when.clone(),
        organization_id: i(args, "organizationId"),
        message_id: i(args, "messageId"),
        notes: s(args, "notes"),
    };
    let id = db::with_db(|c| add_db(c, &input))?;
    Ok(json!({
        "id": id,
        "title": title,
        "when": when,
        "text": format!("Evento creato (#{id}): {title} — {when}"),
    }))
}

/// Elenca i prossimi eventi in agenda.
pub fn calendar_list(args: &Value) -> Result<Value> {
    let count = i(args, "count").unwrap_or(10).clamp(1, 200) as u32;
    let rows = db::with_db(|c| list_pending(c, count))?;
    Ok(json!({
        "count": rows.len(),
        "results": rows.iter().map(row_json).collect::<Vec<_>>(),
        "text": fmt_list(&rows, "L'agenda è vuota: nessun evento."),
    }))
}

/// Cerca eventi per titolo o note.
pub fn calendar_search(args: &Value) -> Result<Value> {
    let query = s(args, "query").ok_or_else(|| anyhow!("manca 'query'"))?;
    let rows = db::with_db(|c| search_db(c, &query, 50))?;
    Ok(json!({
        "count": rows.len(),
        "results": rows.iter().map(row_json).collect::<Vec<_>>(),
        "text": fmt_list(&rows, &format!("Nessun evento trovato per \"{query}\".")),
    }))
}

/// Elimina (annulla) un evento dato il suo id.
pub fn calendar_delete(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let existing = db::with_db(|c| get_db(c, id))?
        .ok_or_else(|| anyhow!("Evento #{id} non trovato"))?;
    db::with_db(|c| cancel_db(c, id))?;
    Ok(json!({
        "id": id,
        "title": existing.text,
        "text": format!("Evento #{id} eliminato."),
    }))
}

/// Modifica un evento ESISTENTE (sposta/rinomina) senza duplicarlo.
pub fn calendar_update(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let title = s(args, "title");
    let when = s(args, "when");
    let notes = s(args, "notes");
    db::with_db(|c| update_db(c, id, title.as_deref(), when.as_deref(), notes.as_deref()))?;
    let updated = db::with_db(|c| get_db(c, id))?
        .ok_or_else(|| anyhow!("Evento #{id} non più leggibile dopo l'update"))?;
    let mut changed: Vec<String> = Vec::new();
    if title.is_some() { changed.push(format!("titolo → {}", updated.text)); }
    if when.is_some() { changed.push(format!("data → {}", updated.due_at)); }
    if notes.is_some() { changed.push("note aggiornate".into()); }
    Ok(json!({
        "id": id,
        "title": updated.text,
        "when": updated.due_at,
        "notes": updated.notes,
        "text": format!("Evento #{id} aggiornato: {}", changed.join(", ")),
    }))
}

/// Posticipa un evento a una nuova scadenza.
pub fn calendar_snooze(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let new_due_at = s(args, "when")
        .or_else(|| s(args, "newDueAt"))
        .ok_or_else(|| anyhow!("manca 'when' (nuova scadenza)"))?;
    db::with_db(|c| snooze_db(c, id, &new_due_at))?;
    Ok(json!({
        "id": id,
        "when": new_due_at,
        "text": format!("Evento #{id} riprogrammato a {new_due_at}."),
    }))
}
