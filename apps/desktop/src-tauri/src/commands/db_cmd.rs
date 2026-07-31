//! Comandi DB: persistenza account, lettura messaggi locali, ricerca FTS5.

use serde::Serialize;

use crate::db;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInitInfo {
    pub initialized: bool,
}

#[tauri::command]
pub fn db_status() -> Result<DbInitInfo, String> {
    let ok = db::with_db(|_c| Ok(true)).is_ok();
    Ok(DbInitInfo { initialized: ok })
}

#[tauri::command]
pub fn db_account_upsert(account: db::accounts::StoredAccount) -> Result<(), String> {
    db::with_db(|c| db::accounts::upsert(c, &account)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_account_list() -> Result<Vec<db::accounts::StoredAccount>, String> {
    db::with_db(|c| db::accounts::list(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_messages(
    account_id: String,
    folder_id: i64,
    limit: u32,
    offset: u32,
) -> Result<Vec<db::messages::ListedMessage>, String> {
    db::with_db(|c| db::messages::list_for_folder(c, &account_id, folder_id, limit, offset))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_message(id: i64) -> Result<Option<db::messages::FullMessage>, String> {
    db::with_db(|c| db::messages::get_full(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_recent_messages(
    account_id: String,
    limit: u32,
) -> Result<Vec<db::messages::ListedMessage>, String> {
    db::with_db(|c| db::messages::list_recent_global(c, &account_id, limit))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_messages_for_domain(
    account_id: String,
    domain: String,
    limit: u32,
) -> Result<Vec<db::messages::ListedMessage>, String> {
    db::with_db(|c| db::messages::list_for_domain(c, &account_id, &domain, limit))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_messages_for_address(
    address: String,
    limit: u32,
) -> Result<Vec<db::messages::ListedMessage>, String> {
    db::with_db(|c| db::messages::list_for_address(c, &address, limit)).map_err(|e| e.to_string())
}

/// Conteggio dei dati commerciali presenti, per la conferma prima del reset.
#[tauri::command]
pub fn db_business_data_stats() -> Result<serde_json::Value, String> {
    db::with_db(|c| {
        let q = |sql: &str| -> anyhow::Result<i64> {
            c.query_row(sql, [], |r| r.get::<_, i64>(0))
                .map_err(anyhow::Error::from)
        };
        Ok(serde_json::json!({
            "importedOrganizations": q(
                "SELECT COUNT(*) FROM organizations WHERE domain LIKE 'sigla:%'")?,
            "articles":       q("SELECT COUNT(*) FROM articles")?,
            "priceLists":     q("SELECT COUNT(*) FROM price_lists")?,
            "priceListItems": q("SELECT COUNT(*) FROM price_list_items")?,
            "discounts":      q("SELECT COUNT(*) FROM customer_category_discounts")?,
            "priceOverrides": q("SELECT COUNT(*) FROM customer_price_overrides")?,
            "documents":      q("SELECT COUNT(*) FROM customer_documents")?,
        }))
    })
    .map_err(|e| e.to_string())
}

/// Svuota i dati commerciali importati lasciando intatta la struttura.
///
/// Cancella: articoli, listini e righe, sconti, override prezzo, documenti,
/// marchi/categorie e le organizzazioni provenienti da import gestionale
/// (dominio `sigla:*`).
/// NON tocca: email, cartelle, account, contatti e le organizzazioni dedotte
/// dai domini email — quelle si ricostruiscono dal sync e sono dati veri.
#[tauri::command]
pub fn db_purge_business_data() -> Result<serde_json::Value, String> {
    db::with_db(|c| {
        let tx = c.transaction()?;
        let mut deleted = serde_json::Map::new();
        let mut del =
            |tx: &rusqlite::Transaction<'_>, label: &str, sql: &str| -> anyhow::Result<()> {
                let n = tx.execute(sql, [])?;
                deleted.insert(label.to_string(), serde_json::json!(n));
                Ok(())
            };
        // L'ordine rispetta le foreign key (i figli prima dei padri).
        del(&tx, "documentItems", "DELETE FROM customer_document_items")?;
        del(&tx, "documents", "DELETE FROM customer_documents")?;
        del(&tx, "priceListItems", "DELETE FROM price_list_items")?;
        del(&tx, "priceLists", "DELETE FROM price_lists")?;
        del(
            &tx,
            "priceOverrides",
            "DELETE FROM customer_price_overrides",
        )?;
        del(&tx, "discounts", "DELETE FROM customer_category_discounts")?;
        del(&tx, "articles", "DELETE FROM articles")?;
        del(
            &tx,
            "brands",
            "DELETE FROM article_brands WHERE name <> 'Altri'",
        )?;
        del(
            &tx,
            "categories",
            "DELETE FROM article_categories WHERE name <> 'Altri'",
        )?;
        del(
            &tx,
            "importedOrganizations",
            "DELETE FROM organizations WHERE domain LIKE 'sigla:%'",
        )?;
        tx.commit()?;
        Ok(serde_json::Value::Object(deleted))
    })
    .map_err(|e| e.to_string())
}

/// Archivio documenti globale (tutti i partner), filtrabile per tipo.
#[tauri::command]
pub fn db_list_all_documents(
    doc_type: Option<String>,
    limit: u32,
) -> Result<Vec<db::crud::DocumentWithPartner>, String> {
    db::with_db(|c| db::crud::list_all_documents(c, doc_type.as_deref(), limit))
        .map_err(|e| e.to_string())
}

// ── Promemoria in scadenza (dispatcher notifiche) ──────────────────────────

/// Promemoria la cui scadenza è passata e che non sono ancora stati notificati
/// in questa sessione. Il frontend li trasforma in notifiche OS.
#[tauri::command]
pub fn db_reminders_due() -> Result<Vec<db::reminders::ReminderRow>, String> {
    let now = chrono::Local::now().to_rfc3339();
    db::with_db(|c| db::reminders::list_due_before(c, &now)).map_err(|e| e.to_string())
}

/// Marca un promemoria come già notificato (evita notifiche ripetute).
#[tauri::command]
pub fn db_reminder_mark_fired(id: i64) -> Result<(), String> {
    db::with_db(|c| db::reminders::mark_fired(c, id)).map_err(|e| e.to_string())
}

// ── Appunti / memorie persistenti ──────────────────────────────────────────

#[tauri::command]
pub fn db_note_add(note: db::notes::NoteInput) -> Result<i64, String> {
    db::with_db(|c| db::notes::add(c, &note)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_note_list(topic: Option<String>, limit: u32) -> Result<Vec<db::notes::NoteRow>, String> {
    db::with_db(|c| db::notes::list(c, topic.as_deref(), limit)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_note_update(
    id: i64,
    text: Option<String>,
    importance: Option<String>,
) -> Result<(), String> {
    db::with_db(|c| db::notes::update(c, id, text.as_deref(), importance.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_note_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::notes::delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_search(
    account_id: String,
    query: String,
    limit: u32,
) -> Result<Vec<db::messages::SearchHit>, String> {
    db::with_db(|c| db::messages::search_fts(c, &account_id, &query, limit))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_folder_stats(
    account_id: String,
    folder_id: i64,
) -> Result<db::messages::FolderStats, String> {
    db::with_db(|c| db::messages::folder_stats(c, &account_id, folder_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_ensure_folder(
    account_id: String,
    path: String,
    name: String,
    folder_type: String,
) -> Result<i64, String> {
    db::with_db(|c| db::messages::ensure_folder(c, &account_id, &path, &name, &folder_type))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_contacts(limit: u32, offset: u32) -> Result<Vec<db::anag::ContactRow>, String> {
    db::with_db(|c| db::anag::list_contacts(c, limit, offset)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_organizations(
    limit: u32,
    offset: u32,
) -> Result<Vec<db::anag::OrganizationRow>, String> {
    db::with_db(|c| db::anag::list_organizations(c, limit, offset)).map_err(|e| e.to_string())
}

/// Anagrafica clienti/fornitori: solo `organizations` con flag is_client/is_supplier.
/// Distinta dalla rubrica indirizzi (contacts auto-aggregati dalle email).
#[tauri::command]
pub fn db_list_business_partners(
    only_clients: bool,
    only_suppliers: bool,
) -> Result<Vec<db::anag::OrganizationRow>, String> {
    db::with_db(|c| db::anag::list_business_partners(c, only_clients, only_suppliers))
        .map_err(|e| e.to_string())
}

/// Scheda completa di un cliente/fornitore.
#[tauri::command]
pub fn db_get_organization(id: i64) -> Result<Option<db::anag::OrganizationDetail>, String> {
    db::with_db(|c| db::anag::get_organization(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_articles(limit: u32, offset: u32) -> Result<Vec<db::anag::ArticleRow>, String> {
    db::with_db(|c| db::anag::list_articles(c, limit, offset)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_price_lists() -> Result<Vec<db::anag::PriceListRow>, String> {
    db::with_db(|c| db::anag::list_price_lists(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_inline_parts(message_id: i64) -> Result<Vec<db::messages::InlinePart>, String> {
    db::with_db(|c| db::messages::get_inline_parts(c, message_id)).map_err(|e| e.to_string())
}

// ── Allegati con scanner di sicurezza ───────────────────────────────────────

#[tauri::command]
pub fn db_list_attachments(
    message_id: i64,
) -> Result<Vec<crate::security::attachments::AttachmentEntry>, String> {
    db::with_db(|c| db::messages::list_attachments_with_threat(c, message_id))
        .map_err(|e| e.to_string())
}

/// Apre il Finder/Explorer con il FILE EVIDENZIATO (non lo apre).
/// Utile per mostrare all'utente dove un file è stato salvato.
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .args(["-R", &path])
            .status()
    } else if cfg!(target_os = "windows") {
        // explorer.exe /select,"C:\path\file.ext"
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .status()
    } else {
        // Linux: apri la cartella contenente (xdg-open non supporta select)
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        std::process::Command::new("xdg-open").arg(&parent).status()
    };
    match result {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("reveal exit code: {s}")),
        Err(e) => Err(format!("reveal error: {e}")),
    }
}

/// Apre un file con l'applicazione di default del sistema operativo host.
/// Per i file HTML/PDF/immagini, converte in `file://` URL canonico per essere
/// sicuro che il browser apra la pagina invece di limitarsi a portarsi in
/// primo piano.
#[tauri::command]
pub fn open_path_in_default_app(path: String) -> Result<(), String> {
    use std::path::Path;
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("file non esiste: {path}"));
    }

    // Costruisci file:// URL con encoding minimo per spazi/caratteri speciali.
    let abs = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    let abs_str = abs.to_string_lossy().to_string();
    let encoded: String = abs_str
        .chars()
        .map(|c| match c {
            ' ' => "%20".into(),
            '?' => "%3F".into(),
            '#' => "%23".into(),
            '%' => "%25".into(),
            c if c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | ':') => {
                c.to_string()
            }
            c => {
                let mut buf = [0u8; 4];
                let s = c.encode_utf8(&mut buf);
                s.bytes().map(|b| format!("%{:02X}", b)).collect()
            }
        })
        .collect();
    let file_url = format!("file://{}", encoded);

    let result = if cfg!(target_os = "macos") {
        // -g = NON portare l'app in primo piano se è già aperta (così non
        // copre Medea senza motivo); -u accetta URL invece di path.
        std::process::Command::new("open")
            .args(["-u", &file_url])
            .status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &abs_str])
            .status()
    } else {
        std::process::Command::new("xdg-open")
            .arg(&abs_str)
            .status()
    };
    tracing::info!(
        "open_path_in_default_app path={} url={} result={:?}",
        path,
        file_url,
        result
    );
    match result {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("open exit code: {s}")),
        Err(e) => Err(format!("open error: {e}")),
    }
}

/// Salva un file di testo (HTML, TXT, CSV, ecc.) su disco. Cross-platform:
/// il `dest_path` deve essere già stato costruito col separatore nativo
/// (lato JS via `path.join`).
#[tauri::command]
pub fn save_text_file(dest_path: String, content: String) -> Result<String, String> {
    use std::path::Path;
    let p = Path::new(&dest_path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(p, content.as_bytes()).map_err(|e| format!("write: {e}"))?;
    Ok(dest_path)
}

#[tauri::command]
pub fn db_save_attachment(
    message_id: i64,
    part_index: u32,
    dest_path: String,
) -> Result<String, String> {
    use std::path::Path;
    let triple =
        db::with_db(|c| db::messages::get_attachment_bytes(c, message_id, part_index as usize))
            .map_err(|e| e.to_string())?;
    let Some((_fname, _ctype, bytes)) = triple else {
        return Err("Allegato non trovato".into());
    };
    let p = Path::new(&dest_path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(p, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(dest_path)
}

// ── Azioni sui messaggi (tutte locali, mai sul server IMAP) ──────────────────

#[tauri::command]
pub fn db_message_mark_seen(message_id: i64, seen: bool) -> Result<(), String> {
    db::with_db(|c| {
        c.execute(
            "UPDATE messages SET is_seen = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![seen as i32, message_id],
        )?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn db_message_set_flag(message_id: i64, flagged: bool) -> Result<(), String> {
    db::with_db(|c| {
        c.execute(
            "UPDATE messages SET is_flagged = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![flagged as i32, message_id],
        )?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

/// Soft delete: nasconde il messaggio dalla UI ma NON tocca il server IMAP.
#[tauri::command]
pub fn db_message_local_delete(message_id: i64) -> Result<(), String> {
    db::with_db(|c| {
        c.execute(
            "UPDATE messages SET is_local_deleted = 1, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![message_id],
        )?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn db_message_local_restore(message_id: i64) -> Result<(), String> {
    db::with_db(|c| {
        c.execute(
            "UPDATE messages SET is_local_deleted = 0, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![message_id],
        )?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

// ── DB Studio: esplorazione tabelle (solo SELECT, whitelist) ────────────────

#[tauri::command]
pub fn db_studio_list_tables() -> Result<Vec<db::studio::TableInfo>, String> {
    db::with_db(|c| db::studio::list_tables(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_studio_describe_table(table: String) -> Result<Vec<db::studio::ColumnInfo>, String> {
    db::with_db(|c| db::studio::describe_table(c, &table)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_studio_query_table(
    table: String,
    limit: u32,
    offset: u32,
    filter: Option<String>,
) -> Result<db::studio::TablePage, String> {
    db::with_db(|c| db::studio::query_table(c, &table, limit, offset, filter.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_studio_primary_key(table: String) -> Result<Option<String>, String> {
    db::with_db(|c| db::studio::primary_key(c, &table)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_studio_row_insert(
    table: String,
    values: serde_json::Value,
) -> Result<db::studio::CrudResult, String> {
    db::with_db(|c| db::studio::row_insert(c, &table, &values)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_studio_row_update(
    table: String,
    pk_col: String,
    pk_val: serde_json::Value,
    patch: serde_json::Value,
) -> Result<db::studio::CrudResult, String> {
    db::with_db(|c| db::studio::row_update(c, &table, &pk_col, &pk_val, &patch))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_studio_row_delete(
    table: String,
    pk_col: String,
    pk_val: serde_json::Value,
) -> Result<db::studio::CrudResult, String> {
    db::with_db(|c| db::studio::row_delete(c, &table, &pk_col, &pk_val)).map_err(|e| e.to_string())
}

// ── CRUD: articoli ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_article_upsert(article: db::crud::ArticleInput) -> Result<i64, String> {
    db::with_db(|c| db::crud::article_upsert(c, &article)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_article_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::article_delete(c, id)).map_err(|e| e.to_string())
}

// ── CRUD: listini ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_price_list_upsert(price_list: db::crud::PriceListInput) -> Result<i64, String> {
    db::with_db(|c| db::crud::price_list_upsert(c, &price_list)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_price_list_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::price_list_delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_price_list_item_upsert(item: db::crud::PriceListItemInput) -> Result<i64, String> {
    db::with_db(|c| db::crud::price_list_item_upsert(c, &item)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_price_list_item_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::price_list_item_delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_price_list_items(price_list_id: i64) -> Result<Vec<db::crud::PriceListItemRow>, String> {
    db::with_db(|c| db::crud::price_list_items(c, price_list_id)).map_err(|e| e.to_string())
}

// ── CRUD: anagrafica clienti/fornitori ─────────────────────────────────────

#[tauri::command]
pub fn db_contact_set_flags(id: i64, is_client: bool, is_supplier: bool) -> Result<(), String> {
    db::with_db(|c| db::crud::contact_set_flags(c, id, is_client, is_supplier))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_organization_update(org: db::crud::OrganizationUpdate) -> Result<(), String> {
    db::with_db(|c| db::crud::organization_update(c, &org)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_organization_insert(org: db::crud::OrganizationInsert) -> Result<i64, String> {
    db::with_db(|c| db::crud::organization_insert(c, &org)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_organization_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::organization_delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_bulk_delete_organizations(ids: Vec<i64>) -> Result<i64, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    db::with_db(|c| {
        let tx = c.transaction()?;
        let mut n = 0i64;
        {
            let mut stmt = tx.prepare("DELETE FROM organizations WHERE id = ?1")?;
            for id in &ids {
                n += stmt.execute(rusqlite::params![id])? as i64;
            }
        }
        tx.commit()?;
        Ok(n)
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn db_bulk_delete_articles(ids: Vec<i64>) -> Result<i64, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    db::with_db(|c| {
        let tx = c.transaction()?;
        let mut n = 0i64;
        {
            let mut stmt = tx.prepare("DELETE FROM articles WHERE id = ?1")?;
            for id in &ids {
                n += stmt.execute(rusqlite::params![id])? as i64;
            }
        }
        tx.commit()?;
        Ok(n)
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn db_organization_set_roles(
    id: i64,
    is_client: bool,
    is_supplier: bool,
) -> Result<(), String> {
    db::with_db(|c| db::crud::organization_set_roles(c, id, is_client, is_supplier))
        .map_err(|e| e.to_string())
}

// ── Lookup brands / categorie ──────────────────────────────────────────────

#[tauri::command]
pub fn db_list_brands() -> Result<Vec<db::crud::BrandRow>, String> {
    db::with_db(|c| db::crud::list_brands(c)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_categories() -> Result<Vec<db::crud::CategoryRow>, String> {
    db::with_db(|c| db::crud::list_categories(c)).map_err(|e| e.to_string())
}

// ── Sconti cliente × categoria × marchio ───────────────────────────────────

#[tauri::command]
pub fn db_customer_discount_upsert(
    discount: db::crud::CustomerDiscountInput,
) -> Result<i64, String> {
    db::with_db(|c| db::crud::customer_discount_upsert(c, &discount)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_customer_discount_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::customer_discount_delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_customer_discounts(
    customer_id: i64,
) -> Result<Vec<db::crud::CustomerDiscountRow>, String> {
    db::with_db(|c| db::crud::list_customer_discounts(c, customer_id)).map_err(|e| e.to_string())
}

// ── Override prezzo cliente × articolo ─────────────────────────────────────

#[tauri::command]
pub fn db_customer_price_override_upsert(
    override_: db::crud::CustomerPriceOverrideInput,
) -> Result<i64, String> {
    db::with_db(|c| db::crud::customer_price_override_upsert(c, &override_))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_customer_price_override_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::customer_price_override_delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_customer_price_overrides(
    customer_id: i64,
) -> Result<Vec<db::crud::CustomerPriceOverrideRow>, String> {
    db::with_db(|c| db::crud::list_customer_price_overrides(c, customer_id))
        .map_err(|e| e.to_string())
}

// ── Documenti ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_customer_document_upsert(doc: db::crud::CustomerDocumentInput) -> Result<i64, String> {
    db::with_db(|c| db::crud::customer_document_upsert(c, &doc)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_customer_document_delete(id: i64) -> Result<(), String> {
    db::with_db(|c| db::crud::customer_document_delete(c, id)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_customer_documents(
    organization_id: i64,
    doc_type: Option<String>,
) -> Result<Vec<db::crud::CustomerDocumentRow>, String> {
    db::with_db(|c| db::crud::list_customer_documents(c, organization_id, doc_type.as_deref()))
        .map_err(|e| e.to_string())
}

// ── Pricing deterministico (esposto per Liara come tool) ───────────────────

#[tauri::command]
pub fn db_resolve_price(
    customer_id: i64,
    article_code: String,
) -> Result<Option<db::pricing::PriceResolution>, String> {
    db::with_db(|c| db::pricing::resolve_for_customer(c, customer_id, &article_code))
        .map_err(|e| e.to_string())
}
