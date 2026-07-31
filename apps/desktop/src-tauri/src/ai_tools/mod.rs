//! Tool registry deterministico Medea.
//!
//! Filosofia:
//! - Ogni tool è una funzione **pura** che riceve JSON e ritorna JSON.
//! - Niente effetti collaterali nascosti: ogni tool è esplicitamente read-only
//!   o esplicitamente write. La UI traccia la chiamata e mostra il risultato.
//! - Lo schema dei parametri è dichiarato in `Tool::params` (JSON Schema-like
//!   semplificato) ed esposto nel system prompt del modello.
//!
//! Il loop di tool-calling vive lato JS (`AiPanel`): parsa i marker emessi dal
//! modello, chiama `ai_tool_call` (esecuzione vera lato Rust), reimmette il
//! risultato come messaggio di sistema, e cicla finché il modello smette di
//! chiamare tool o si raggiunge il limite di iterazioni.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};

pub mod attachments;
pub mod helpers;
pub mod tools;
pub mod tools_admin;
pub mod tools_analytics;
pub mod tools_calendar;
pub mod tools_email;
pub mod tools_notes;
pub mod tools_output;
pub mod tools_write;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    /// JSON Schema-like (object con `type`, `properties`, `required`).
    pub params: Value,
    /// `read` = no side effects, `write` = modifies DB.
    pub kind: String,
    /// Breve esempio JSON di input.
    pub example: Value,
}


/// Costruttore compatto di un descrittore.
fn t(name: &str, kind: &str, description: &str, params: Value, example: Value) -> ToolDescriptor {
    ToolDescriptor {
        name: name.into(),
        description: description.into(),
        params,
        kind: kind.into(),
        example,
    }
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required })
}

pub fn registry() -> Vec<ToolDescriptor> {
    vec![
        // ── core ────────────────────────────────────────────────────────────
        t("datetime", "read",
          "Restituisce la data e l'ora correnti del dispositivo.",
          obj(json!({}), &[]), json!({})),
        t("system_status", "read",
          "Stato del sistema Medea: versione, schema DB, conteggi record, ultimo sync IMAP.",
          obj(json!({}), &[]), json!({})),

        // ── email: lettura ──────────────────────────────────────────────────
        t("email_recent", "read",
          "Legge le email più recenti già scaricate (mittente, oggetto, data, anteprima).",
          obj(json!({ "count": {"type":"integer"} }), &[]),
          json!({ "count": 5 })),
        t("email_sent", "read",
          "Legge le email INVIATE più recenti (destinatario, oggetto, testo).",
          obj(json!({ "count": {"type":"integer"} }), &[]),
          json!({ "count": 5 })),
        t("email_search", "read",
          "Cerca tra le email scaricate per mittente, oggetto o contenuto (full-text).",
          obj(json!({ "query": {"type":"string"}, "count": {"type":"integer"} }), &["query"]),
          json!({ "query": "preventivo" })),
        t("email_search_domain", "read",
          "Email scambiate con un dominio esatto (ricevute e inviate). Usalo quando conosci già il dominio.",
          obj(json!({ "domain": {"type":"string"}, "count": {"type":"integer"} }), &["domain"]),
          json!({ "domain": "acme.it" })),
        t("email_search_date", "read",
          "Email in un intervallo di date (AAAA-MM-GG).",
          obj(json!({ "from": {"type":"string"}, "to": {"type":"string"}, "count": {"type":"integer"} }), &["from","to"]),
          json!({ "from": "2026-01-01", "to": "2026-01-31" })),
        t("email_thread", "read",
          "Tutti i messaggi del thread di un'email, in ordine cronologico.",
          obj(json!({ "messageId": {"type":"integer"} }), &["messageId"]),
          json!({ "messageId": 1234 })),
        t("email_followup_pending", "read",
          "Thread in cui hai scritto tu per ultimo e non è arrivata risposta.",
          obj(json!({}), &[]), json!({})),
        t("email_unread_summary", "read",
          "Riepilogo delle email non lette, aggregate per dominio del mittente.",
          obj(json!({}), &[]), json!({})),
        t("email_parse_order", "read",
          "Estrae possibili righe d'ordine da un'email: codici articolo presenti in archivio e quantità adiacenti.",
          obj(json!({ "messageId": {"type":"integer"} }), &["messageId"]),
          json!({ "messageId": 1234 })),

        // ── email: azioni locali ────────────────────────────────────────────
        t("email_mark_seen", "write",
          "Segna un'email come letta o non letta (solo in locale, mai sul server).",
          obj(json!({ "messageId": {"type":"integer"}, "seen": {"type":"boolean"} }), &["messageId"]),
          json!({ "messageId": 1234, "seen": true })),
        t("email_mark_flagged", "write",
          "Aggiunge o toglie la stella a un'email (solo in locale).",
          obj(json!({ "messageId": {"type":"integer"}, "flagged": {"type":"boolean"} }), &["messageId"]),
          json!({ "messageId": 1234, "flagged": true })),

        // ── email: scrittura (bozza → conferma utente) ──────────────────────
        t("email_draft", "proposal",
          "Prepara una NUOVA email (destinatario, oggetto, testo) nel modulo di scrittura. NON la invia: l'utente la rivede e preme Invia.",
          obj(json!({
              "to": {"type":"string"}, "subject": {"type":"string"}, "body": {"type":"string"},
              "cc": {"type":"string"}, "bodyHtml": {"type":"string"}
          }), &["to","body"]),
          json!({ "to": "mario@example.com", "subject": "Richiesta offerta", "body": "Buongiorno Mario,…" })),
        t("email_reply", "proposal",
          "Risponde a un'email: passa SOLO il testo della risposta. Senza messageId risponde all'ultima ricevuta. NON invia.",
          obj(json!({ "body": {"type":"string"}, "messageId": {"type":"integer"} }), &["body"]),
          json!({ "body": "Grazie, confermo la disponibilità." })),
        t("email_send", "proposal",
          "Prepara l'email con richiesta di INVIO. Usalo quando l'utente conferma di voler inviare. L'invio effettivo richiede il suo click sulla card.",
          obj(json!({
              "to": {"type":"string"}, "subject": {"type":"string"}, "body": {"type":"string"},
              "cc": {"type":"string"}
          }), &["to","body"]),
          json!({ "to": "mario@example.com", "subject": "Conferma", "body": "Confermo l'ordine." })),

        // ── allegati ────────────────────────────────────────────────────────
        t("attachment_list", "read",
          "Elenca gli allegati di un'email: nome, tipo, dimensione, indice.",
          obj(json!({ "messageId": {"type":"integer"} }), &["messageId"]),
          json!({ "messageId": 1234 })),
        t("attachment_read", "read",
          "Estrae il testo leggibile da un allegato (PDF, TXT, CSV, HTML, XLSX, DOCX).",
          obj(json!({ "messageId": {"type":"integer"}, "partIndex": {"type":"integer"} }), &["messageId","partIndex"]),
          json!({ "messageId": 1234, "partIndex": 1 })),
        t("attachment_scan", "read",
          "Analisi di sicurezza di un allegato: ritorna il livello (safe|caution|danger) e le motivazioni.",
          obj(json!({ "messageId": {"type":"integer"}, "partIndex": {"type":"integer"} }), &["messageId","partIndex"]),
          json!({ "messageId": 1234, "partIndex": 0 })),
        t("attachment_scan_all", "read",
          "Scansiona gli allegati delle email recenti e segnala quelli pericolosi.",
          obj(json!({}), &[]), json!({})),

        // ── agenda / promemoria ─────────────────────────────────────────────
        t("calendar_add", "write",
          "Crea un evento o promemoria in agenda. Indica titolo e data/ora (AAAA-MM-GG HH:MM) ed eventuali note.",
          obj(json!({
              "title": {"type":"string"}, "when": {"type":"string"}, "notes": {"type":"string"},
              "organizationId": {"type":"integer"}, "messageId": {"type":"integer"}
          }), &["title","when"]),
          json!({ "title": "Chiamare ACME", "when": "2026-08-03 10:00" })),
        t("calendar_list", "read",
          "Elenca i prossimi eventi/promemoria in agenda.",
          obj(json!({ "count": {"type":"integer"} }), &[]),
          json!({ "count": 10 })),
        t("calendar_search", "read",
          "Cerca eventi in agenda per titolo o note.",
          obj(json!({ "query": {"type":"string"} }), &["query"]),
          json!({ "query": "ACME" })),
        t("calendar_delete", "write",
          "Elimina un evento dall'agenda dato il suo numero (id).",
          obj(json!({ "id": {"type":"integer"} }), &["id"]),
          json!({ "id": 5 })),
        t("calendar_update", "write",
          "Modifica un evento ESISTENTE dato il suo id. Usa SEMPRE questo per spostare o rinominare: l'evento non si duplica.",
          obj(json!({
              "id": {"type":"integer"}, "when": {"type":"string"},
              "title": {"type":"string"}, "notes": {"type":"string"}
          }), &["id"]),
          json!({ "id": 5, "when": "2026-08-04 09:30" })),
        t("calendar_snooze", "write",
          "Posticipa un evento a una nuova scadenza.",
          obj(json!({ "id": {"type":"integer"}, "when": {"type":"string"} }), &["id","when"]),
          json!({ "id": 5, "when": "2026-08-05 09:00" })),

        // ── memoria (appunti persistenti) ───────────────────────────────────
        t("note_add", "write",
          "Salva un appunto che ricorderai nelle conversazioni future. Indica argomento (topic) e testo.",
          obj(json!({
              "topic": {"type":"string"}, "text": {"type":"string"},
              "importance": {"type":"string","enum":["low","normal","high"]}
          }), &["text"]),
          json!({ "topic": "clienti", "text": "ACME preferisce consegne il lunedì" })),
        t("note_list", "read",
          "Elenca gli appunti salvati, opzionalmente filtrati per argomento.",
          obj(json!({ "topic": {"type":"string"}, "limit": {"type":"integer"} }), &[]),
          json!({})),
        t("note_search", "read",
          "Cerca tra gli appunti per parola chiave (argomento o testo).",
          obj(json!({ "query": {"type":"string"} }), &["query"]),
          json!({ "query": "consegne" })),
        t("note_delete", "write",
          "Elimina un appunto dato il suo numero (id).",
          obj(json!({ "id": {"type":"integer"} }), &["id"]),
          json!({ "id": 3 })),

        // ── rubrica e anagrafiche ───────────────────────────────────────────
        t("contact_search", "read",
          "Cerca in TUTTA la rubrica (aziende e indirizzi email, anche non classificati). Primo tentativo per un nome generico.",
          obj(json!({ "query": {"type":"string"} }), &["query"]),
          json!({ "query": "rossi" })),
        t("customer_search", "read",
          "Cerca solo tra clienti e fornitori già classificati.",
          obj(json!({ "query": {"type":"string"}, "role": {"type":"string","enum":["any","client","supplier"]} }), &["query"]),
          json!({ "query": "acme", "role": "client" })),
        t("customer_get", "read",
          "Scheda completa di un cliente/fornitore: dati fiscali, indirizzo, condizioni, sconti, ultimi documenti.",
          obj(json!({ "id": {"type":"integer"} }), &["id"]),
          json!({ "id": 42 })),
        t("customer_profile", "read",
          "Statistiche di un cliente: documenti totali, fatturato, ultimo documento, distribuzione per tipo.",
          obj(json!({ "id": {"type":"integer"} }), &["id"]),
          json!({ "id": 42 })),
        t("customer_preferred", "read",
          "Condizioni abituali del cliente: corriere, termini di pagamento, porto, lingua.",
          obj(json!({ "id": {"type":"integer"} }), &["id"]),
          json!({ "id": 42 })),
        t("customer_update", "sensitive",
          "Aggiorna i dati anagrafici di un cliente/fornitore. Campi in 'patch': displayName, vatNumber, taxCode, sdiCode, pec, iban, bankName, streetAddress, city, postalCode, province, countryIso2, preferredCourier, paymentTerms, shippingTerms, preferredLanguage, emailAddress, phone, website, notes.",
          obj(json!({ "id": {"type":"integer"}, "patch": {"type":"object"} }), &["id","patch"]),
          json!({ "id": 42, "patch": { "preferredCourier": "DHL" } })),
        t("customer_classify", "sensitive",
          "Classifica un'organizzazione come cliente, fornitore, entrambi o nessuno.",
          obj(json!({ "id": {"type":"integer"}, "role": {"type":"string","enum":["client","supplier","both","none"]} }), &["id","role"]),
          json!({ "id": 117, "role": "client" })),

        // ── articoli e prezzi ───────────────────────────────────────────────
        t("article_search", "read",
          "Cerca articoli per codice, descrizione, marchio o categoria.",
          obj(json!({ "query": {"type":"string"} }), &["query"]),
          json!({ "query": "cavo" })),
        t("article_get", "read",
          "Scheda completa di un articolo dato il codice.",
          obj(json!({ "code": {"type":"string"} }), &["code"]),
          json!({ "code": "ART-100" })),
        t("article_by_brand", "read",
          "Elenca gli articoli di un marchio.",
          obj(json!({ "marchio": {"type":"string"}, "limit": {"type":"integer"} }), &["marchio"]),
          json!({ "marchio": "Acme" })),
        t("article_by_category", "read",
          "Elenca gli articoli di una categoria merceologica.",
          obj(json!({ "categoria": {"type":"string"}, "limit": {"type":"integer"} }), &["categoria"]),
          json!({ "categoria": "Utensileria" })),
        t("article_usage_history", "read",
          "Chi ha comprato un articolo, quante volte, a che prezzo e quando.",
          obj(json!({ "code": {"type":"string"}, "customerId": {"type":"integer"} }), &["code"]),
          json!({ "code": "ART-100" })),
        t("article_pricelist", "read",
          "Prezzo di un articolo in un listino specifico; senza 'listino' usa quello di default.",
          obj(json!({ "code": {"type":"string"}, "listino": {"type":"string"} }), &["code"]),
          json!({ "code": "ART-100" })),
        t("article_create", "sensitive",
          "Crea un nuovo articolo a catalogo.",
          obj(json!({
              "code": {"type":"string"}, "description": {"type":"string"},
              "salePrice": {"type":"number"}, "purchasePrice": {"type":"number"},
              "brandId": {"type":"integer"}, "categoryId": {"type":"integer"},
              "unit": {"type":"string"}, "vatPercent": {"type":"number"}
          }), &["code","description"]),
          json!({ "code": "ART-900", "description": "Nuovo articolo", "salePrice": 100.0 })),
        t("article_update", "sensitive",
          "Aggiorna un articolo esistente. Campi in 'patch': description, unit, vatPercent, notes, isActive, brandId, categoryId, purchasePrice, salePrice, currency, boxQuantity, countryOfOrigin, hsCode.",
          obj(json!({ "code": {"type":"string"}, "patch": {"type":"object"} }), &["code","patch"]),
          json!({ "code": "ART-100", "patch": { "salePrice": 110.0 } })),
        t("article_bulk_update", "sensitive",
          "Applica lo stesso 'patch' a più articoli in una volta.",
          obj(json!({ "codes": {"type":"array","items":{"type":"string"}}, "patch": {"type":"object"} }), &["codes","patch"]),
          json!({ "codes": ["ART-100","ART-200"], "patch": { "isActive": false } })),
        t("pricing_resolve", "read",
          "Prezzo applicabile per un cliente e un articolo. Motore deterministico: override > categoria+marchio > categoria > marchio > globale > listino.",
          obj(json!({ "customerId": {"type":"integer"}, "code": {"type":"string"}, "quantity": {"type":"number"} }), &["customerId","code"]),
          json!({ "customerId": 42, "code": "ART-100" })),
        t("pricing_compare_lists", "read",
          "Confronta il prezzo di un articolo in tutti i listini presenti.",
          obj(json!({ "code": {"type":"string"} }), &["code"]),
          json!({ "code": "ART-100" })),
        t("pricing_set_override", "sensitive",
          "Imposta un prezzo dedicato cliente × articolo: vince su qualsiasi sconto.",
          obj(json!({
              "customerId": {"type":"integer"}, "articleCode": {"type":"string"},
              "unitPrice": {"type":"number"}, "notes": {"type":"string"}
          }), &["customerId","articleCode","unitPrice"]),
          json!({ "customerId": 42, "articleCode": "ART-100", "unitPrice": 85.0 })),
        t("discount_set", "sensitive",
          "Imposta lo sconto di un cliente per categoria × marchio. Lascia categoryId/brandId vuoti per lo sconto più ampio.",
          obj(json!({
              "customerId": {"type":"integer"}, "categoryId": {"type":"integer"},
              "brandId": {"type":"integer"}, "discountPct": {"type":"number"}
          }), &["customerId","discountPct"]),
          json!({ "customerId": 42, "discountPct": 12.0 })),

        // ── documenti ───────────────────────────────────────────────────────
        t("document_list", "read",
          "Elenca i documenti archiviati di un cliente/fornitore, filtrabili per tipo.",
          obj(json!({
              "organizationId": {"type":"integer"},
              "docType": {"type":"string","enum":["sales_order","sales_confirm","quote","purchase_order","purchase_confirm","communication"]}
          }), &["organizationId"]),
          json!({ "organizationId": 42 })),
        t("document_compose_html", "proposal",
          "Genera un documento HTML A4 completo e self-contained (preventivo, conferma d'ordine, lettera, report). L'utente lo vede in anteprima e può stamparlo, salvarlo o allegarlo a un'email.\n\nRegole: un solo documento HTML completo con <style> inline; niente <script>, niente CDN o font esterni; grafici in SVG inline; formato A4 con @page { size: A4; margin: 0 } e contenuto dentro <div class=\"page\"> largo 210mm; dati mittente presi dal PROFILO UTENTE del contesto.",
          obj(json!({
              "title": {"type":"string"},
              "docKind": {"type":"string","enum":["quote","order_confirm","letter","report","communication","other"]},
              "html": {"type":"string"},
              "customerId": {"type":"integer"},
              "suggestedFilename": {"type":"string"}
          }), &["title","docKind","html"]),
          json!({ "title": "Offerta N. 2026-001", "docKind": "quote", "html": "<!doctype html>…" })),
        t("document_compose_chart", "read",
          "Genera un grafico SVG self-contained (bar|line|area|pie|donut) da inserire in un documento HTML.",
          obj(json!({
              "type": {"type":"string","enum":["bar","line","area","pie","donut"]},
              "data": {"type":"array"}, "title": {"type":"string"}
          }), &["type","data"]),
          json!({ "type": "bar", "data": [{"label":"Gen","value":1200}] })),
        t("document_compose_table", "read",
          "Genera una tabella HTML formattata.",
          obj(json!({
              "columns": {"type":"array","items":{"type":"string"}}, "rows": {"type":"array"},
              "style": {"type":"string","enum":["default","accent"]}
          }), &["columns","rows"]),
          json!({ "columns": ["Codice","Prezzo"], "rows": [["ART-100", 85.0]] })),
        t("document_compose_invoice", "proposal",
          "Genera una fattura pro-forma A4 per un cliente.",
          obj(json!({
              "customerId": {"type":"integer"}, "items": {"type":"array"},
              "docNumber": {"type":"string"}, "docDate": {"type":"string"}
          }), &["customerId","items"]),
          json!({ "customerId": 42, "items": [{"code":"ART-100","qty":10}] })),
        t("document_compose_letter", "proposal",
          "Genera una lettera A4 su carta intestata. Template: sollecito | reclamo | benvenuto | aumento_listino | accompagnamento_ordine | generic.",
          obj(json!({
              "recipientId": {"type":"integer"}, "template": {"type":"string"}, "fields": {"type":"object"}
          }), &["recipientId","template"]),
          json!({ "recipientId": 42, "template": "sollecito" })),
        t("document_compose_csv", "proposal",
          "Genera un file CSV pronto al salvataggio.",
          obj(json!({
              "columns": {"type":"array","items":{"type":"string"}}, "rows": {"type":"array"},
              "filename": {"type":"string"}
          }), &["columns","rows"]),
          json!({ "columns": ["code"], "rows": [["ART-100"]] })),
        t("document_create_quote", "sensitive",
          "Registra un preventivo in archivio documenti. Items: [{code, qty, unitPrice?}].",
          obj(json!({
              "customerId": {"type":"integer"}, "docNumber": {"type":"string"},
              "docDate": {"type":"string"}, "items": {"type":"array"}
          }), &["customerId","docDate","items"]),
          json!({ "customerId": 42, "docDate": "2026-08-01", "items": [{"code":"ART-100","qty":10}] })),
        t("document_create_order", "sensitive",
          "Registra un ordine cliente (direction=incoming) o fornitore (outgoing).",
          obj(json!({
              "customerId": {"type":"integer"}, "direction": {"type":"string","enum":["incoming","outgoing"]},
              "docNumber": {"type":"string"}, "docDate": {"type":"string"}, "items": {"type":"array"}
          }), &["customerId","direction","docDate"]),
          json!({ "customerId": 42, "direction": "incoming", "docDate": "2026-08-01", "items": [] })),

        // ── analytics ───────────────────────────────────────────────────────
        t("analytics_top_customers", "read",
          "Migliori clienti per fatturato, ordini o volume nel periodo (year|last-year|month|last-month|week|2026|2026-05).",
          obj(json!({
              "period": {"type":"string"}, "by": {"type":"string","enum":["amount","orders","volume"]},
              "limit": {"type":"integer"}
          }), &[]),
          json!({ "period": "2026", "by": "amount" })),
        t("analytics_top_articles", "read",
          "Articoli più venduti per quantità o fatturato nel periodo.",
          obj(json!({
              "period": {"type":"string"}, "by": {"type":"string","enum":["qty","amount"]},
              "limit": {"type":"integer"}
          }), &[]),
          json!({ "period": "year", "by": "qty" })),
        t("analytics_email_volume", "read",
          "Andamento del volume email nel periodo, raggruppato per giorno, settimana o mese.",
          obj(json!({ "period": {"type":"string"}, "groupBy": {"type":"string","enum":["day","week","month"]} }), &[]),
          json!({ "period": "2026", "groupBy": "month" })),
        t("analytics_customer_churn", "read",
          "Clienti silenti da N mesi: nessun documento e nessuna email scambiata.",
          obj(json!({ "months": {"type":"integer"} }), &[]),
          json!({ "months": 6 })),
    ]
}

/// Esegue un tool e ritorna il risultato come JSON.
/// La policy è: ogni tool è chirurgicamente esposto, niente eval generico.
pub fn execute(name: &str, args: &Value) -> Result<Value> {
    // L'app Liara usa `count` dove qui storicamente si chiamava `limit`:
    // normalizziamo una volta sola invece di duplicare il fallback in ogni tool.
    let normalized;
    let args = match (args.get("count"), args.get("limit"), args.as_object()) {
        (Some(count), None, Some(map)) => {
            let mut m = map.clone();
            m.insert("limit".into(), count.clone());
            normalized = Value::Object(m);
            &normalized
        }
        _ => args,
    };
    match name {
        // core
        "datetime"                  => tools::now(args),
        "system_status"             => tools_admin::medea_system_status(args),
        // email lettura
        "email_recent"              => tools_email::email_recent(args),
        "email_sent"                => tools_email::email_sent(args),
        "email_search"              => tools::messages_search_global(args),
        "email_search_domain"       => tools::messages_search_for_domain(args),
        "email_search_date"         => tools_email::messages_search_by_date(args),
        "email_thread"              => tools_email::messages_thread_get(args),
        "email_followup_pending"    => tools_email::messages_followup_pending(args),
        "email_unread_summary"      => tools_email::messages_unread_summary(args),
        "email_parse_order"         => tools_email::messages_parse_order(args),
        // email azioni locali
        "email_mark_seen"           => tools_email::email_mark_seen(args),
        "email_mark_flagged"        => tools_email::email_mark_flagged(args),
        // email scrittura (proposta)
        "email_draft"               => tools_email::email_draft(args),
        "email_reply"               => tools_email::email_reply(args),
        "email_send"                => tools_email::email_send(args),
        // allegati
        "attachment_list"           => tools::attachments_list(args),
        "attachment_read"           => tools::attachments_read_text(args),
        "attachment_scan"           => tools_admin::security_attachment_threat(args),
        "attachment_scan_all"       => tools_admin::security_scan_all_attachments(args),
        // agenda
        "calendar_add"              => tools_calendar::calendar_add(args),
        "calendar_list"             => tools_calendar::calendar_list(args),
        "calendar_search"           => tools_calendar::calendar_search(args),
        "calendar_delete"           => tools_calendar::calendar_delete(args),
        "calendar_update"           => tools_calendar::calendar_update(args),
        "calendar_snooze"           => tools_calendar::calendar_snooze(args),
        // memoria
        "note_add"                  => tools_notes::note_add(args),
        "note_list"                 => tools_notes::note_list(args),
        "note_search"               => tools_notes::note_search(args),
        "note_delete"               => tools_notes::note_delete(args),
        // rubrica / anagrafiche
        "contact_search"            => tools::address_book_search(args),
        "customer_search"           => tools::customers_search(args),
        "customer_get"              => tools::customers_get(args),
        "customer_profile"          => tools::customers_profile(args),
        "customer_preferred"        => tools::customers_preferred(args),
        "customer_update"           => tools_write::customer_update(args),
        "customer_classify"         => tools_write::customer_classify(args),
        // articoli / prezzi
        "article_search"            => tools::articles_search(args),
        "article_get"               => tools::articles_get(args),
        "article_by_brand"          => tools::articles_by_brand(args),
        "article_by_category"       => tools::articles_by_category(args),
        "article_usage_history"     => tools::articles_usage_history(args),
        "article_pricelist"         => tools::articles_get_pricelist(args),
        "article_create"            => tools_write::article_create(args),
        "article_update"            => tools_write::article_update(args),
        "article_bulk_update"       => tools_write::article_bulk_update(args),
        "pricing_resolve"           => tools::pricing_resolve(args),
        "pricing_compare_lists"     => tools::pricing_compare_lists(args),
        "pricing_set_override"      => tools_write::pricing_set_override(args),
        "discount_set"              => tools_write::discount_set(args),
        // documenti
        "document_list"             => tools::documents_list(args),
        "document_compose_html"     => tools::documents_compose_html(args),
        "document_compose_chart"    => tools_output::documents_compose_chart(args),
        "document_compose_table"    => tools_output::documents_compose_table(args),
        "document_compose_invoice"  => tools_output::documents_compose_invoice(args),
        "document_compose_letter"   => tools_output::documents_compose_letter(args),
        "document_compose_csv"      => tools_output::documents_compose_csv(args),
        "document_create_quote"     => tools_write::document_create_quote(args),
        "document_create_order"     => tools_write::document_create_order(args),
        // analytics
        "analytics_top_customers"   => tools_analytics::analytics_top_customers(args),
        "analytics_top_articles"    => tools_analytics::analytics_top_articles(args),
        "analytics_email_volume"    => tools_analytics::analytics_email_volume(args),
        "analytics_customer_churn"  => tools_analytics::analytics_customer_churn(args),
        _ => Err(anyhow!("tool '{name}' non esiste")),
    }
}
