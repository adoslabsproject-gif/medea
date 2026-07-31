//! Template email: la "carta intestata" applicata ai messaggi in uscita.
//!
//! Il corpo scritto dall'utente viene inserito al posto del segnaposto
//! `{{BODY}}`; gli altri segnaposto (`{{LOGO}}`, `{{SIGNATURE}}`, dati
//! azienda) sono risolti lato frontend al momento dell'invio.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmailTemplate {
    pub id: i64,
    pub name: String,
    pub is_default: bool,
    /// Logo come data URL (`data:image/png;base64,…`).
    pub logo_data_url: Option<String>,
    pub header_title: Option<String>,
    pub header_subtitle: Option<String>,
    pub footer_html: Option<String>,
    pub accent_color: String,
    /// HTML completo con `{{BODY}}`. Se assente si usa il layout generato
    /// dai campi qui sopra.
    pub custom_html: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmailTemplateInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub is_default: bool,
    pub logo_data_url: Option<String>,
    pub header_title: Option<String>,
    pub header_subtitle: Option<String>,
    pub footer_html: Option<String>,
    pub accent_color: Option<String>,
    pub custom_html: Option<String>,
}

pub fn upsert(conn: &Connection, t: &EmailTemplateInput) -> Result<i64> {
    if t.name.trim().is_empty() {
        anyhow::bail!("Il nome del template non può essere vuoto");
    }
    let now = Utc::now().to_rfc3339();
    let accent = t.accent_color.as_deref().unwrap_or("#4f46e5");
    let id = match t.id {
        Some(id) => {
            conn.execute(
                "UPDATE email_templates SET
                    name = ?1, is_default = ?2, logo_data_url = ?3,
                    header_title = ?4, header_subtitle = ?5, footer_html = ?6,
                    accent_color = ?7, custom_html = ?8, updated_at = ?9
                 WHERE id = ?10",
                params![
                    t.name.trim(), t.is_default as i32, t.logo_data_url,
                    t.header_title, t.header_subtitle, t.footer_html,
                    accent, t.custom_html, now, id
                ],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO email_templates
                    (name, is_default, logo_data_url, header_title, header_subtitle,
                     footer_html, accent_color, custom_html, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
                params![
                    t.name.trim(), t.is_default as i32, t.logo_data_url,
                    t.header_title, t.header_subtitle, t.footer_html,
                    accent, t.custom_html, now
                ],
            )?;
            conn.last_insert_rowid()
        }
    };
    // Un solo default per volta.
    if t.is_default {
        conn.execute(
            "UPDATE email_templates SET is_default = 0 WHERE id <> ?1",
            params![id],
        )?;
    }
    Ok(id)
}

pub fn list(conn: &Connection) -> Result<Vec<EmailTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, is_default, logo_data_url, header_title, header_subtitle,
                footer_html, accent_color, custom_html, created_at, updated_at
           FROM email_templates
          ORDER BY is_default DESC, name COLLATE NOCASE ASC",
    )?;
    let rows = stmt
        .query_map([], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Template predefinito, se ne esiste uno.
pub fn get_default(conn: &Connection) -> Result<Option<EmailTemplate>> {
    conn.query_row(
        "SELECT id, name, is_default, logo_data_url, header_title, header_subtitle,
                footer_html, accent_color, custom_html, created_at, updated_at
           FROM email_templates
          WHERE is_default = 1
          LIMIT 1",
        [],
        map_row,
    )
    .optional()
    .map_err(anyhow::Error::from)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM email_templates WHERE id = ?1", params![id])?;
    Ok(())
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EmailTemplate> {
    Ok(EmailTemplate {
        id: r.get(0)?,
        name: r.get(1)?,
        is_default: r.get::<_, i64>(2)? != 0,
        logo_data_url: r.get(3)?,
        header_title: r.get(4)?,
        header_subtitle: r.get(5)?,
        footer_html: r.get(6)?,
        accent_color: r.get(7)?,
        custom_html: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}
