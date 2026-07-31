//! Tier G — Sicurezza + manutenzione.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;

use super::helpers::{account_id, i};

/// Scanner sicurezza singolo allegato (ri-utilizza il pipeline esistente).
pub fn security_attachment_threat(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let part_index = i(args, "partIndex").ok_or_else(|| anyhow!("manca 'partIndex'"))? as usize;
    let attachments = db::with_db(|c| db::messages::list_attachments_with_threat(c, message_id))?;
    let entry = attachments
        .into_iter()
        .find(|a| a.index == part_index)
        .ok_or_else(|| anyhow!("Allegato idx={part_index} non trovato per msg={message_id}"))?;
    Ok(json!({
        "messageId": message_id,
        "partIndex": part_index,
        "filename": entry.filename,
        "contentType": entry.content_type,
        "sizeBytes": entry.size_bytes,
        "level": format!("{:?}", entry.threat.level).to_lowercase(),
        "reasons": entry.threat.reasons,
    }))
}

/// Passa in rassegna tutti i messaggi con allegati dell'account e segnala
/// quelli che lo scanner classifica come `Danger`.
pub fn security_scan_all_attachments(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let ids: Vec<i64> = db::with_db(|c| {
        let mut stmt = c.prepare(
            "SELECT id FROM messages
              WHERE account_id = ?1 AND has_attachments = 1 AND is_local_deleted = 0
              ORDER BY internal_date DESC LIMIT 2000",
        )?;
        let v: Vec<i64> = stmt
            .query_map(rusqlite::params![account_id], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(v)
    })?;
    let mut dangerous: Vec<Value> = Vec::new();
    let mut warn_count = 0usize;
    let mut scanned_atts = 0usize;
    for &mid in &ids {
        let atts = db::with_db(|c| db::messages::list_attachments_with_threat(c, mid))?;
        for a in atts {
            scanned_atts += 1;
            let lvl = format!("{:?}", a.threat.level).to_lowercase();
            if lvl == "danger" {
                dangerous.push(json!({
                    "messageId": mid,
                    "partIndex": a.index,
                    "filename": a.filename,
                    "contentType": a.content_type,
                    "sizeBytes": a.size_bytes,
                    "reasons": a.threat.reasons,
                }));
            } else if lvl == "caution" {
                warn_count += 1;
            }
        }
    }
    Ok(json!({
        "scannedMessages": ids.len(),
        "scannedAttachments": scanned_atts,
        "danger": dangerous.len(),
        "caution": warn_count,
        "results": dangerous,
    }))
}

/// Stato sistema Medea.
pub fn medea_system_status(_args: &Value) -> Result<Value> {
    let version = env!("CARGO_PKG_VERSION");
    let counts = db::with_db(|c| -> Result<Value> {
        let q = |sql: &str| -> Result<i64> {
            c.query_row(sql, [], |r| r.get::<_, i64>(0))
                .map_err(anyhow::Error::from)
        };
        Ok(json!({
            "messages":   q("SELECT COUNT(*) FROM messages")?,
            "accounts":   q("SELECT COUNT(*) FROM accounts")?,
            "folders":    q("SELECT COUNT(*) FROM folders")?,
            "organizations": q("SELECT COUNT(*) FROM organizations")?,
            "clients":    q("SELECT COUNT(*) FROM organizations WHERE is_client = 1")?,
            "suppliers":  q("SELECT COUNT(*) FROM organizations WHERE is_supplier = 1")?,
            "articles":   q("SELECT COUNT(*) FROM articles")?,
            "priceLists": q("SELECT COUNT(*) FROM price_lists")?,
            "priceItems": q("SELECT COUNT(*) FROM price_list_items")?,
            "documents":  q("SELECT COUNT(*) FROM customer_documents")?,
            "reminders":  q("SELECT COUNT(*) FROM reminders WHERE status IN ('pending','snoozed')")?,
        }))
    })?;
    let last_sync: Option<String> = db::with_db(|c| {
        use rusqlite::OptionalExtension;
        c.query_row("SELECT MAX(last_sync_at) FROM folders", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .map(|v| v.flatten())
        .map_err(anyhow::Error::from)
    })?;
    Ok(json!({
        "version": version,
        "schemaVersion": crate::db::schema::SCHEMA_VERSION,
        "now": chrono::Local::now().to_rfc3339(),
        "lastFolderSyncAt": last_sync,
        "counts": counts,
    }))
}
