//! SMTP commands: test connessione, invio email.

use lettre::message::{header, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::TlsParameters;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpCredentials {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// `true` per implicit TLS (465), `false` per STARTTLS (587/25).
    #[serde(default = "default_implicit_tls")]
    pub implicit_tls: bool,
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

fn default_implicit_tls() -> bool {
    false
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub from_name: Option<String>,
    pub from_address: String,
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    #[serde(default)]
    pub body_html: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
}

#[tauri::command]
pub async fn smtp_test_connection(creds: SmtpCredentials) -> Result<bool, String> {
    let transport = build_transport(&creds).map_err(|e| e.to_string())?;
    transport.test_connection().await.map_err(|e| {
        format!(
            "SMTP {}:{} ha rifiutato la connessione: {e}",
            creds.host, creds.port
        )
    })?;
    Ok(true)
}

/// Costruisce un `Message` lettre dal nostro DTO. Riusato sia per send sia per
/// save-as-draft (l'EML serializzato viene appeso a IMAP Drafts/Sent).
pub fn build_message(msg: &OutgoingMessage) -> anyhow::Result<Message> {
    let from_mb: Mailbox = match &msg.from_name {
        Some(n) => format!("{n} <{}>", msg.from_address).parse()?,
        None => msg.from_address.parse()?,
    };
    let mut builder = Message::builder().from(from_mb).subject(&msg.subject);
    for to in &msg.to {
        builder = builder.to(to.parse()?);
    }
    for cc in &msg.cc {
        builder = builder.cc(cc.parse()?);
    }
    for bcc in &msg.bcc {
        builder = builder.bcc(bcc.parse()?);
    }
    if let Some(irt) = &msg.in_reply_to {
        builder = builder.in_reply_to(irt.clone());
    }
    if !msg.references.is_empty() {
        builder = builder.references(msg.references.join(" "));
    }
    let body_part = match &msg.body_html {
        Some(html) => MultiPart::alternative()
            .singlepart(
                SinglePart::builder()
                    .header(header::ContentType::TEXT_PLAIN)
                    .body(msg.body_text.clone()),
            )
            .singlepart(
                SinglePart::builder()
                    .header(header::ContentType::TEXT_HTML)
                    .body(html.clone()),
            ),
        None => MultiPart::mixed().singlepart(
            SinglePart::builder()
                .header(header::ContentType::TEXT_PLAIN)
                .body(msg.body_text.clone()),
        ),
    };
    Ok(builder.multipart(body_part)?)
}

#[tauri::command]
pub async fn smtp_send(creds: SmtpCredentials, msg: OutgoingMessage) -> Result<String, String> {
    let transport = build_transport(&creds).map_err(|e| e.to_string())?;
    let email = build_message(&msg).map_err(|e| format!("Failed to build message: {e}"))?;
    let response = transport
        .send(email)
        .await
        .map_err(|e| format!("SMTP send failed: {e}"))?;
    Ok(format!("{:?}", response.code()))
}

/// Invia via SMTP **e** appoggia la copia in cartella IMAP `Sent`. Atomica
/// dal punto di vista dell'utente: se il send fallisce, non si tenta neppure
/// l'append. Se l'append fallisce dopo il send, ritorna comunque un errore
/// chiaro (il messaggio è stato inviato, ma non archiviato — l'utente lo
/// trova nelle email del destinatario ma non in Inviati locali).
#[tauri::command]
pub async fn mail_send_and_archive_sent(
    smtp_creds: SmtpCredentials,
    imap_creds: crate::commands::imap_cmd::ImapCredentials,
    sent_folder: String,
    msg: OutgoingMessage,
) -> Result<String, String> {
    let transport = build_transport(&smtp_creds).map_err(|e| e.to_string())?;
    let email = build_message(&msg).map_err(|e| format!("Failed to build message: {e}"))?;
    let eml_bytes = email.formatted();
    let response = transport
        .send(email)
        .await
        .map_err(|e| format!("SMTP send failed: {e}"))?;

    // Append in IMAP Sent come messaggio già letto.
    crate::commands::imap_cmd::imap_append(
        imap_creds,
        sent_folder,
        eml_bytes,
        vec!["\\Seen".into()],
    )
    .await
    .map_err(|e| format!("Send OK ma archive Sent fallito: {e}"))?;

    Ok(format!("{:?}", response.code()))
}

/// Costruisce l'EML serializzato del messaggio (RFC822). NON invia, NON salva.
/// Usato dal frontend per il flusso «invia poi appendi a Sent» con retry su
/// più nomi di cartella senza re-inviare il messaggio.
#[tauri::command]
pub fn mail_build_eml(msg: OutgoingMessage) -> Result<Vec<u8>, String> {
    let email = build_message(&msg).map_err(|e| format!("Failed to build message: {e}"))?;
    Ok(email.formatted())
}

/// Salva il messaggio nella cartella IMAP `Drafts` come bozza non inviata.
#[tauri::command]
pub async fn mail_save_draft(
    imap_creds: crate::commands::imap_cmd::ImapCredentials,
    drafts_folder: String,
    msg: OutgoingMessage,
) -> Result<(), String> {
    let email = build_message(&msg).map_err(|e| format!("Failed to build message: {e}"))?;
    let eml_bytes = email.formatted();
    crate::commands::imap_cmd::imap_append(
        imap_creds,
        drafts_folder,
        eml_bytes,
        vec!["\\Draft".into()],
    )
    .await
    .map_err(|e| format!("Save draft IMAP fallito: {e}"))?;
    Ok(())
}

fn build_transport(creds: &SmtpCredentials) -> anyhow::Result<AsyncSmtpTransport<Tokio1Executor>> {
    if creds.host.trim().is_empty() {
        anyhow::bail!("Host SMTP vuoto. Inserisci l'host nel form (es. smtp.gmail.com).");
    }
    if creds.username.trim().is_empty() {
        anyhow::bail!("Username SMTP vuoto.");
    }
    tracing::info!(
        "SMTP target {}:{} as {} (implicit_tls={})",
        creds.host,
        creds.port,
        creds.username,
        creds.implicit_tls
    );
    let tls_params = TlsParameters::builder(creds.host.clone())
        .dangerous_accept_invalid_certs(creds.accept_invalid_certs)
        .build()?;

    let builder = if creds.implicit_tls {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&creds.host)
            .port(creds.port)
            .tls(lettre::transport::smtp::client::Tls::Wrapper(tls_params))
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&creds.host)
            .port(creds.port)
            .tls(lettre::transport::smtp::client::Tls::Required(tls_params))
    };

    let with_auth = builder.credentials(Credentials::new(
        creds.username.clone(),
        creds.password.clone(),
    ));

    Ok(with_auth.build())
}
