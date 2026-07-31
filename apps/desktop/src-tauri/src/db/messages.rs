//! Repository messages: insert da sync IMAP, query per UI, ricerca FTS5.

use anyhow::Result;
use chrono::{DateTime, Datelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const BODY_CAP: usize = 500_000; // 500 KB max per body_text/body_html

#[derive(Debug, Clone)]
pub struct InsertMessage<'a> {
    pub account_id: &'a str,
    pub folder_id: i64,
    pub uid: u32,
    pub uid_validity: Option<u32>,
    pub message_id: Option<&'a str>,
    pub in_reply_to: Option<&'a str>,
    pub references_json: &'a str,
    pub thread_id: Option<&'a str>,
    pub subject: Option<&'a str>,
    pub from_name: Option<&'a str>,
    pub from_address: Option<&'a str>,
    pub to_json: &'a str,
    pub cc_json: &'a str,
    pub bcc_json: &'a str,
    pub internal_date: Option<DateTime<Utc>>,
    pub size_bytes: u32,
    pub has_attachments: bool,
    pub is_seen: bool,
    pub is_flagged: bool,
    pub body_text: Option<&'a str>,
    pub body_html: Option<&'a str>,
    pub preview: Option<&'a str>,
    pub raw_eml: Option<&'a [u8]>,
}

/// Inserisce un messaggio nel DB, dedupando per (account_id, message_id).
/// Ritorna `(id, inserted)`: `inserted = false` quando la riga esisteva già
/// (aggiornamento) — serve al sync per contatori onesti.
pub fn upsert(conn: &Connection, m: &InsertMessage<'_>) -> Result<(i64, bool)> {
    let now = Utc::now().to_rfc3339();
    let year = m.internal_date.map(|d| d.year());
    let (body_text, trunc1) = cap(m.body_text);
    let (body_html, trunc2) = cap(m.body_html);
    let body_truncated = (trunc1 || trunc2) as i32;

    // Strategia: se message_id presente, dedup per (account, message_id).
    // Altrimenti dedup per (account, folder, uid).
    let existing_id: Option<i64> = if let Some(mid) = m.message_id {
        conn.query_row(
            "SELECT id FROM messages WHERE account_id = ?1 AND message_id = ?2",
            params![m.account_id, mid],
            |r| r.get(0),
        )
        .optional()?
    } else {
        conn.query_row(
            "SELECT id FROM messages WHERE account_id = ?1 AND primary_folder_id = ?2 AND uid = ?3",
            params![m.account_id, m.folder_id, m.uid],
            |r| r.get(0),
        )
        .optional()?
    };

    if let Some(id) = existing_id {
        conn.execute(
            "UPDATE messages SET
                is_seen = ?1,
                is_flagged = ?2,
                subject = COALESCE(NULLIF(?3, ''), subject),
                from_name = COALESCE(NULLIF(?4, ''), from_name),
                from_address = COALESCE(NULLIF(?5, ''), from_address),
                to_json = CASE
                    WHEN length(?6) > 2 AND (to_json IS NULL OR to_json = '[]') THEN ?6
                    ELSE to_json END,
                cc_json = CASE
                    WHEN length(?7) > 2 AND (cc_json IS NULL OR cc_json = '[]') THEN ?7
                    ELSE cc_json END,
                bcc_json = CASE
                    WHEN length(?8) > 2 AND (bcc_json IS NULL OR bcc_json = '[]') THEN ?8
                    ELSE bcc_json END,
                body_text = COALESCE(NULLIF(?9, ''), body_text),
                body_html = COALESCE(NULLIF(?10, ''), body_html),
                preview = COALESCE(NULLIF(?11, ''), preview),
                has_attachments = ?12,
                raw_eml = COALESCE(?13, raw_eml),
                updated_at = ?14
              WHERE id = ?15",
            params![
                m.is_seen as i32,
                m.is_flagged as i32,
                m.subject.unwrap_or(""),
                m.from_name.unwrap_or(""),
                m.from_address.unwrap_or(""),
                m.to_json,
                m.cc_json,
                m.bcc_json,
                m.body_text.unwrap_or(""),
                m.body_html.unwrap_or(""),
                m.preview.unwrap_or(""),
                m.has_attachments as i32,
                m.raw_eml,
                now,
                id,
            ],
        )?;
        record_folder_uid(conn, m.folder_id, m.uid, id)?;
        return Ok((id, false));
    }

    conn.execute(
        "INSERT INTO messages (
            account_id, primary_folder_id, uid, uid_validity,
            message_id, in_reply_to, references_json, thread_id,
            subject, from_name, from_address,
            to_json, cc_json, bcc_json,
            internal_date, year_partition, size_bytes, has_attachments,
            is_seen, is_flagged, is_draft, is_local_deleted,
            body_text, body_html, body_truncated, preview,
            raw_eml,
            created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4,
            ?5, ?6, ?7, ?8,
            ?9, ?10, ?11,
            ?12, ?13, ?14,
            ?15, ?16, ?17, ?18,
            ?19, ?20, 0, 0,
            ?21, ?22, ?23, ?24,
            ?25,
            ?26, ?26
        )",
        params![
            m.account_id,
            m.folder_id,
            m.uid,
            m.uid_validity,
            m.message_id,
            m.in_reply_to,
            m.references_json,
            m.thread_id,
            m.subject,
            m.from_name,
            m.from_address,
            m.to_json,
            m.cc_json,
            m.bcc_json,
            m.internal_date.map(|d| d.to_rfc3339()),
            year,
            m.size_bytes,
            m.has_attachments as i32,
            m.is_seen as i32,
            m.is_flagged as i32,
            body_text,
            body_html,
            body_truncated,
            m.preview,
            m.raw_eml,
            now,
        ],
    )?;

    let id = conn.last_insert_rowid();
    record_folder_uid(conn, m.folder_id, m.uid, id)?;
    Ok((id, true))
}

/// Registra il mapping (folder, uid) → message. È il set letto da
/// `known_uids`: senza, un messaggio già in DB sotto un'altra cartella
/// verrebbe riscaricato per intero a ogni sync di questa.
fn record_folder_uid(conn: &Connection, folder_id: i64, uid: u32, message_id: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO folder_message_uids (folder_id, uid, message_id)
         VALUES (?1, ?2, ?3)",
        params![folder_id, uid, message_id],
    )?;
    Ok(())
}

fn cap(s: Option<&str>) -> (Option<String>, bool) {
    match s {
        None => (None, false),
        Some(s) if s.len() <= BODY_CAP => (Some(s.to_string()), false),
        Some(s) => {
            // Cap su char boundary più vicino
            let mut end = BODY_CAP;
            while !s.is_char_boundary(end) && end > 0 {
                end -= 1;
            }
            (Some(s[..end].to_string()), true)
        }
    }
}

/// Esiste già il messaggio (per evitare di fare FETCH BODY sul server)?
pub fn exists(conn: &Connection, account_id: &str, folder_id: i64, uid: u32) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE account_id = ?1 AND primary_folder_id = ?2 AND uid = ?3",
        params![account_id, folder_id, uid],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// UID già visti per una folder (set per diff con server). Unione tra le
/// righe primarie e il mapping `folder_message_uids`, che copre i messaggi
/// la cui riga primaria vive in un'altra cartella (multi-label).
pub fn known_uids(conn: &Connection, account_id: &str, folder_id: i64) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid FROM messages WHERE account_id = ?1 AND primary_folder_id = ?2
         UNION
         SELECT uid FROM folder_message_uids WHERE folder_id = ?2",
    )?;
    let uids = stmt
        .query_map(params![account_id, folder_id], |r| r.get::<_, i64>(0))?
        .map(|r| r.map(|v| v as u32))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(uids)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListedMessage {
    pub id: i64,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub to_json: String,
    pub preview: Option<String>,
    pub internal_date: Option<String>,
    pub is_seen: bool,
    pub is_flagged: bool,
    pub has_attachments: bool,
    pub size: u32,
    pub folder_path: Option<String>,
}

/// Messaggi che coinvolgono un dominio (sia in `from_address` sia in `to_json`).
/// Usato dalla scheda partner → tab Comunicazioni.
pub fn list_for_domain(
    conn: &Connection,
    account_id: &str,
    domain: &str,
    limit: u32,
) -> Result<Vec<ListedMessage>> {
    let needle_from = format!("%@{}", domain);
    let needle_to = format!("%@{}%", domain);
    let mut stmt = conn.prepare(
        "SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_address,
                m.to_json, m.preview,
                m.internal_date, m.is_seen, m.is_flagged, m.has_attachments, m.size_bytes,
                f.path
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE m.account_id = ?1
            AND m.is_local_deleted = 0
            AND ( LOWER(m.from_address) LIKE LOWER(?2)
               OR LOWER(m.to_json)      LIKE LOWER(?3) )
          ORDER BY m.internal_date DESC, m.uid DESC
          LIMIT ?4",
    )?;
    let rows = stmt
        .query_map(params![account_id, needle_from, needle_to, limit], |r| {
            Ok(ListedMessage {
                id: r.get(0)?,
                uid: r.get::<_, i64>(1)? as u32,
                message_id: r.get(2)?,
                subject: r.get(3)?,
                from_name: r.get(4)?,
                from_address: r.get(5)?,
                to_json: r.get(6)?,
                preview: r.get(7)?,
                internal_date: r.get(8)?,
                is_seen: r.get::<_, i64>(9)? != 0,
                is_flagged: r.get::<_, i64>(10)? != 0,
                has_attachments: r.get::<_, i64>(11)? != 0,
                size: r.get::<_, i64>(12)? as u32,
                folder_path: r.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Email scambiate con UN indirizzo specifico (in/out), su TUTTI gli account.
/// Usato dalla Rubrica per la vista "email di questo contatto".
pub fn list_for_address(
    conn: &Connection,
    address: &str,
    limit: u32,
) -> Result<Vec<ListedMessage>> {
    let needle_to = format!("%{}%", address);
    let mut stmt = conn.prepare(
        "SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_address,
                m.to_json, m.preview,
                m.internal_date, m.is_seen, m.is_flagged, m.has_attachments, m.size_bytes,
                f.path
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE m.is_local_deleted = 0
            AND ( LOWER(m.from_address) = LOWER(?1)
               OR LOWER(m.to_json)      LIKE LOWER(?2) )
          ORDER BY m.internal_date DESC, m.uid DESC
          LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![address, needle_to, limit], |r| {
            Ok(ListedMessage {
                id: r.get(0)?,
                uid: r.get::<_, i64>(1)? as u32,
                message_id: r.get(2)?,
                subject: r.get(3)?,
                from_name: r.get(4)?,
                from_address: r.get(5)?,
                to_json: r.get(6)?,
                preview: r.get(7)?,
                internal_date: r.get(8)?,
                is_seen: r.get::<_, i64>(9)? != 0,
                is_flagged: r.get::<_, i64>(10)? != 0,
                has_attachments: r.get::<_, i64>(11)? != 0,
                size: r.get::<_, i64>(12)? as u32,
                folder_path: r.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Ultimi N messaggi dell'account su TUTTE le cartelle, ordinati per data desc.
/// Usato dall'AI per costruire un contesto live sempre fresco.
pub fn list_recent_global(
    conn: &Connection,
    account_id: &str,
    limit: u32,
) -> Result<Vec<ListedMessage>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_address,
                m.to_json, m.preview,
                m.internal_date, m.is_seen, m.is_flagged, m.has_attachments, m.size_bytes,
                f.path
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE m.account_id = ?1
            AND m.is_local_deleted = 0
          ORDER BY m.internal_date DESC, m.uid DESC
          LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![account_id, limit], |r| {
            Ok(ListedMessage {
                id: r.get(0)?,
                uid: r.get::<_, i64>(1)? as u32,
                message_id: r.get(2)?,
                subject: r.get(3)?,
                from_name: r.get(4)?,
                from_address: r.get(5)?,
                to_json: r.get(6)?,
                preview: r.get(7)?,
                internal_date: r.get(8)?,
                is_seen: r.get::<_, i64>(9)? != 0,
                is_flagged: r.get::<_, i64>(10)? != 0,
                has_attachments: r.get::<_, i64>(11)? != 0,
                size: r.get::<_, i64>(12)? as u32,
                folder_path: r.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_for_folder(
    conn: &Connection,
    account_id: &str,
    folder_id: i64,
    limit: u32,
    offset: u32,
) -> Result<Vec<ListedMessage>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_address,
                m.to_json, m.preview,
                m.internal_date, m.is_seen, m.is_flagged, m.has_attachments, m.size_bytes,
                f.path
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE m.account_id = ?1
            AND m.primary_folder_id = ?2
            AND m.is_local_deleted = 0
          ORDER BY m.internal_date DESC, m.uid DESC
          LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt
        .query_map(params![account_id, folder_id, limit, offset], |r| {
            Ok(ListedMessage {
                id: r.get(0)?,
                uid: r.get::<_, i64>(1)? as u32,
                message_id: r.get(2)?,
                subject: r.get(3)?,
                from_name: r.get(4)?,
                from_address: r.get(5)?,
                to_json: r.get(6)?,
                preview: r.get(7)?,
                internal_date: r.get(8)?,
                is_seen: r.get::<_, i64>(9)? != 0,
                is_flagged: r.get::<_, i64>(10)? != 0,
                has_attachments: r.get::<_, i64>(11)? != 0,
                size: r.get::<_, i64>(12)? as u32,
                folder_path: r.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FullMessage {
    #[serde(flatten)]
    pub summary: ListedMessage,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
}

pub fn get_full(conn: &Connection, id: i64) -> Result<Option<FullMessage>> {
    conn.query_row(
        "SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_address,
                m.to_json, m.preview,
                m.internal_date, m.is_seen, m.is_flagged, m.has_attachments, m.size_bytes,
                f.path,
                m.body_text, m.body_html, m.cc_json, m.bcc_json,
                m.in_reply_to, m.references_json
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE m.id = ?1",
        params![id],
        |r| {
            let to_json: String = r.get(6)?;
            let cc_json: String = r.get(16)?;
            let bcc_json: String = r.get(17)?;
            let refs_json: String = r.get(19)?;
            Ok(FullMessage {
                summary: ListedMessage {
                    id: r.get(0)?,
                    uid: r.get::<_, i64>(1)? as u32,
                    message_id: r.get(2)?,
                    subject: r.get(3)?,
                    from_name: r.get(4)?,
                    from_address: r.get(5)?,
                    to_json: to_json.clone(),
                    preview: r.get(7)?,
                    internal_date: r.get(8)?,
                    is_seen: r.get::<_, i64>(9)? != 0,
                    is_flagged: r.get::<_, i64>(10)? != 0,
                    has_attachments: r.get::<_, i64>(11)? != 0,
                    size: r.get::<_, i64>(12)? as u32,
                    folder_path: r.get(13)?,
                },
                body_text: r.get(14)?,
                body_html: r.get(15)?,
                to: serde_json::from_str(&to_json).unwrap_or_default(),
                cc: serde_json::from_str(&cc_json).unwrap_or_default(),
                bcc: serde_json::from_str(&bcc_json).unwrap_or_default(),
                in_reply_to: r.get(18)?,
                references: serde_json::from_str(&refs_json).unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(|e| anyhow::anyhow!("DB query: {e}"))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message_id: i64,
    pub snippet: String,
    pub rank: f64,
    pub subject: Option<String>,
    pub from_address: Option<String>,
    pub internal_date: Option<String>,
}

/// Ricerca FTS5 con BM25 ranking. La query supporta operatori FTS5 standard
/// (`fattura AND luglio`, `subject:offerta`, ecc.) — passthrough.
pub fn search_fts(
    conn: &Connection,
    account_id: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<SearchHit>> {
    let mut stmt = conn.prepare(
        "SELECT m.id,
                snippet(messages_fts, 3, '<<', '>>', '…', 16) AS snip,
                bm25(messages_fts) AS rank,
                m.subject, m.from_address, m.internal_date
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ?1
            AND m.account_id = ?2
            AND m.is_local_deleted = 0
          ORDER BY rank
          LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![query, account_id, limit], |r| {
            Ok(SearchHit {
                message_id: r.get(0)?,
                snippet: r.get(1)?,
                rank: r.get(2)?,
                subject: r.get(3)?,
                from_address: r.get(4)?,
                internal_date: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderStats {
    pub folder_id: i64,
    pub total: u32,
    pub unread: u32,
}

pub fn folder_stats(
    conn: &Connection,
    account_id: &str,
    folder_id: i64,
) -> Result<FolderStats> {
    let (total, unread): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                SUM(CASE WHEN is_seen = 0 THEN 1 ELSE 0 END)
           FROM messages
          WHERE account_id = ?1 AND primary_folder_id = ?2 AND is_local_deleted = 0",
        params![account_id, folder_id],
        |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    Ok(FolderStats {
        folder_id,
        total: total as u32,
        unread: unread as u32,
    })
}

pub fn ensure_folder(
    conn: &Connection,
    account_id: &str,
    path: &str,
    name: &str,
    folder_type: &str,
) -> Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO folders (account_id, path, name, folder_type)
         VALUES (?1, ?2, ?3, ?4)",
        params![account_id, path, name, folder_type],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM folders WHERE account_id = ?1 AND path = ?2",
        params![account_id, path],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn set_folder_uid_state(
    conn: &Connection,
    folder_id: i64,
    uid_validity: u32,
    last_known_uid: u32,
) -> Result<()> {
    conn.execute(
        "UPDATE folders SET uid_validity = ?1, last_known_uid = ?2, last_sync_at = ?3 WHERE id = ?4",
        params![uid_validity, last_known_uid, Utc::now().to_rfc3339(), folder_id],
    )?;
    Ok(())
}

/// Inline part di un messaggio: usata per riferimenti `cid:` nell'HTML.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InlinePart {
    pub content_id: String,
    pub content_type: String,
    pub base64: String,
    /// Filename dell'allegato se presente — Outlook spesso usa `cid:filename@guid`
    /// dove il Content-ID dichiara solo il guid, e l'HTML referenzia il filename.
    pub filename: Option<String>,
}

/// Estrae gli allegati (non-inline) di un messaggio dal raw EML salvato e
/// applica lo scanner di sicurezza. Ritorna lista vuota se manca il raw_eml.
pub fn list_attachments_with_threat(
    conn: &Connection,
    message_id: i64,
) -> Result<Vec<crate::security::attachments::AttachmentEntry>> {
    use mail_parser::{MessageParser, MimeHeaders, PartType};

    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT raw_eml FROM messages WHERE id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(raw) = raw else { return Ok(Vec::new()) };

    let Some(parsed) = MessageParser::default().parse(&raw) else {
        return Ok(Vec::new());
    };

    let mut out: Vec<crate::security::attachments::AttachmentEntry> = Vec::new();
    for (i, part) in parsed.parts.iter().enumerate() {
        // Skip body parts (text/plain o text/html top-level)
        let ctype_raw = part.content_type();
        let (ctype_str, is_inline_attachment) = match ctype_raw {
            Some(c) => {
                let main = c.ctype();
                let sub = c.subtype().unwrap_or("octet-stream");
                let s = format!("{main}/{sub}");
                let inline = part.is_content_type("text", "plain")
                    || part.is_content_type("text", "html");
                (s, inline)
            }
            None => ("application/octet-stream".to_string(), false),
        };
        // Se è una text part SENZA Content-Disposition: attachment, è body, skip.
        if is_inline_attachment && part.attachment_name().is_none() {
            continue;
        }
        let filename = part
            .attachment_name()
            .map(|s| s.to_string())
            .or_else(|| part.content_id().map(|c| c.to_string()))
            .unwrap_or_else(|| format!("allegato-{i}"));

        let bytes: &[u8] = match &part.body {
            PartType::Binary(b) => b.as_ref(),
            PartType::InlineBinary(b) => b.as_ref(),
            PartType::Text(t) => t.as_bytes(),
            PartType::Html(t) => t.as_bytes(),
            _ => continue,
        };
        let size = bytes.len() as u64;
        let inline_flag = part.content_id().is_some();
        let report = crate::security::attachments::analyze(
            &filename,
            &ctype_str,
            size,
            Some(bytes),
        );
        out.push(crate::security::attachments::AttachmentEntry {
            index: i,
            filename,
            content_type: ctype_str,
            size_bytes: size,
            is_inline: inline_flag,
            threat: report,
        });
    }
    Ok(out)
}

/// Estrae il contenuto byte di un allegato dato il suo `index` nel raw EML.
/// Ritorna `(filename, content_type, bytes)`.
pub fn get_attachment_bytes(
    conn: &Connection,
    message_id: i64,
    part_index: usize,
) -> Result<Option<(String, String, Vec<u8>)>> {
    use mail_parser::{MessageParser, MimeHeaders, PartType};

    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT raw_eml FROM messages WHERE id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(raw) = raw else { return Ok(None) };
    let Some(parsed) = MessageParser::default().parse(&raw) else { return Ok(None) };
    let Some(part) = parsed.parts.get(part_index) else { return Ok(None) };

    let ctype = part
        .content_type()
        .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("octet-stream")))
        .unwrap_or_else(|| "application/octet-stream".into());
    let filename = part
        .attachment_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("allegato-{part_index}"));
    let bytes: Vec<u8> = match &part.body {
        PartType::Binary(b) => b.to_vec(),
        PartType::InlineBinary(b) => b.to_vec(),
        PartType::Text(t) => t.as_bytes().to_vec(),
        PartType::Html(t) => t.as_bytes().to_vec(),
        _ => return Ok(None),
    };
    Ok(Some((filename, ctype, bytes)))
}

/// Estrae le inline parts dal raw RFC822 salvato. Ritorna lista vuota se
/// il messaggio non ha raw_eml (caso legacy) o se non ha parti inline.
pub fn get_inline_parts(conn: &Connection, message_id: i64) -> Result<Vec<InlinePart>> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use mail_parser::{MessageParser, MimeHeaders, PartType};

    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT raw_eml FROM messages WHERE id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(raw) = raw else { return Ok(Vec::new()) };

    let Some(parsed) = MessageParser::default().parse(&raw) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for part in parsed.parts.iter() {
        // Cerca parti con Content-ID (inline images)
        let cid = part.content_id();
        let Some(cid) = cid else { continue };
        let ctype = part
            .content_type()
            .map(|c| {
                format!(
                    "{}/{}",
                    c.ctype(),
                    c.subtype().unwrap_or("octet-stream")
                )
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let bytes = match &part.body {
            PartType::Binary(b) => b.as_ref(),
            PartType::InlineBinary(b) => b.as_ref(),
            _ => continue,
        };
        out.push(InlinePart {
            content_id: cid.trim_matches(|c| c == '<' || c == '>').to_string(),
            content_type: ctype,
            base64: B64.encode(bytes),
            filename: part.attachment_name().map(|s| s.to_string()),
        });
    }
    Ok(out)
}
