//! Tier C1 + C2 — Email lettura avanzata + azioni IMAP proposals.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;

use super::helpers::{account_id, i, s};

// ── C1: lettura avanzata ──────────────────────────────────────────────────

pub fn messages_search_by_date(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let from = s(args, "from").ok_or_else(|| anyhow!("manca 'from' (YYYY-MM-DD)"))?;
    let to = s(args, "to").ok_or_else(|| anyhow!("manca 'to' (YYYY-MM-DD)"))?;
    let limit = i(args, "limit").unwrap_or(200).clamp(1, 1000) as u32;

    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(
            "SELECT m.id, m.subject, m.from_address, m.from_name, m.internal_date,
                    m.preview, m.is_seen, m.has_attachments, f.path
               FROM messages m
               LEFT JOIN folders f ON f.id = m.primary_folder_id
              WHERE m.account_id = ?1
                AND m.is_local_deleted = 0
                AND date(m.internal_date) BETWEEN date(?2) AND date(?3)
              ORDER BY m.internal_date DESC
              LIMIT ?4",
        )?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![account_id, from, to, limit], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "subject": r.get::<_, Option<String>>(1)?,
                    "from": r.get::<_, Option<String>>(2)?,
                    "fromName": r.get::<_, Option<String>>(3)?,
                    "date": r.get::<_, Option<String>>(4)?,
                    "preview": r.get::<_, Option<String>>(5)?,
                    "seen": r.get::<_, i64>(6)? != 0,
                    "hasAttachments": r.get::<_, i64>(7)? != 0,
                    "folder": r.get::<_, Option<String>>(8)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    Ok(json!({ "from": from, "to": to, "count": rows.len(), "results": rows }))
}

pub fn messages_thread_get(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let rows = db::with_db(|c| {
        let thread_id: Option<String> = c.query_row(
            "SELECT thread_id FROM messages WHERE id = ?1",
            rusqlite::params![message_id],
            |r| r.get(0),
        )?;
        let Some(tid) = thread_id else { return Ok::<Vec<Value>, anyhow::Error>(Vec::new()) };
        let mut stmt = c.prepare(
            "SELECT m.id, m.subject, m.from_address, m.from_name,
                    m.internal_date, m.preview, m.is_seen, f.path
               FROM messages m
               LEFT JOIN folders f ON f.id = m.primary_folder_id
              WHERE m.thread_id = ?1 AND m.is_local_deleted = 0
              ORDER BY m.internal_date ASC",
        )?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![tid], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "subject": r.get::<_, Option<String>>(1)?,
                    "from": r.get::<_, Option<String>>(2)?,
                    "fromName": r.get::<_, Option<String>>(3)?,
                    "date": r.get::<_, Option<String>>(4)?,
                    "preview": r.get::<_, Option<String>>(5)?,
                    "seen": r.get::<_, i64>(6)? != 0,
                    "folder": r.get::<_, Option<String>>(7)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(r)
    })?;
    Ok(json!({ "messageId": message_id, "count": rows.len(), "thread": rows }))
}

pub fn messages_followup_pending(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(
            "WITH sent AS (
               SELECT thread_id, MAX(internal_date) AS last_sent
                 FROM messages m
                 JOIN folders f ON f.id = m.primary_folder_id
                WHERE m.account_id = ?1
                  AND m.is_local_deleted = 0
                  AND LOWER(COALESCE(f.folder_type,'')) = 'sent'
                  AND m.thread_id IS NOT NULL
                GROUP BY thread_id
             ),
             received AS (
               SELECT thread_id, MAX(internal_date) AS last_received
                 FROM messages m
                 JOIN folders f ON f.id = m.primary_folder_id
                WHERE m.account_id = ?1
                  AND m.is_local_deleted = 0
                  AND LOWER(COALESCE(f.folder_type,'')) != 'sent'
                  AND m.thread_id IS NOT NULL
                GROUP BY thread_id
             )
             SELECT s.thread_id, s.last_sent,
                    (SELECT subject FROM messages WHERE thread_id = s.thread_id ORDER BY internal_date DESC LIMIT 1),
                    (SELECT to_json  FROM messages WHERE thread_id = s.thread_id ORDER BY internal_date DESC LIMIT 1)
               FROM sent s
               LEFT JOIN received r ON r.thread_id = s.thread_id
              WHERE r.last_received IS NULL
                 OR r.last_received < s.last_sent
              ORDER BY s.last_sent DESC
              LIMIT 100",
        )?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![account_id], |r| {
                Ok(json!({
                    "threadId": r.get::<_, Option<String>>(0)?,
                    "lastSentAt": r.get::<_, Option<String>>(1)?,
                    "subject": r.get::<_, Option<String>>(2)?,
                    "to": r.get::<_, Option<String>>(3)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    Ok(json!({ "count": rows.len(), "threads": rows }))
}

pub fn messages_unread_summary(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(
            "SELECT LOWER(SUBSTR(from_address, INSTR(from_address,'@') + 1)) AS dom,
                    COUNT(*) AS n
               FROM messages
              WHERE account_id = ?1
                AND is_seen = 0
                AND is_local_deleted = 0
                AND from_address IS NOT NULL
                AND from_address LIKE '%@%'
              GROUP BY dom
              ORDER BY n DESC
              LIMIT 50",
        )?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![account_id], |r| {
                Ok(json!({
                    "domain": r.get::<_, String>(0)?,
                    "unread": r.get::<_, i64>(1)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    let total: i64 = rows.iter().filter_map(|r| r.get("unread").and_then(|v| v.as_i64())).sum();
    Ok(json!({ "totalUnread": total, "byDomain": rows }))
}

/// Parsing semantico mail-ordine: pattern regex deterministico su body.
pub fn messages_parse_order(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let full = db::with_db(|c| db::messages::get_full(c, message_id))?
        .ok_or_else(|| anyhow!("messaggio id={message_id} non trovato"))?;
    let body = full.body_text.clone().unwrap_or_default();
    let articles = db::with_db(|c| db::anag::list_articles(c, 20_000, 0))?;

    let mut hits: Vec<Value> = Vec::new();
    for line in body.lines().take(2000) {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        // Cerca codici articolo conosciuti (case-insensitive contains su token)
        for art in &articles {
            if art.code.len() < 3 { continue; }
            let needle = art.code.to_lowercase();
            let hay = trimmed.to_lowercase();
            if hay.contains(&needle) {
                // Cerca un numero (qty) accanto al codice
                let qty: Option<f64> = trimmed.split(|c: char| !c.is_ascii_digit() && c != '.' && c != ',')
                    .filter_map(|tok| tok.replace(',', ".").parse::<f64>().ok())
                    .find(|&n| n > 0.0 && n < 100_000.0);
                hits.push(json!({
                    "code": art.code,
                    "description": art.description,
                    "guessedQuantity": qty,
                    "lineExcerpt": trimmed.chars().take(160).collect::<String>(),
                }));
                break;
            }
        }
        if hits.len() >= 200 { break; }
    }
    Ok(json!({
        "messageId": message_id,
        "subject":   full.summary.subject,
        "from":      full.summary.from_address,
        "lineHits":  hits.len(),
        "items":     hits,
    }))
}


// ── Azioni locali reali (mai sul server IMAP) ─────────────────────────────

/// Segna un messaggio come letto/non letto. Scrittura REALE sul DB locale;
/// lo stato non viene propagato al server (IMAP è read-only per policy).
pub fn email_mark_seen(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let seen = args.get("seen").and_then(|v| v.as_bool()).unwrap_or(true);
    let subject = subject_of(message_id)?;
    db::with_db(|c| {
        c.execute(
            "UPDATE messages SET is_seen = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![seen as i32, message_id],
        )?;
        Ok::<_, anyhow::Error>(())
    })?;
    Ok(json!({
        "messageId": message_id,
        "seen": seen,
        "text": format!(
            "Email «{subject}» segnata come {} (solo in locale).",
            if seen { "letta" } else { "non letta" }
        ),
    }))
}

/// Aggiunge/rimuove la stella su un messaggio. Scrittura locale reale.
pub fn email_mark_flagged(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let flagged = args.get("flagged").and_then(|v| v.as_bool()).unwrap_or(true);
    let subject = subject_of(message_id)?;
    db::with_db(|c| {
        c.execute(
            "UPDATE messages SET is_flagged = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![flagged as i32, message_id],
        )?;
        Ok::<_, anyhow::Error>(())
    })?;
    Ok(json!({
        "messageId": message_id,
        "flagged": flagged,
        "text": format!(
            "{} la stella su «{subject}».",
            if flagged { "Aggiunta" } else { "Rimossa" }
        ),
    }))
}

fn subject_of(message_id: i64) -> Result<String> {
    let full = db::with_db(|c| db::messages::get_full(c, message_id))?
        .ok_or_else(|| anyhow!("messaggio id={message_id} non trovato"))?;
    Ok(full
        .summary
        .subject
        .unwrap_or_else(|| "(senza oggetto)".to_string()))
}

// ── Lettura in stile Liara: email_recent / email_sent ─────────────────────

fn render_list(rows: &[db::messages::ListedMessage]) -> String {
    rows.iter()
        .map(|m| {
            format!(
                "Da: {}\nOggetto: {}\nData: {}\n{}",
                m.from_address.as_deref().unwrap_or("?"),
                m.subject.as_deref().unwrap_or("(senza oggetto)"),
                m.internal_date.as_deref().unwrap_or("?"),
                m.preview.as_deref().unwrap_or(""),
            )
        })
        .collect::<Vec<_>>()
        .join("\n---\n")
}

/// Email RICEVUTE più recenti già scaricate (mittente, oggetto, data, anteprima).
pub fn email_recent(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let count = i(args, "count").unwrap_or(3).clamp(1, 50) as u32;
    let rows = db::with_db(|c| db::messages::list_recent_global(c, &account_id, count))?;
    Ok(json!({
        "count": rows.len(),
        "results": rows,
        "text": if rows.is_empty() {
            "Nessuna email in archivio locale.".to_string()
        } else {
            render_list(&rows)
        },
    }))
}

/// Email INVIATE più recenti (cartella Inviati sincronizzata).
pub fn email_sent(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let count = i(args, "count").unwrap_or(3).clamp(1, 50) as u32;
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(
            "SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_address,
                    m.to_json, m.preview,
                    m.internal_date, m.is_seen, m.is_flagged, m.has_attachments, m.size_bytes,
                    f.path
               FROM messages m
               JOIN folders f ON f.id = m.primary_folder_id
              WHERE m.account_id = ?1
                AND m.is_local_deleted = 0
                AND ( f.folder_type = 'sent'
                   OR LOWER(f.path) LIKE '%sent%'
                   OR LOWER(f.path) LIKE '%inviat%' )
              ORDER BY m.internal_date DESC
              LIMIT ?2",
        )?;
        let r: Vec<db::messages::ListedMessage> = stmt
            .query_map(rusqlite::params![account_id, count], |r| {
                Ok(db::messages::ListedMessage {
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
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    Ok(json!({
        "count": rows.len(),
        "results": rows,
        "text": if rows.is_empty() {
            "Nessuna email inviata in archivio locale (sincronizza la cartella Inviati).".to_string()
        } else {
            render_list(&rows)
        },
    }))
}

// ── Bozze e invio (proposta → conferma utente) ────────────────────────────

/// Costruisce la proposta di bozza email. `send_requested = true` significa
/// che il modello ha ricevuto un ordine esplicito di INVIO: la UI mostra il
/// bottone d'invio in primo piano, ma l'azione resta dell'utente.
fn draft_proposal(
    to: Vec<String>,
    cc: Vec<String>,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    in_reply_to: Option<String>,
    send_requested: bool,
) -> Value {
    let verb = if send_requested { "pronta da INVIARE" } else { "pronta" };
    json!({
        "kind": "proposal",
        "proposalType": "compose_draft",
        "sendRequested": send_requested,
        "summary": format!(
            "Bozza {verb} per {} — oggetto: «{}»",
            to.join(", "),
            if subject.is_empty() { "(senza oggetto)" } else { subject.as_str() }
        ),
        "draft": {
            "to": to,
            "cc": cc,
            "subject": subject,
            "bodyText": body_text,
            "bodyHtml": body_html,
            "inReplyTo": in_reply_to,
        },
        "text": format!(
            "Bozza pronta ({}). {}",
            if send_requested { "invio richiesto" } else { "non inviata" },
            "Di' all'utente di rivederla e premere il bottone per inviare: l'invio NON è ancora avvenuto."
        ),
    })
}

fn list_arg(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        Some(Value::String(s)) => s
            .split([',', ';'])
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Prepara una NUOVA email nel modulo di scrittura. NON invia.
pub fn email_draft(args: &Value) -> Result<Value> {
    let to = list_arg(args, "to");
    if to.is_empty() {
        return Err(anyhow!("'to' è obbligatorio (destinatario)"));
    }
    let body = s(args, "body").or_else(|| s(args, "bodyText")).unwrap_or_default();
    Ok(draft_proposal(
        to,
        list_arg(args, "cc"),
        s(args, "subject").unwrap_or_default(),
        body,
        s(args, "bodyHtml"),
        s(args, "inReplyTo"),
        false,
    ))
}

/// Risponde a un'email. Senza `messageId` risponde all'ULTIMA ricevuta.
pub fn email_reply(args: &Value) -> Result<Value> {
    let body = s(args, "body").or_else(|| s(args, "bodyText")).unwrap_or_default();
    if body.trim().is_empty() {
        return Err(anyhow!("'body' è obbligatorio (testo della risposta)"));
    }
    let target = match i(args, "messageId") {
        Some(id) => id,
        None => {
            let account = account_id(args)?;
            db::with_db(|c| {
                let id: Option<i64> = c
                    .query_row(
                        "SELECT id FROM messages
                          WHERE account_id = ?1 AND is_local_deleted = 0
                          ORDER BY internal_date DESC LIMIT 1",
                        rusqlite::params![account],
                        |r| r.get(0),
                    )
                    .ok();
                Ok::<_, anyhow::Error>(id)
            })?
            .ok_or_else(|| anyhow!("Nessuna email in archivio a cui rispondere"))?
        }
    };
    let full = db::with_db(|c| db::messages::get_full(c, target))?
        .ok_or_else(|| anyhow!("messaggio id={target} non trovato"))?;
    let to = full
        .summary
        .from_address
        .clone()
        .ok_or_else(|| anyhow!("Il messaggio non ha un mittente a cui rispondere"))?;
    let subject = full
        .summary
        .subject
        .clone()
        .map(|s| if s.to_lowercase().starts_with("re:") { s } else { format!("Re: {s}") })
        .unwrap_or_else(|| "Re:".to_string());
    Ok(draft_proposal(
        vec![to],
        Vec::new(),
        subject,
        body,
        s(args, "bodyHtml"),
        full.summary.message_id.clone(),
        false,
    ))
}

/// INVIA l'email: usalo quando l'utente conferma l'invio. La spedizione
/// effettiva richiede comunque il click dell'utente sulla card (le credenziali
/// SMTP non sono accessibili ai tool).
pub fn email_send(args: &Value) -> Result<Value> {
    let to = list_arg(args, "to");
    if to.is_empty() {
        return Err(anyhow!("'to' è obbligatorio (destinatario)"));
    }
    let body = s(args, "body").or_else(|| s(args, "bodyText")).unwrap_or_default();
    Ok(draft_proposal(
        to,
        list_arg(args, "cc"),
        s(args, "subject").unwrap_or_default(),
        body,
        s(args, "bodyHtml"),
        s(args, "inReplyTo"),
        true,
    ))
}
