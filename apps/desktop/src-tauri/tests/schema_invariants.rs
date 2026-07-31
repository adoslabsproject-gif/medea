//! Snapshot anti-regressione dello schema SQLite di Medea.
//!
//! Ogni tabella, colonna, indice e trigger del database è inchiodato qui per
//! nome. Se una migrazione futura cambia lo schema, DEVE cambiare anche questo
//! file — nella stessa PR, con la stessa consapevolezza. Una divergenza
//! silenziosa fra codice e schema è esattamente il bug che questo file rende
//! impossibile.

use medea_desktop_lib::db::schema::{ensure_schema, SCHEMA_VERSION};
use rusqlite::Connection;
use std::collections::BTreeSet;

fn mk() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    ensure_schema(&c).unwrap();
    c
}

fn names(c: &Connection, sql: &str) -> BTreeSet<String> {
    let mut stmt = c.prepare(sql).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn assert_columns(c: &Connection, table: &str, expected: &[&str]) {
    let mut stmt = c.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    let actual: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(actual, expected, "colonne inattese nella tabella {table}");
}

#[test]
fn every_table_exists_and_none_extra() {
    let c = mk();
    let tables = names(
        &c,
        "SELECT name FROM sqlite_master WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%'",
    );
    assert_eq!(
        tables,
        set(&[
            "accounts",
            "app_settings",
            "article_brands",
            "article_categories",
            "articles",
            "attachments",
            "contacts",
            "customer_category_discounts",
            "customer_document_items",
            "customer_documents",
            "customer_price_overrides",
            "email_templates",
            "folder_message_uids",
            "folders",
            "message_labels",
            "messages",
            "messages_fts",
            "notes",
            "organizations",
            "price_list_items",
            "price_lists",
            "reminders",
            "schema_version",
            "workflows",
        ])
    );
}

#[test]
fn mail_tables_keep_their_exact_columns() {
    let c = mk();
    assert_columns(
        &c,
        "accounts",
        &[
            "id",
            "display_name",
            "email_address",
            "imap_host",
            "imap_port",
            "imap_username",
            "smtp_host",
            "smtp_port",
            "smtp_username",
            "smtp_implicit_tls",
            "last_full_sync",
            "created_at",
            "updated_at",
        ],
    );
    assert_columns(
        &c,
        "folders",
        &[
            "id",
            "account_id",
            "path",
            "name",
            "folder_type",
            "uid_validity",
            "last_known_uid",
            "last_sync_at",
        ],
    );
    assert_columns(
        &c,
        "messages",
        &[
            "id",
            "account_id",
            "primary_folder_id",
            "uid",
            "uid_validity",
            "message_id",
            "in_reply_to",
            "references_json",
            "thread_id",
            "subject",
            "from_name",
            "from_address",
            "to_json",
            "cc_json",
            "bcc_json",
            "internal_date",
            "year_partition",
            "size_bytes",
            "has_attachments",
            "is_seen",
            "is_flagged",
            "is_draft",
            "is_local_deleted",
            "body_text",
            "body_html",
            "body_truncated",
            "preview",
            "contact_id",
            "created_at",
            "updated_at",
            "raw_eml",
        ],
    );
    assert_columns(&c, "message_labels", &["message_id", "label"]);
    assert_columns(
        &c,
        "attachments",
        &[
            "id",
            "message_id",
            "filename",
            "content_type",
            "size_bytes",
            "local_path",
            "downloaded_at",
        ],
    );
    assert_columns(
        &c,
        "folder_message_uids",
        &["folder_id", "uid", "message_id"],
    );
    assert_columns(
        &c,
        "messages_fts",
        &["subject", "from_address", "from_name", "body_text"],
    );
}

#[test]
fn crm_tables_keep_their_exact_columns() {
    let c = mk();
    assert_columns(
        &c,
        "contacts",
        &[
            "id",
            "email_address",
            "display_name",
            "organization_id",
            "is_client",
            "is_supplier",
            "notes",
            "first_seen_at",
            "last_seen_at",
            "message_count",
            "created_at",
            "updated_at",
        ],
    );
    assert_columns(
        &c,
        "organizations",
        &[
            "id",
            "domain",
            "display_name",
            "vat_number",
            "address",
            "phone",
            "website",
            "notes",
            "is_client",
            "is_supplier",
            "created_at",
            "updated_at",
            "tax_code",
            "sdi_code",
            "pec",
            "iban",
            "bank_name",
            "street_address",
            "city",
            "postal_code",
            "province",
            "country_iso2",
            "preferred_courier",
            "payment_terms",
            "shipping_terms",
            "preferred_language",
            "email_address",
        ],
    );
    assert_columns(
        &c,
        "customer_documents",
        &[
            "id",
            "organization_id",
            "direction",
            "doc_type",
            "doc_number",
            "doc_date",
            "status",
            "total_amount",
            "currency",
            "message_id",
            "attachment_filename",
            "attachment_path",
            "attachment_sha256",
            "notes",
            "created_at",
            "updated_at",
        ],
    );
    assert_columns(
        &c,
        "customer_document_items",
        &[
            "id",
            "document_id",
            "article_id",
            "code",
            "description",
            "quantity",
            "unit_price",
            "discount_pct",
            "total",
            "row_order",
            "notes",
        ],
    );
}

#[test]
fn catalog_tables_keep_their_exact_columns() {
    let c = mk();
    assert_columns(
        &c,
        "articles",
        &[
            "id",
            "code",
            "description",
            "unit",
            "category",
            "base_price",
            "vat_percent",
            "notes",
            "is_active",
            "created_at",
            "updated_at",
            "brand_id",
            "category_id",
            "purchase_price",
            "sale_price",
            "currency",
            "box_quantity",
            "country_of_origin",
            "hs_code",
        ],
    );
    assert_columns(
        &c,
        "article_brands",
        &["id", "name", "display_order", "is_archived"],
    );
    assert_columns(
        &c,
        "article_categories",
        &[
            "id",
            "parent_id",
            "name",
            "code",
            "display_order",
            "is_archived",
        ],
    );
    assert_columns(
        &c,
        "price_lists",
        &[
            "id",
            "name",
            "organization_id",
            "is_default",
            "valid_from",
            "valid_to",
            "notes",
            "created_at",
            "updated_at",
        ],
    );
    assert_columns(
        &c,
        "price_list_items",
        &[
            "id",
            "price_list_id",
            "article_id",
            "price",
            "discount_percent",
            "notes",
        ],
    );
    assert_columns(
        &c,
        "customer_category_discounts",
        &[
            "id",
            "customer_id",
            "category_id",
            "brand_id",
            "discount_pct",
            "notes",
            "updated_at",
        ],
    );
    assert_columns(
        &c,
        "customer_price_overrides",
        &[
            "id",
            "customer_id",
            "article_id",
            "unit_price",
            "currency",
            "notes",
            "valid_from",
            "valid_to",
            "updated_at",
        ],
    );
}

#[test]
fn assistant_tables_keep_their_exact_columns() {
    let c = mk();
    assert_columns(
        &c,
        "reminders",
        &[
            "id",
            "text",
            "due_at",
            "organization_id",
            "message_id",
            "status",
            "completed_at",
            "last_fired_at",
            "created_at",
            "updated_at",
            "notes",
        ],
    );
    assert_columns(
        &c,
        "notes",
        &[
            "id",
            "topic",
            "text",
            "source",
            "importance",
            "created_at",
            "updated_at",
        ],
    );
    assert_columns(&c, "app_settings", &["key", "value", "updated_at"]);
    assert_columns(
        &c,
        "email_templates",
        &[
            "id",
            "name",
            "is_default",
            "logo_data_url",
            "header_title",
            "header_subtitle",
            "footer_html",
            "accent_color",
            "custom_html",
            "created_at",
            "updated_at",
        ],
    );
    assert_columns(&c, "schema_version", &["version", "applied_at"]);
    assert_columns(
        &c,
        "workflows",
        &[
            "id",
            "name",
            "description",
            "graph_json",
            "execution_target",
            "enabled",
            "created_at",
            "updated_at",
        ],
    );
}

#[test]
fn every_declared_index_exists_and_none_extra() {
    let c = mk();
    let indexes = names(
        &c,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    );
    assert_eq!(
        indexes,
        set(&[
            "idx_article_categories_parent",
            "idx_articles_active",
            "idx_articles_code_prefix",
            "idx_articles_description_nocase",
            "idx_attachments_message",
            "idx_ccd_brand",
            "idx_ccd_category",
            "idx_ccd_customer",
            "idx_cdocs_message",
            "idx_cdocs_org_type_date",
            "idx_cditems_doc",
            "idx_contacts_client",
            "idx_contacts_org",
            "idx_contacts_supplier",
            "idx_cpo_article",
            "idx_cpo_customer",
            "idx_fmu_message",
            "idx_folders_account",
            "idx_messages_account_folder_date",
            "idx_messages_account_msgid",
            "idx_messages_contact",
            "idx_messages_from",
            "idx_messages_thread",
            "idx_messages_uid_per_folder",
            "idx_messages_year",
            "idx_notes_topic",
            "idx_notes_unique",
            "idx_orgs_business_partner",
            "idx_orgs_city_nocase",
            "idx_orgs_displayname_nocase",
            "idx_orgs_taxcode",
            "idx_orgs_vat",
            "idx_priceitems_article",
            "idx_priceitems_list",
            "idx_reminders_due",
            "idx_reminders_org",
            "idx_workflows_updated",
        ])
    );
}

#[test]
fn fts_sync_triggers_are_registered() {
    // "Il trigger È registrato": se uno di questi sparisce, la ricerca smette
    // di vedere i messaggi nuovi senza che nessun altro test se ne accorga.
    let c = mk();
    let triggers = names(&c, "SELECT name FROM sqlite_master WHERE type = 'trigger'");
    for t in ["trg_messages_ai", "trg_messages_ad", "trg_messages_au"] {
        assert!(triggers.contains(t), "trigger FTS mancante: {t}");
    }
}

#[test]
fn schema_version_is_current() {
    let c = mk();
    let v: i32 = c
        .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, SCHEMA_VERSION);
}
