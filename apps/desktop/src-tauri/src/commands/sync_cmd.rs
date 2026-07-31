//! Sync IMAP → DB locale, con progress events.
//!
//! - `mail_sync_folder` scarica TUTTI i messaggi della folder non ancora in DB.
//! - Batch di 50 messaggi per FETCH per non saturare la connessione.
//! - Dedup automatico per (account_id, message_id) o (account_id, folder_id, uid).
//! - Emit eventi Tauri `mail:sync:progress` / `mail:sync:done` / `mail:sync:error`.
//! - IMAP **read-only** (vedi imap_cmd.rs).

use async_imap::types::Fetch;
use chrono::Utc;
use mail_parser::{HeaderValue, MessageParser};
use serde::Serialize;
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

use crate::commands::imap_cmd::ImapCredentials;
use crate::db;

type ImapStream = async_native_tls::TlsStream<Compat<TcpStream>>;
type ImapSession = async_imap::Session<ImapStream>;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub account_id: String,
    pub folder_path: String,
    pub fetched: u32,
    pub total: u32,
    pub stored: u32,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub fetched: u32,
    /// Messaggi NUOVI inseriti in DB (non conta gli aggiornamenti di righe esistenti).
    pub stored: u32,
    /// Messaggi già in DB aggiornati (flags/body) durante questo sync.
    pub updated: u32,
    pub already_in_db: u32,
    pub elapsed_ms: u128,
}

#[tauri::command]
pub async fn mail_sync_folder(
    app: AppHandle,
    account_id: String,
    creds: ImapCredentials,
    folder_path: String,
    folder_type: String,
    max_messages: Option<u32>,
) -> Result<SyncResult, String> {
    let start = std::time::Instant::now();
    let max = max_messages.unwrap_or(u32::MAX);

    // Assicura folder in DB
    let folder_id = db::with_db(|c| {
        db::messages::ensure_folder(c, &account_id, &folder_path, &folder_path, &folder_type)
    })
    .map_err(|e| e.to_string())?;

    let known_uids: std::collections::HashSet<u32> = db::with_db(|c| {
        db::messages::known_uids(c, &account_id, folder_id)
            .map(|v| v.into_iter().collect())
    })
    .map_err(|e| e.to_string())?;

    let mut session = open_session(&creds).await.map_err(|e| e.to_string())?;

    let mailbox = session
        .select(&folder_path)
        .await
        .map_err(|e| format!("SELECT {folder_path} failed: {e}"))?;

    let total_msgs = mailbox.exists;
    let uid_validity = mailbox.uid_validity.unwrap_or(0);

    // Aggiorna uid_validity nella folder
    let _ = db::with_db(|c| {
        db::messages::set_folder_uid_state(c, folder_id, uid_validity as u32, 0)
    });

    if total_msgs == 0 {
        let _ = session.logout().await;
        return Ok(SyncResult {
            fetched: 0,
            stored: 0,
            updated: 0,
            already_in_db: 0,
            elapsed_ms: start.elapsed().as_millis(),
        });
    }

    let limit = max.min(total_msgs);
    let start_seq = total_msgs.saturating_sub(limit).saturating_add(1).max(1);
    let range = format!("{start_seq}:{total_msgs}");

    let _ = app.emit(
        "mail:sync:progress",
        SyncProgress {
            account_id: account_id.clone(),
            folder_path: folder_path.clone(),
            fetched: 0,
            total: limit,
            stored: 0,
            message: format!("Inizio scan {range} ({limit} messaggi)"),
        },
    );

    // STEP 1: Fetch UID+FLAGS+INTERNALDATE+RFC822.SIZE+ENVELOPE — leggero, per dedup.
    use futures::TryStreamExt;
    let env_stream = session
        .fetch(
            &range,
            "(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)",
        )
        .await
        .map_err(|e| format!("FETCH envelope failed: {e}"))?;

    let envelopes: Vec<_> = env_stream
        .try_collect()
        .await
        .map_err(|e| format!("FETCH envelope collect failed: {e}"))?;

    // STEP 2: Filtra UID che NON sono in DB
    let mut to_fetch: Vec<u32> = Vec::new();
    let mut already = 0u32;
    for f in &envelopes {
        if let Some(uid) = f.uid {
            if known_uids.contains(&uid) {
                already += 1;
            } else {
                to_fetch.push(uid);
            }
        }
    }
    to_fetch.sort_unstable();

    if to_fetch.is_empty() {
        let _ = session.logout().await;
        let _ = app.emit(
            "mail:sync:done",
            json!({
                "accountId": account_id,
                "folderPath": folder_path,
                "fetched": 0,
                "stored": 0,
                "alreadyInDb": already,
            }),
        );
        return Ok(SyncResult {
            fetched: 0,
            stored: 0,
            updated: 0,
            already_in_db: already,
            elapsed_ms: start.elapsed().as_millis(),
        });
    }

    let total_to_fetch = to_fetch.len() as u32;

    // STEP 3: Scarica corpo in batch di 50
    let mut fetched_count = 0u32;
    let mut stored_count = 0u32;
    let mut updated_count = 0u32;
    let batch_size = 50;

    for chunk in to_fetch.chunks(batch_size) {
        let uid_range = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let body_stream = session
            .uid_fetch(
                &uid_range,
                "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])",
            )
            .await
            .map_err(|e| format!("UID FETCH body failed: {e}"))?;

        let bodies: Vec<_> = body_stream
            .try_collect()
            .await
            .map_err(|e| format!("FETCH body collect: {e}"))?;

        for f in &bodies {
            fetched_count += 1;
            match persist_message(&account_id, folder_id, f, uid_validity) {
                Ok(true) => stored_count += 1,
                Ok(false) => updated_count += 1,
                Err(e) => {
                    tracing::warn!("Skipping UID {:?}: {e}", f.uid);
                }
            }
        }

        let _ = app.emit(
            "mail:sync:progress",
            SyncProgress {
                account_id: account_id.clone(),
                folder_path: folder_path.clone(),
                fetched: fetched_count,
                total: total_to_fetch,
                stored: stored_count,
                message: format!("Scaricati {fetched_count}/{total_to_fetch}"),
            },
        );
    }

    let _ = session.logout().await;

    let elapsed_ms = start.elapsed().as_millis();
    let _ = app.emit(
        "mail:sync:done",
        json!({
            "accountId": account_id,
            "folderPath": folder_path,
            "fetched": fetched_count,
            "stored": stored_count,
            "updated": updated_count,
            "alreadyInDb": already,
            "elapsedMs": elapsed_ms,
        }),
    );

    Ok(SyncResult {
        fetched: fetched_count,
        stored: stored_count,
        updated: updated_count,
        already_in_db: already,
        elapsed_ms,
    })
}

/// Persiste un messaggio. Ritorna `true` se è stato INSERITO (nuovo),
/// `false` se era già in DB ed è stato solo aggiornato.
fn persist_message(
    account_id: &str,
    folder_id: i64,
    f: &Fetch,
    uid_validity: u32,
) -> anyhow::Result<bool> {
    let uid = f.uid.ok_or_else(|| anyhow::anyhow!("no UID"))?;
    let raw = f.body().ok_or_else(|| anyhow::anyhow!("empty body"))?;
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| anyhow::anyhow!("parse failed"))?;

    let internal_date = f.internal_date().map(|d| d.with_timezone(&Utc));
    let flags: Vec<_> = f.flags().collect();
    let is_seen = flags
        .iter()
        .any(|fl| matches!(fl, async_imap::types::Flag::Seen));
    let is_flagged = flags
        .iter()
        .any(|fl| matches!(fl, async_imap::types::Flag::Flagged));
    let size = f.size.unwrap_or_else(|| raw.len() as u32);

    // mail-parser è più affidabile dell'IMAP envelope per gli header.
    // Usiamolo come fonte primaria, l'envelope IMAP come fallback.
    let subject: Option<String> = parsed
        .subject()
        .map(|s| s.to_string())
        .or_else(|| {
            f.envelope()
                .and_then(|e| e.subject.as_ref())
                .and_then(|s| std::str::from_utf8(s).ok())
                .map(decode_mime_header)
        });

    let (from_name, from_address): (Option<String>, Option<String>) = parsed
        .from()
        .and_then(|a| a.first())
        .map(|first| {
            let name = first.name.as_ref().map(|s| s.to_string());
            let addr = first.address.as_ref().map(|s| s.to_string());
            (name, addr)
        })
        .unwrap_or((None, None));

    let to: Vec<String> = parsed
        .to()
        .map(|addr| {
            addr.iter()
                .filter_map(|a| a.address.as_ref().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let cc = addresses_from_opt(parsed.cc());
    let bcc = addresses_from_opt(parsed.bcc());

    let message_id = parsed
        .message_id()
        .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string())
        .or_else(|| {
            f.envelope()
                .and_then(|e| e.message_id.as_ref())
                .and_then(|m| std::str::from_utf8(m).ok())
                .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string())
        });

    let in_reply_to = first_text_id(parsed.in_reply_to());
    let references_vec = all_text_ids(parsed.references());
    let references_json = serde_json::to_string(&references_vec).unwrap_or("[]".into());
    let to_json = serde_json::to_string(&to).unwrap_or("[]".into());
    let cc_json = serde_json::to_string(&cc).unwrap_or("[]".into());
    let bcc_json = serde_json::to_string(&bcc).unwrap_or("[]".into());

    let thread_id = thread_hash(
        references_vec.first().map(|s| s.as_str()),
        in_reply_to.as_deref(),
        message_id.as_deref(),
        from_address.as_deref(),
        internal_date.map(|d| d.timestamp()),
        subject.as_deref(),
    );

    let body_text = parsed.body_text(0).map(|s| s.to_string());
    let body_html = parsed.body_html(0).map(|s| s.to_string());
    let preview = body_text
        .as_ref()
        .map(|s| s.chars().take(160).collect::<String>());
    let has_attachments = parsed.attachments().count() > 0;

    let ins = db::messages::InsertMessage {
        account_id,
        folder_id,
        uid,
        uid_validity: Some(uid_validity),
        message_id: message_id.as_deref(),
        in_reply_to: in_reply_to.as_deref(),
        references_json: &references_json,
        thread_id: Some(&thread_id),
        subject: subject.as_deref(),
        from_name: from_name.as_deref(),
        from_address: from_address.as_deref(),
        to_json: &to_json,
        cc_json: &cc_json,
        bcc_json: &bcc_json,
        internal_date,
        size_bytes: size,
        has_attachments,
        is_seen,
        is_flagged,
        body_text: body_text.as_deref(),
        body_html: body_html.as_deref(),
        preview: preview.as_deref(),
        raw_eml: Some(raw),
    };

    let now = Utc::now().to_rfc3339();

    let inserted = db::with_db(|c| {
        let (_mid, inserted) = db::messages::upsert(c, &ins)?;
        // Auto-popola contatto se mittente noto
        if let Some(addr) = from_address.as_deref() {
            let _ = db::contacts::touch(c, addr, from_name.as_deref(), &now);
        }
        // Auto-popola contatti dei destinatari
        for to_addr in &to {
            let _ = db::contacts::touch(c, to_addr, None, &now);
        }
        Ok(inserted)
    })?;
    Ok(inserted)
}

// ── Helpers IMAP/parsing ────────────────────────────────────────────────────

async fn open_session(creds: &ImapCredentials) -> anyhow::Result<ImapSession> {
    if creds.host.trim().is_empty() {
        anyhow::bail!("Host IMAP vuoto.");
    }
    if !creds.secure {
        anyhow::bail!(
            "STARTTLS (secure=false, tipicamente porta 143) non è supportato: \
             Medea usa solo TLS implicito. Configura la porta 993."
        );
    }
    let addr = format!("{}:{}", creds.host, creds.port);
    tracing::info!("Sync IMAP connecting to {addr} as {}", creds.username);

    let tcp = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("TCP timeout collegandomi a {addr}"))?
        .map_err(|e| anyhow::anyhow!("TCP connect a {addr} fallito: {e}"))?;
    let tcp_compat = tcp.compat();

    let tls = async_native_tls::TlsConnector::new()
        .danger_accept_invalid_certs(creds.accept_invalid_certs);

    // Solo TLS implicito (993): secure=false viene rifiutato sopra con
    // errore esplicito (async-imap 0.10 non espone più `.secure()`).
    let tls_stream = tls
        .connect(&creds.host, tcp_compat)
        .await
        .map_err(|e| anyhow::anyhow!("TLS handshake con {}: {e}", creds.host))?;
    let client = async_imap::Client::new(tls_stream);
    let session = client
        .login(&creds.username, &creds.password)
        .await
        .map_err(|(e, _)| anyhow::anyhow!("LOGIN IMAP fallito: {e}"))?;

    Ok(session)
}

fn decode_mime_header(raw: &str) -> String {
    let fake = format!("Subject: {raw}\r\n\r\n");
    MessageParser::default()
        .parse(fake.as_bytes())
        .and_then(|m| m.subject().map(|s| s.to_string()))
        .unwrap_or_else(|| raw.to_string())
}

fn addresses_from_opt(opt: Option<&mail_parser::Address<'_>>) -> Vec<String> {
    opt.map(|addr| {
        addr.iter()
            .filter_map(|a| a.address.as_ref().map(|s| s.to_string()))
            .collect()
    })
    .unwrap_or_default()
}

fn first_text_id(hv: &HeaderValue<'_>) -> Option<String> {
    match hv {
        HeaderValue::Text(s) => Some(s.trim_matches(|c| c == '<' || c == '>').to_string()),
        HeaderValue::TextList(list) => list
            .first()
            .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string()),
        _ => None,
    }
}

fn all_text_ids(hv: &HeaderValue<'_>) -> Vec<String> {
    match hv {
        HeaderValue::Text(s) => vec![s.trim_matches(|c| c == '<' || c == '>').to_string()],
        HeaderValue::TextList(list) => list
            .iter()
            .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string())
            .collect(),
        _ => Vec::new(),
    }
}

/// Thread hash deterministico: porta logica da `email-imap.mjs`.
fn thread_hash(
    first_ref: Option<&str>,
    in_reply: Option<&str>,
    msg_id: Option<&str>,
    from: Option<&str>,
    date_ts: Option<i64>,
    subject: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    let seed = first_ref
        .or(in_reply)
        .map(|s| s.to_string())
        .or_else(|| msg_id.map(|s| s.to_string()))
        .unwrap_or_else(|| {
            format!(
                "{}|{}|{}",
                from.unwrap_or(""),
                date_ts.unwrap_or(0),
                subject.unwrap_or("")
            )
        });
    let mut h = Sha256::new();
    h.update(seed.as_bytes());
    format!("{:x}", h.finalize())[..16].to_string()
}
