//! Medea desktop shell — entry point.

pub mod ai_tools;
mod commands;
pub mod db;
mod security;

use commands::{
    ai_cmd, ai_tools_cmd, db_cmd, imap_cmd, secrets_cmd, smtp_cmd, sync_cmd, template_cmd,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "medea=info,async_imap=warn".into()),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            // IMAP
            imap_cmd::imap_test_connection,
            imap_cmd::imap_list_folders,
            imap_cmd::imap_list_messages,
            imap_cmd::imap_fetch_message,
            imap_cmd::imap_append,
            // SMTP
            smtp_cmd::smtp_test_connection,
            smtp_cmd::smtp_send,
            smtp_cmd::mail_send_and_archive_sent,
            smtp_cmd::mail_save_draft,
            smtp_cmd::mail_build_eml,
            // DB account / messaggi / ricerca
            db_cmd::db_status,
            db_cmd::db_account_upsert,
            db_cmd::db_account_list,
            db_cmd::db_list_messages,
            db_cmd::db_get_message,
            db_cmd::db_recent_messages,
            db_cmd::db_search,
            db_cmd::db_folder_stats,
            db_cmd::db_ensure_folder,
            db_cmd::db_list_contacts,
            db_cmd::db_list_organizations,
            db_cmd::db_list_articles,
            db_cmd::db_list_price_lists,
            db_cmd::db_get_inline_parts,
            db_cmd::db_list_attachments,
            db_cmd::db_save_attachment,
            db_cmd::save_text_file,
            db_cmd::open_path_in_default_app,
            db_cmd::reveal_in_file_manager,
            // Azioni messaggi (locali, mai sul server)
            db_cmd::db_message_mark_seen,
            db_cmd::db_message_set_flag,
            db_cmd::db_message_local_delete,
            db_cmd::db_message_local_restore,
            // DB Studio
            db_cmd::db_studio_list_tables,
            db_cmd::db_studio_describe_table,
            db_cmd::db_studio_query_table,
            db_cmd::db_studio_primary_key,
            db_cmd::db_studio_row_insert,
            db_cmd::db_studio_row_update,
            db_cmd::db_studio_row_delete,
            // CRUD articoli
            db_cmd::db_article_upsert,
            db_cmd::db_article_delete,
            // CRUD listini
            db_cmd::db_price_list_upsert,
            db_cmd::db_price_list_delete,
            db_cmd::db_price_list_item_upsert,
            db_cmd::db_price_list_item_delete,
            db_cmd::db_price_list_items,
            // Anagrafica clienti/fornitori
            db_cmd::db_contact_set_flags,
            db_cmd::db_organization_update,
            db_cmd::db_organization_insert,
            db_cmd::db_organization_delete,
            db_cmd::db_organization_set_roles,
            db_cmd::db_bulk_delete_organizations,
            db_cmd::db_bulk_delete_articles,
            db_cmd::db_list_business_partners,
            db_cmd::db_get_organization,
            // Lookup brands/categorie
            db_cmd::db_list_brands,
            db_cmd::db_list_categories,
            // Sconti cliente × categoria × marchio
            db_cmd::db_customer_discount_upsert,
            db_cmd::db_customer_discount_delete,
            db_cmd::db_list_customer_discounts,
            // Override prezzo cliente × articolo
            db_cmd::db_customer_price_override_upsert,
            db_cmd::db_customer_price_override_delete,
            db_cmd::db_list_customer_price_overrides,
            // Documenti
            db_cmd::db_customer_document_upsert,
            db_cmd::db_customer_document_delete,
            db_cmd::db_list_customer_documents,
            // Comunicazioni: messaggi per dominio
            db_cmd::db_list_messages_for_domain,
            db_cmd::db_list_messages_for_address,
            db_cmd::db_list_all_documents,
            // Template email (carta intestata)
            template_cmd::db_template_list,
            template_cmd::db_template_default,
            template_cmd::db_template_upsert,
            template_cmd::db_template_delete,
            // Manutenzione dati
            db_cmd::db_business_data_stats,
            db_cmd::db_purge_business_data,
            // Promemoria in scadenza (notifiche OS)
            db_cmd::db_reminders_due,
            db_cmd::db_reminder_mark_fired,
            // Appunti / memorie persistenti
            db_cmd::db_note_add,
            db_cmd::db_note_list,
            db_cmd::db_note_update,
            db_cmd::db_note_delete,
            // Pricing engine deterministico
            db_cmd::db_resolve_price,
            // Sync
            sync_cmd::mail_sync_folder,
            // AI
            ai_cmd::ai_chat,
            ai_tools_cmd::ai_tools_list,
            ai_tools_cmd::ai_tools_call,
            // Segreti (keychain OS)
            secrets_cmd::secret_set,
            secrets_cmd::secret_get,
            secrets_cmd::secret_delete,
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("cannot resolve app_data_dir");
            db::init(data_dir).expect("DB init failed");
            tracing::info!("Medea starting in dev mode");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Medea desktop app");
}
