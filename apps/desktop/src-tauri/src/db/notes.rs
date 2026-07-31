//! Appunti / memorie persistenti dell'assistente.
//!
//! Sono i fatti durabili che vengono iniettati nel system prompt di ogni
//! conversazione, e la base dei tool `note_*` (nomi allineati all'app Liara).

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub id: i64,
    pub topic: String,
    pub text: String,
    /// `manual` | `assistant`
    pub source: String,
    /// `low` | `normal` | `high`
    pub importance: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    pub topic: Option<String>,
    pub text: String,
    pub source: Option<String>,
    pub importance: Option<String>,
}

const DEFAULT_TOPIC: &str = "generale";

pub fn add(conn: &Connection, n: &NoteInput) -> Result<i64> {
    let text = n.text.trim();
    if text.is_empty() {
        anyhow::bail!("Il testo dell'appunto non può essere vuoto");
    }
    let topic = n
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(DEFAULT_TOPIC);
    // Dedup: stesso testo nello stesso argomento non crea un doppione.
    if let Ok(id) = conn.query_row(
        "SELECT id FROM notes WHERE topic = ?1 AND text = ?2",
        params![topic, text],
        |r| r.get::<_, i64>(0),
    ) {
        return Ok(id);
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notes (topic, text, source, importance, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            topic,
            text,
            n.source.as_deref().unwrap_or("manual"),
            n.importance.as_deref().unwrap_or("normal"),
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list(conn: &Connection, topic: Option<&str>, limit: u32) -> Result<Vec<NoteRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, topic, text, source, importance, created_at, updated_at
           FROM notes
          WHERE (?1 IS NULL OR topic = ?1 COLLATE NOCASE)
          ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                   created_at DESC
          LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![topic, limit], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<NoteRow>> {
    let needle = format!("%{query}%");
    let mut stmt = conn.prepare(
        "SELECT id, topic, text, source, importance, created_at, updated_at
           FROM notes
          WHERE topic LIKE ?1 COLLATE NOCASE OR text LIKE ?1 COLLATE NOCASE
          ORDER BY created_at DESC
          LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![needle, limit], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn update(conn: &Connection, id: i64, text: Option<&str>, importance: Option<&str>) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE notes
            SET text = COALESCE(?1, text),
                importance = COALESCE(?2, importance),
                updated_at = ?3
          WHERE id = ?4",
        params![text, importance, now, id],
    )?;
    if updated == 0 {
        anyhow::bail!("Appunto #{id} non trovato");
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<NoteRow> {
    Ok(NoteRow {
        id: r.get(0)?,
        topic: r.get(1)?,
        text: r.get(2)?,
        source: r.get(3)?,
        importance: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}
