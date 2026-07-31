//! Schema SQLite di Medea — DDL + migrazioni.
//!
//! Filosofia:
//! - Una **virtual table FTS5** (`messages_fts`) per ricerca istantanea su subject + from + body_text.
//! - Indici composti per scroll cronologico veloce e join contacts/messages.
//! - **Partizionamento logico per anno fiscale** (colonna `year_partition`):
//!   non spezza in tabelle separate (overkill per SQLite), ma è un INTEGER
//!   indicizzato che permette WHERE year_partition = 2026 in O(log n).
//! - `body_text`/`body_html` cap a 500 KB per riga; oltre, salvo solo testo
//!   troncato + flag `body_truncated`.
//! - Allegati: metadata nel DB, blob su filesystem (path in `local_path`).

use anyhow::Result;
use rusqlite::Connection;

pub const SCHEMA_VERSION: i32 = 12;

/// Migrazione v12 — `workflows`: le automazioni disegnate sul canvas.
///
/// Il grafo sta in un'unica colonna JSON invece che in tabelle `nodes` ed
/// `edges` separate. È voluto: la forma del workflow deve restare
/// byte-compatibile con quella del server, che lo tratta come un documento
/// unico. Spezzarlo in righe significherebbe ricomporlo a ogni lettura e
/// rischiare che le due rappresentazioni divergano.
const DDL_V12: &str = r#"
CREATE TABLE IF NOT EXISTS workflows (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    description      TEXT,
    -- Il documento completo: nodes, edges, nodeDefs, executionTarget.
    graph_json       TEXT NOT NULL,
    -- 'local' sul PC, 'server' sulla macchina sempre accesa.
    execution_target TEXT NOT NULL DEFAULT 'local'
                     CHECK(execution_target IN ('local','server')),
    enabled          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC);
"#;

/// Migrazione v11 — `email_templates`: la carta intestata applicata ai
/// messaggi in uscita (nuovi e risposte).
const DDL_V11: &str = r#"
CREATE TABLE IF NOT EXISTS email_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    is_default       INTEGER NOT NULL DEFAULT 0,
    logo_data_url    TEXT,
    header_title     TEXT,
    header_subtitle  TEXT,
    footer_html      TEXT,
    accent_color     TEXT NOT NULL DEFAULT '#4f46e5',
    custom_html      TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
"#;

/// Migrazione v10 — `notes`: memorie persistenti dell'assistente, base dei
/// tool `note_add` / `note_list` / `note_search`. Prima vivevano solo in
/// `localStorage` del frontend, quindi invisibili ai tool.
const DDL_V10: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT NOT NULL DEFAULT 'generale',
    text        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual',
    importance  TEXT NOT NULL DEFAULT 'normal'
                CHECK(importance IN ('low','normal','high')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_unique ON notes(topic, text);
"#;

/// Migrazione v9 — `reminders.notes`: i tool `calendar_*` (allineati all'app
/// Liara) distinguono titolo e note dell'appuntamento.
const DDL_V9: &str = r#"
ALTER TABLE reminders ADD COLUMN notes TEXT;
"#;

/// Migrazione v2: aggiunge raw_eml BLOB per estrarre inline parts (immagini cid:)
/// senza dover rifare FETCH al server.
const DDL_V2: &str = r#"
ALTER TABLE messages ADD COLUMN raw_eml BLOB;
"#;

/// Migrazione v3 — il mini-ERP:
///   1. organizations: dati fiscali, indirizzo strutturato, default operativi
///   2. articles: split listino acquisto/vendita, marchio, categoria, made-in, HS
///   3. lookup tables article_brands / article_categories (preseed)
///   4. customer_category_discounts (sconto per cliente × categoria × marchio)
///   5. customer_price_overrides (prezzo dedicato cliente × articolo)
///   6. customer_documents (5 doc_type) + customer_document_items
const DDL_V3: &str = r#"
-- ── organizations: estensione gestionale ────────────────────────────────────
ALTER TABLE organizations ADD COLUMN tax_code TEXT;            -- codice fiscale
ALTER TABLE organizations ADD COLUMN sdi_code TEXT;            -- codice destinatario SDI
ALTER TABLE organizations ADD COLUMN pec TEXT;
ALTER TABLE organizations ADD COLUMN iban TEXT;
ALTER TABLE organizations ADD COLUMN bank_name TEXT;
ALTER TABLE organizations ADD COLUMN street_address TEXT;
ALTER TABLE organizations ADD COLUMN city TEXT;
ALTER TABLE organizations ADD COLUMN postal_code TEXT;
ALTER TABLE organizations ADD COLUMN province TEXT;
ALTER TABLE organizations ADD COLUMN country_iso2 TEXT;
ALTER TABLE organizations ADD COLUMN preferred_courier TEXT;
ALTER TABLE organizations ADD COLUMN payment_terms TEXT;       -- libero, es. "BB 60gg DF"
ALTER TABLE organizations ADD COLUMN shipping_terms TEXT
    CHECK(shipping_terms IS NULL
        OR shipping_terms IN ('porto_franco','porto_assegnato','franco_con_addebito'));
ALTER TABLE organizations ADD COLUMN preferred_language TEXT;
ALTER TABLE organizations ADD COLUMN email_address TEXT;       -- email principale di ufficio

-- ── articles: split listino + nuovi campi merceologici ─────────────────────
ALTER TABLE articles ADD COLUMN brand_id INTEGER REFERENCES article_brands(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN category_id INTEGER REFERENCES article_categories(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN purchase_price REAL;           -- prezzo di acquisto
ALTER TABLE articles ADD COLUMN sale_price REAL;               -- prezzo di vendita (listino base)
ALTER TABLE articles ADD COLUMN currency TEXT DEFAULT 'EUR';
ALTER TABLE articles ADD COLUMN box_quantity INTEGER;          -- unità per scatola
ALTER TABLE articles ADD COLUMN country_of_origin TEXT;        -- ISO-2 (es. 'IT', 'DE')
ALTER TABLE articles ADD COLUMN hs_code TEXT;                  -- codice doganale (8/10 digit)

-- Backfill: il vecchio campo `base_price` confluisce in `sale_price`.
UPDATE articles SET sale_price = base_price WHERE sale_price IS NULL AND base_price IS NOT NULL;

-- ── Lookup: marchi ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS article_brands (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    display_order   INTEGER DEFAULT 0,
    is_archived     INTEGER NOT NULL DEFAULT 0
);

-- Nessun preseed: i marchi li crea l'utente. Medea è un client neutro.
INSERT OR IGNORE INTO article_brands (name, display_order) VALUES
    ('Altri', 999);

-- ── Lookup: categorie merciologiche (parent/child) ─────────────────────────
CREATE TABLE IF NOT EXISTS article_categories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id       INTEGER REFERENCES article_categories(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    code            TEXT,
    display_order   INTEGER DEFAULT 0,
    is_archived     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (parent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_article_categories_parent
    ON article_categories(parent_id);

-- Nessun preseed merceologico: le categorie le definisce l'utente.
INSERT OR IGNORE INTO article_categories (parent_id, name, display_order) VALUES
    (NULL, 'Altri', 999);

-- ── Sconti per cliente × categoria × marchio ──────────────────────────────
-- Una matrice flessibile: si può lasciare category_id NULL o brand_id NULL
-- per applicare lo sconto a "tutte le categorie" o "tutti i marchi".
-- La regola di pricing applica lo sconto più SPECIFICO disponibile.
CREATE TABLE IF NOT EXISTS customer_category_discounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category_id     INTEGER REFERENCES article_categories(id) ON DELETE CASCADE,
    brand_id        INTEGER REFERENCES article_brands(id) ON DELETE CASCADE,
    discount_pct    REAL NOT NULL DEFAULT 0,
    notes           TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (customer_id, category_id, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_ccd_customer ON customer_category_discounts(customer_id);
CREATE INDEX IF NOT EXISTS idx_ccd_category ON customer_category_discounts(category_id);
CREATE INDEX IF NOT EXISTS idx_ccd_brand    ON customer_category_discounts(brand_id);

-- ── Override prezzo dedicato per cliente × articolo ────────────────────────
-- Vince su qualsiasi sconto di categoria.
CREATE TABLE IF NOT EXISTS customer_price_overrides (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    article_id      INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    unit_price      REAL NOT NULL,
    currency        TEXT DEFAULT 'EUR',
    notes           TEXT,
    valid_from      TEXT,
    valid_to        TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (customer_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_cpo_customer ON customer_price_overrides(customer_id);
CREATE INDEX IF NOT EXISTS idx_cpo_article  ON customer_price_overrides(article_id);

-- ── Documenti per organizzazione (cliente o fornitore) ─────────────────────
-- 5 doc_type:
--   * sales_order        : ordine ricevuto dal cliente
--   * sales_confirm      : conferma d'ordine emessa al cliente
--   * quote              : offerta emessa al cliente
--   * purchase_order     : ordine emesso al fornitore
--   * purchase_confirm   : conferma d'ordine del fornitore
--   * communication      : altra comunicazione (rilevante)
CREATE TABLE IF NOT EXISTS customer_documents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    direction           TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
    doc_type            TEXT NOT NULL CHECK(doc_type IN (
        'sales_order','sales_confirm','quote',
        'purchase_order','purchase_confirm','communication'
    )),
    doc_number          TEXT,
    doc_date            TEXT NOT NULL,
    status              TEXT,            -- libero: aperta / chiusa / evasa / annullata
    total_amount        REAL,
    currency            TEXT DEFAULT 'EUR',
    message_id          INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    attachment_filename TEXT,            -- nome file allegato (se importato)
    attachment_path     TEXT,            -- path locale (Downloads/Medea/...)
    attachment_sha256   TEXT,            -- hash per dedup
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cdocs_org_type_date
    ON customer_documents(organization_id, doc_type, doc_date DESC);
CREATE INDEX IF NOT EXISTS idx_cdocs_message ON customer_documents(message_id);

CREATE TABLE IF NOT EXISTS customer_document_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id     INTEGER NOT NULL REFERENCES customer_documents(id) ON DELETE CASCADE,
    article_id      INTEGER REFERENCES articles(id) ON DELETE SET NULL,
    code            TEXT,
    description     TEXT,
    quantity        REAL NOT NULL DEFAULT 1,
    unit_price      REAL NOT NULL DEFAULT 0,
    discount_pct    REAL DEFAULT 0,
    total           REAL,
    row_order       INTEGER DEFAULT 0,
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_cditems_doc ON customer_document_items(document_id);
"#;

const DDL_V1: &str = r#"
-- Accounts (un record per provider configurato)
CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    email_address   TEXT NOT NULL UNIQUE,
    imap_host       TEXT NOT NULL,
    imap_port       INTEGER NOT NULL,
    imap_username   TEXT NOT NULL,
    smtp_host       TEXT NOT NULL,
    smtp_port       INTEGER NOT NULL,
    smtp_username   TEXT NOT NULL,
    smtp_implicit_tls INTEGER NOT NULL DEFAULT 0,
    last_full_sync  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Folder IMAP scoperte
CREATE TABLE IF NOT EXISTS folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    name            TEXT NOT NULL,
    folder_type     TEXT NOT NULL DEFAULT 'custom',  -- inbox|sent|drafts|spam|trash|archive|custom
    uid_validity    INTEGER,
    last_known_uid  INTEGER NOT NULL DEFAULT 0,
    last_sync_at    TEXT,
    UNIQUE (account_id, path)
);
CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);

-- Messages: una riga per messaggio per account (dedup per message_id).
-- Se lo stesso message_id appare in più cartelle dello stesso account
-- (es. Gmail con labels) viene salvato una sola volta e i tag in
-- `message_labels`.
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    primary_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    uid             INTEGER NOT NULL,
    uid_validity    INTEGER,
    message_id      TEXT,
    in_reply_to     TEXT,
    references_json TEXT,                            -- JSON array
    thread_id       TEXT,                            -- hash deterministico
    subject         TEXT,
    from_name       TEXT,
    from_address    TEXT,
    to_json         TEXT NOT NULL DEFAULT '[]',
    cc_json         TEXT NOT NULL DEFAULT '[]',
    bcc_json        TEXT NOT NULL DEFAULT '[]',
    internal_date   TEXT,                            -- ISO 8601
    year_partition  INTEGER,                         -- anno fiscale: int o NULL
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    is_seen         INTEGER NOT NULL DEFAULT 0,
    is_flagged      INTEGER NOT NULL DEFAULT 0,
    is_draft        INTEGER NOT NULL DEFAULT 0,
    is_local_deleted INTEGER NOT NULL DEFAULT 0,     -- soft delete locale; mai sul server
    body_text       TEXT,                            -- cap 500KB
    body_html       TEXT,                            -- cap 500KB
    body_truncated  INTEGER NOT NULL DEFAULT 0,
    preview         TEXT,                            -- 160 char snippet
    contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_msgid
    ON messages(account_id, message_id)
    WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_account_folder_date
    ON messages(account_id, primary_folder_id, internal_date DESC);

CREATE INDEX IF NOT EXISTS idx_messages_year
    ON messages(account_id, year_partition, internal_date DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages(thread_id, internal_date);

CREATE INDEX IF NOT EXISTS idx_messages_from
    ON messages(account_id, from_address, internal_date DESC);

CREATE INDEX IF NOT EXISTS idx_messages_contact
    ON messages(contact_id, internal_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uid_per_folder
    ON messages(account_id, primary_folder_id, uid);

-- Tag/etichette (sia di sistema, sia Gmail labels custom)
CREATE TABLE IF NOT EXISTS message_labels (
    message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    PRIMARY KEY (message_id, label)
);

-- Allegati (metadata + path su disco)
CREATE TABLE IF NOT EXISTS attachments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename        TEXT,
    content_type    TEXT,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    local_path      TEXT,                            -- presente quando scaricato
    downloaded_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Anagrafica contatti, auto-popolata dalle email + editabile.
CREATE TABLE IF NOT EXISTS contacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email_address   TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    is_client       INTEGER NOT NULL DEFAULT 0,
    is_supplier     INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    first_seen_at   TEXT,
    last_seen_at    TEXT,
    message_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(is_client) WHERE is_client = 1;
CREATE INDEX IF NOT EXISTS idx_contacts_supplier ON contacts(is_supplier) WHERE is_supplier = 1;

-- Organizzazioni (raggruppamento per dominio email)
CREATE TABLE IF NOT EXISTS organizations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    domain          TEXT NOT NULL UNIQUE,            -- es. "acme.it"
    display_name    TEXT,                            -- es. "Acme S.r.l."
    vat_number      TEXT,                            -- P.IVA
    address         TEXT,
    phone           TEXT,
    website         TEXT,
    notes           TEXT,
    is_client       INTEGER NOT NULL DEFAULT 0,
    is_supplier     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- FTS5: ricerca istantanea su subject + from + body_text.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
    subject,
    from_address,
    from_name,
    body_text,
    content='messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Trigger: tieni allineato FTS5 con messages
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_address, from_name, body_text)
    VALUES (new.id, new.subject, new.from_address, new.from_name, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, body_text)
    VALUES ('delete', old.id, old.subject, old.from_address, old.from_name, old.body_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, body_text)
    VALUES ('delete', old.id, old.subject, old.from_address, old.from_name, old.body_text);
    INSERT INTO messages_fts(rowid, subject, from_address, from_name, body_text)
    VALUES (new.id, new.subject, new.from_address, new.from_name, new.body_text);
END;

-- Articoli e listini (sprint 4)
CREATE TABLE IF NOT EXISTS articles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,
    description     TEXT NOT NULL,
    unit            TEXT,                            -- pz / kg / m / h
    category        TEXT,
    base_price      REAL,
    vat_percent     REAL DEFAULT 22.0,
    notes           TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_lists (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    is_default      INTEGER NOT NULL DEFAULT 0,
    valid_from      TEXT,
    valid_to        TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_list_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    price_list_id   INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    article_id      INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    price           REAL NOT NULL,
    discount_percent REAL DEFAULT 0,
    notes           TEXT,
    UNIQUE (price_list_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_priceitems_list ON price_list_items(price_list_id);
CREATE INDEX IF NOT EXISTS idx_priceitems_article ON price_list_items(article_id);

-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
"#;

/// Migrazione v8 —
/// 1. rimozione del catalogo verticale legacy (tabelle `vp_*`): il client è
///    neutro e non contiene più dataset specifici di settore (DROP no-op su
///    DB nuovi);
/// 2. `folder_message_uids`: mapping (folder, uid) → message. Un messaggio
///    multi-cartella (Gmail labels) ha UID diversi in ogni cartella ma una
///    sola riga in `messages`: senza questo set il sync lo riscaricava per
///    intero a ogni passaggio sulle cartelle non-primarie. Backfill dalle
///    righe esistenti.
const DDL_V8: &str = r#"
DROP TABLE IF EXISTS vp_elettrovalvole;
DROP TABLE IF EXISTS vp_bobine;
DROP TABLE IF EXISTS vp_valvole_inclinate;
DROP TABLE IF EXISTS vp_fluidi_tenute;

CREATE TABLE IF NOT EXISTS folder_message_uids (
    folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid         INTEGER NOT NULL,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_fmu_message ON folder_message_uids(message_id);
INSERT OR IGNORE INTO folder_message_uids (folder_id, uid, message_id)
    SELECT primary_folder_id, uid, id FROM messages
     WHERE primary_folder_id IS NOT NULL;
"#;

/// Migrazione v6 — settings chiave-valore per servizi esterni.
const DDL_V6: &str = r#"
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

/// Migrazione v5 — promemoria (reminders) per il Tool F. Notifiche OS-native.
const DDL_V5: &str = r#"
CREATE TABLE IF NOT EXISTS reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    text            TEXT NOT NULL,
    due_at          TEXT NOT NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','done','snoozed','cancelled')),
    completed_at    TEXT,
    last_fired_at   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at)
    WHERE status = 'pending' OR status = 'snoozed';
CREATE INDEX IF NOT EXISTS idx_reminders_org ON reminders(organization_id);
"#;

/// Migrazione v4 — indici performance per ricerche su dataset grossi (5k+ articoli,
/// 4k+ clienti). Niente alter tabelle, solo CREATE INDEX IF NOT EXISTS.
const DDL_V4: &str = r#"
CREATE INDEX IF NOT EXISTS idx_articles_description_nocase
    ON articles(description COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_articles_code_prefix
    ON articles(code COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_articles_active
    ON articles(is_active) WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_orgs_displayname_nocase
    ON organizations(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_orgs_vat
    ON organizations(vat_number) WHERE vat_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orgs_taxcode
    ON organizations(tax_code) WHERE tax_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orgs_city_nocase
    ON organizations(city COLLATE NOCASE) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orgs_business_partner
    ON organizations(is_client, is_supplier)
    WHERE is_client = 1 OR is_supplier = 1;

ANALYZE;
"#;

pub fn ensure_schema(conn: &Connection) -> Result<()> {
    let current: Option<i32> = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |r| {
            r.get::<_, Option<i32>>(0)
        })
        .ok()
        .flatten();

    if current == Some(SCHEMA_VERSION) {
        tracing::info!("Schema già a versione {SCHEMA_VERSION}.");
        return Ok(());
    }

    if current.is_none() {
        tracing::info!("DB nuovo: applico DDL_V1…");
        conn.execute_batch(DDL_V1)?;
    }

    if current.unwrap_or(0) < 2 {
        tracing::info!("Migrazione → v2 (raw_eml)…");
        conn.execute_batch(DDL_V2)?;
    }

    if current.unwrap_or(0) < 3 {
        tracing::info!("Migrazione → v3 (mini-ERP: listini, marchi, categorie, documenti)…");
        conn.execute_batch(DDL_V3)?;
    }

    if current.unwrap_or(0) < 4 {
        tracing::info!("Migrazione → v4 (indici performance per ricerche bulk)…");
        conn.execute_batch(DDL_V4)?;
    }

    if current.unwrap_or(0) < 5 {
        tracing::info!("Migrazione → v5 (reminders + notifiche)…");
        conn.execute_batch(DDL_V5)?;
    }

    if current.unwrap_or(0) < 6 {
        tracing::info!("Migrazione → v6 (app_settings)…");
        conn.execute_batch(DDL_V6)?;
    }

    if current.unwrap_or(0) < 8 {
        tracing::info!("Migrazione → v8 (rimozione tabelle catalogo verticale vp_*)…");
        conn.execute_batch(DDL_V8)?;
    }

    if current.unwrap_or(0) < 9 {
        tracing::info!("Migrazione → v9 (reminders.notes)…");
        conn.execute_batch(DDL_V9)?;
    }

    if current.unwrap_or(0) < 10 {
        tracing::info!("Migrazione → v10 (notes: memorie persistenti)…");
        conn.execute_batch(DDL_V10)?;
    }

    if current.unwrap_or(0) < 11 {
        tracing::info!("Migrazione → v11 (email_templates)…");
        conn.execute_batch(DDL_V11)?;
    }

    if current.unwrap_or(0) < 12 {
        tracing::info!("Migrazione → v12 (workflows)…");
        conn.execute_batch(DDL_V12)?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO schema_version(version, applied_at) VALUES (?1, datetime('now'))",
        rusqlite::params![SCHEMA_VERSION],
    )?;
    tracing::info!("Schema portato a v{SCHEMA_VERSION}.");
    Ok(())
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
