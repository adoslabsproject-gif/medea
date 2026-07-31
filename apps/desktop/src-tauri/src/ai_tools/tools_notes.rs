//! Tool memoria — nomi allineati all'app Liara (`note_*`).
//! Gli appunti sono i fatti durabili che rientrano nel system prompt.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;
use crate::db::notes::{NoteInput, NoteRow};

use super::helpers::{i, s};

fn row_json(n: &NoteRow) -> Value {
    json!({
        "id": n.id,
        "topic": n.topic,
        "text": n.text,
        "importance": n.importance,
        "createdAt": n.created_at,
    })
}

fn fmt(rows: &[NoteRow], empty: &str) -> String {
    if rows.is_empty() {
        return empty.to_string();
    }
    rows.iter()
        .map(|n| format!("#{} [{}] {}", n.id, n.topic, n.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Salva un appunto che l'assistente ricorderà nelle conversazioni future.
pub fn note_add(args: &Value) -> Result<Value> {
    let text = s(args, "text").ok_or_else(|| anyhow!("manca 'text'"))?;
    let topic = s(args, "topic");
    let input = NoteInput {
        topic: topic.clone(),
        text: text.clone(),
        source: Some("assistant".into()),
        importance: s(args, "importance"),
    };
    let id = db::with_db(|c| db::notes::add(c, &input))?;
    Ok(json!({
        "id": id,
        "text": format!(
            "Appunto salvato (#{id}) in «{}».",
            topic.unwrap_or_else(|| "generale".into())
        ),
    }))
}

/// Elenca gli appunti salvati, opzionalmente filtrati per argomento.
pub fn note_list(args: &Value) -> Result<Value> {
    let topic = s(args, "topic");
    let limit = i(args, "limit").unwrap_or(100).clamp(1, 500) as u32;
    let rows = db::with_db(|c| db::notes::list(c, topic.as_deref(), limit))?;
    Ok(json!({
        "count": rows.len(),
        "results": rows.iter().map(row_json).collect::<Vec<_>>(),
        "text": fmt(&rows, "Nessun appunto salvato."),
    }))
}

/// Cerca tra gli appunti per parola chiave (argomento o testo).
pub fn note_search(args: &Value) -> Result<Value> {
    let query = s(args, "query").ok_or_else(|| anyhow!("manca 'query'"))?;
    let rows = db::with_db(|c| db::notes::search(c, &query, 50))?;
    Ok(json!({
        "count": rows.len(),
        "results": rows.iter().map(row_json).collect::<Vec<_>>(),
        "text": fmt(&rows, &format!("Nessun appunto trovato per \"{query}\".")),
    }))
}

/// Elimina un appunto dato il suo id.
pub fn note_delete(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    db::with_db(|c| db::notes::delete(c, id))?;
    Ok(json!({ "id": id, "text": format!("Appunto #{id} eliminato.") }))
}
