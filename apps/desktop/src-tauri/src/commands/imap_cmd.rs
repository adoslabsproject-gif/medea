//! IMAP commands: test connessione, lista folder, lista messaggi, fetch singolo.
//!
//! ┌──────────────────────────────────────────────────────────────────────────┐
//! │  ⛔  IMAP STRICTLY READ-ONLY — REGOLA NON DEROGABILE  ⛔                  │
//! ├──────────────────────────────────────────────────────────────────────────┤
//! │  Medea NON cancella mai email dal server IMAP. MAI.                      │
//! │                                                                          │
//! │  VIETATO usare qui:                                                      │
//! │    - STORE con \Deleted flag                                             │
//! │    - EXPUNGE                                                             │
//! │    - UID EXPUNGE                                                         │
//! │    - COPY verso cartella Trash sul server                                │
//! │    - MOVE                                                                │
//! │                                                                          │
//! │  Quando l'utente "cancella" un'email nell'app Medea, l'azione vive       │
//! │  SOLO nel DB locale (`mail-db`). Il messaggio sul server resta intatto.  │
//! │  Vedi `docs/architecture/adr/0004-imap-read-only.md`.                    │
//! │                                                                          │
//! │  Comandi consentiti: LOGIN, LOGOUT, CAPABILITY, LIST, LSUB, SELECT,      │
//! │  EXAMINE, FETCH, UID FETCH, SEARCH, UID SEARCH, IDLE, NOOP.              │
//! └──────────────────────────────────────────────────────────────────────────┘

use async_imap::types::Fetch;
use chrono::{DateTime, Utc};
use mail_parser::{HeaderValue, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

type ImapStream = async_native_tls::TlsStream<Compat<TcpStream>>;
type ImapSession = async_imap::Session<ImapStream>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapCredentials {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    #[serde(default = "default_secure")]
    pub secure: bool,
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

fn default_secure() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapFolderInfo {
    pub name: String,
    pub delimiter: Option<String>,
    pub attributes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub to: Vec<String>,
    pub date: Option<DateTime<Utc>>,
    pub preview: Option<String>,
    pub is_seen: bool,
    pub is_flagged: bool,
    pub has_attachments: bool,
    pub size: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageFull {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<AttachmentInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub filename: Option<String>,
    pub content_type: String,
    pub size: u32,
}

#[tauri::command]
pub async fn imap_test_connection(creds: ImapCredentials) -> Result<bool, String> {
    let mut session = open_session(&creds).await.map_err(|e| e.to_string())?;
    let _caps = session
        .capabilities()
        .await
        .map_err(|e| format!("CAPABILITY failed: {e}"))?;
    session
        .logout()
        .await
        .map_err(|e| format!("LOGOUT failed: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn imap_list_folders(creds: ImapCredentials) -> Result<Vec<ImapFolderInfo>, String> {
    let mut session = open_session(&creds).await.map_err(|e| e.to_string())?;

    use futures::TryStreamExt;
    let stream = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| format!("LIST failed: {e}"))?;

    let names: Vec<_> = stream
        .try_collect()
        .await
        .map_err(|e| format!("LIST collect failed: {e}"))?;

    let _ = session.logout().await;

    Ok(names
        .into_iter()
        .map(|n| ImapFolderInfo {
            name: n.name().to_string(),
            delimiter: n.delimiter().map(|s| s.to_string()),
            attributes: n.attributes().iter().map(|a| format!("{a:?}")).collect(),
        })
        .collect())
}

#[tauri::command]
pub async fn imap_list_messages(
    creds: ImapCredentials,
    folder: String,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    let mut session = open_session(&creds).await.map_err(|e| e.to_string())?;

    let mailbox = session
        .select(&folder)
        .await
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let exists = mailbox.exists;
    if exists == 0 {
        let _ = session.logout().await;
        return Ok(Vec::new());
    }

    let start = exists.saturating_sub(limit).saturating_add(1).max(1);
    let range = format!("{start}:{exists}");

    use futures::TryStreamExt;
    let fetch_stream = session
        .fetch(
            &range,
            "(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODY.PEEK[HEADER])",
        )
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?;

    let fetches: Vec<_> = fetch_stream
        .try_collect()
        .await
        .map_err(|e| format!("FETCH collect failed: {e}"))?;

    let mut summaries = Vec::with_capacity(fetches.len());
    for f in &fetches {
        if let Some(s) = build_summary(f) {
            summaries.push(s);
        }
    }
    summaries.sort_by(|a, b| b.date.cmp(&a.date).then(b.uid.cmp(&a.uid)));

    let _ = session.logout().await;
    Ok(summaries)
}

#[tauri::command]
pub async fn imap_fetch_message(
    creds: ImapCredentials,
    folder: String,
    uid: u32,
) -> Result<MessageFull, String> {
    let mut session = open_session(&creds).await.map_err(|e| e.to_string())?;
    session
        .select(&folder)
        .await
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    use futures::TryStreamExt;
    let fetch_stream = session
        .uid_fetch(
            &uid.to_string(),
            "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])",
        )
        .await
        .map_err(|e| format!("UID FETCH failed: {e}"))?;

    let fetches: Vec<_> = fetch_stream
        .try_collect()
        .await
        .map_err(|e| format!("UID FETCH collect failed: {e}"))?;

    let fetch = fetches
        .into_iter()
        .next()
        .ok_or_else(|| format!("Message UID={uid} not found"))?;

    let raw = fetch.body().ok_or("Empty body")?;
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or("Failed to parse RFC822")?;

    let summary = build_summary(&fetch).unwrap_or(MessageSummary {
        uid,
        message_id: None,
        subject: parsed.subject().map(|s| s.to_string()),
        from_name: None,
        from_address: None,
        to: Vec::new(),
        date: None,
        preview: None,
        is_seen: fetch
            .flags()
            .any(|f| matches!(f, async_imap::types::Flag::Seen)),
        is_flagged: false,
        has_attachments: false,
        size: raw.len() as u32,
    });

    let body_text = parsed.body_text(0).map(|s| s.to_string());
    let body_html = parsed.body_html(0).map(|s| s.to_string());

    let cc = addresses_from_opt(parsed.cc());
    let bcc = addresses_from_opt(parsed.bcc());
    let in_reply_to = first_text_id(parsed.in_reply_to());
    let references = all_text_ids(parsed.references());

    // mail-parser 0.10: `attachment_name` esiste su MessagePart, `content_type`
    // ritorna `Option<&ContentType>`. Filename in fallback su Content-Disposition.
    let attachments: Vec<AttachmentInfo> = parsed
        .attachments()
        .map(|part| {
            let filename = part.attachment_name().map(|s| s.to_string());
            let content_type = part
                .content_type()
                .map(|c| {
                    format!(
                        "{}/{}",
                        c.ctype(),
                        c.subtype().unwrap_or("octet-stream")
                    )
                })
                .unwrap_or_else(|| "application/octet-stream".to_string());
            AttachmentInfo {
                filename,
                content_type,
                size: part.contents().len() as u32,
            }
        })
        .collect();

    let _ = session.logout().await;
    Ok(MessageFull {
        summary,
        body_text,
        body_html,
        cc,
        bcc,
        in_reply_to,
        references,
        attachments,
    })
}

/// APPEND di un messaggio in formato RFC822 in una cartella IMAP.
/// Usato per:
///  - **Drafts**: salvare bozze AI/utente, con flag `\Draft`
///  - **Sent**: archiviare email appena inviate via SMTP, con flag `\Seen`
///
/// Mantiene la regola «mai cancellare»: questo comando AGGIUNGE, non rimuove.
#[tauri::command]
pub async fn imap_append(
    creds: ImapCredentials,
    folder: String,
    eml_bytes: Vec<u8>,
    flags: Vec<String>,
) -> Result<(), String> {
    let mut session = open_session(&creds).await.map_err(|e| e.to_string())?;

    // Comando IMAP APPEND <folder> <flags?> <date?> <body>.
    // RFC 3501: la flag list deve essere fra parentesi tonde: "(\Seen)".
    let flags_string = if flags.is_empty() {
        String::new()
    } else {
        format!("({})", flags.join(" "))
    };
    let flags_opt: Option<&str> = if flags_string.is_empty() {
        None
    } else {
        Some(flags_string.as_str())
    };
    tracing::info!(
        "IMAP APPEND folder={} flags={:?} size={}",
        folder, flags_opt, eml_bytes.len()
    );
    let result: Result<(), String> = async {
        session
            .append(&folder, flags_opt, None, &eml_bytes)
            .await
            .map_err(|e| format!("APPEND a '{folder}' fallito: {e}"))?;
        tracing::info!("IMAP APPEND ok → {folder}");
        Ok(())
    }.await;

    // Cerchiamo di chiudere comunque la sessione, ma non mascheriamo errori.
    let _ = session.logout().await;
    result
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async fn open_session(creds: &ImapCredentials) -> anyhow::Result<ImapSession> {
    if creds.host.trim().is_empty() {
        anyhow::bail!("Host IMAP vuoto. Inserisci l'host nel form (es. imap.gmail.com).");
    }
    if creds.username.trim().is_empty() {
        anyhow::bail!("Username vuoto. Inserisci email o username del provider.");
    }
    if !creds.secure {
        anyhow::bail!(
            "STARTTLS (secure=false, tipicamente porta 143) non è supportato: \
             Medea usa solo TLS implicito. Configura la porta 993."
        );
    }
    let addr = format!("{}:{}", creds.host, creds.port);
    tracing::info!("IMAP connecting to {addr} as {}", creds.username);

    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("TCP timeout collegandomi a {addr} (host irraggiungibile o porta filtrata)"))?
        .map_err(|e| anyhow::anyhow!("TCP connect a {addr} fallito: {e}"))?;
    let tcp_compat = tcp.compat();

    let tls = async_native_tls::TlsConnector::new()
        .danger_accept_invalid_certs(creds.accept_invalid_certs);

    let tls_stream = tls
        .connect(&creds.host, tcp_compat)
        .await
        .map_err(|e| anyhow::anyhow!("TLS handshake fallito con {}: {e}", creds.host))?;

    let client = async_imap::Client::new(tls_stream);
    let session = client
        .login(&creds.username, &creds.password)
        .await
        .map_err(|(e, _)| anyhow::anyhow!("LOGIN IMAP fallito ({}@{}): {e}", creds.username, creds.host))?;
    Ok(session)
}

fn build_summary(f: &Fetch) -> Option<MessageSummary> {
    let uid = f.uid?;
    let envelope = f.envelope();
    let internal_date = f.internal_date();

    let subject = envelope
        .and_then(|e| e.subject.as_ref())
        .and_then(|s| std::str::from_utf8(s).ok())
        .map(decode_mime_header);

    let (from_name, from_address) = envelope
        .and_then(|e| e.from.as_ref())
        .and_then(|f| f.first())
        .map(|a| {
            let name = a
                .name
                .as_ref()
                .and_then(|n| std::str::from_utf8(n).ok())
                .map(decode_mime_header);
            let mailbox = a
                .mailbox
                .as_ref()
                .and_then(|m| std::str::from_utf8(m).ok());
            let host = a.host.as_ref().and_then(|h| std::str::from_utf8(h).ok());
            let addr = match (mailbox, host) {
                (Some(m), Some(h)) => Some(format!("{m}@{h}")),
                _ => None,
            };
            (name, addr)
        })
        .unwrap_or((None, None));

    let to: Vec<String> = envelope
        .and_then(|e| e.to.as_ref())
        .map(|addrs| {
            addrs
                .iter()
                .filter_map(|a| {
                    let m = a.mailbox.as_ref().and_then(|m| std::str::from_utf8(m).ok())?;
                    let h = a.host.as_ref().and_then(|h| std::str::from_utf8(h).ok())?;
                    Some(format!("{m}@{h}"))
                })
                .collect()
        })
        .unwrap_or_default();

    let message_id = envelope
        .and_then(|e| e.message_id.as_ref())
        .and_then(|m| std::str::from_utf8(m).ok())
        .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string());

    let flags: Vec<_> = f.flags().collect();
    let is_seen = flags
        .iter()
        .any(|fl| matches!(fl, async_imap::types::Flag::Seen));
    let is_flagged = flags
        .iter()
        .any(|fl| matches!(fl, async_imap::types::Flag::Flagged));
    let size = f.size.unwrap_or(0);

    let parsed = f.body().and_then(|raw| MessageParser::default().parse(raw));
    let preview = parsed
        .as_ref()
        .and_then(|m| m.body_text(0).map(|s| s.to_string()))
        .map(|s| s.chars().take(160).collect::<String>());
    let has_attachments = parsed
        .as_ref()
        .map(|m| m.attachments().count() > 0)
        .unwrap_or(false);

    Some(MessageSummary {
        uid,
        message_id,
        subject,
        from_name,
        from_address,
        to,
        date: internal_date.map(|d| d.with_timezone(&Utc)),
        preview,
        is_seen,
        is_flagged,
        has_attachments,
        size,
    })
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
