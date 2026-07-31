//! I vincoli dello schema, esercitati davvero: CHECK che respingono, UNIQUE
//! che deduplicano, cascade che puliscono, trigger FTS che indicizzano.
//!
//! Un vincolo dichiarato ma mai esercitato è un commento travestito da SQL:
//! questi test lo trasformano in comportamento garantito.

use medea_desktop_lib::db::schema::ensure_schema;
use rusqlite::{params, Connection};

fn mk() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    ensure_schema(&c).unwrap();
    c
}

fn seed_account(c: &Connection, id: &str) {
    c.execute(
        "INSERT INTO accounts (id, display_name, email_address, imap_host, imap_port,
                               imap_username, smtp_host, smtp_port, smtp_username,
                               created_at, updated_at)
         VALUES (?1, 'Test', ?2, 'imap.test', 993, 'u', 'smtp.test', 465, 'u',
                 datetime('now'), datetime('now'))",
        params![id, format!("{id}@test.local")],
    )
    .unwrap();
}

fn seed_message(c: &Connection, account: &str, uid: i64, message_id: Option<&str>) -> i64 {
    c.execute(
        "INSERT INTO messages (account_id, uid, message_id, subject, from_address, from_name,
                               body_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Fattura marzo', 'rossi@acme.test', 'Mario Rossi',
                 'in allegato la fattura del bilancio', datetime('now'), datetime('now'))",
        params![account, uid, message_id],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn fts_hits(c: &Connection, term: &str) -> i64 {
    c.query_row(
        "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?1",
        params![term],
        |r| r.get(0),
    )
    .unwrap()
}

// ── CHECK constraints ───────────────────────────────────────────────────────

#[test]
fn reminder_status_check_rejects_unknown_states() {
    let c = mk();
    let bad = c.execute(
        "INSERT INTO reminders (text, due_at, status) VALUES ('x', datetime('now'), 'forse')",
        [],
    );
    assert!(bad.is_err(), "status fuori enum accettato");
    c.execute(
        "INSERT INTO reminders (text, due_at, status) VALUES ('x', datetime('now'), 'pending')",
        [],
    )
    .unwrap();
}

#[test]
fn customer_document_checks_reject_invalid_direction_and_type() {
    let c = mk();
    c.execute(
        "INSERT INTO organizations (domain, created_at, updated_at)
         VALUES ('acme.test', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    let org = c.last_insert_rowid();

    let bad_direction = c.execute(
        "INSERT INTO customer_documents (organization_id, direction, doc_type, doc_date)
         VALUES (?1, 'sideways', 'quote', date('now'))",
        params![org],
    );
    assert!(bad_direction.is_err());

    let bad_type = c.execute(
        "INSERT INTO customer_documents (organization_id, direction, doc_type, doc_date)
         VALUES (?1, 'incoming', 'meme', date('now'))",
        params![org],
    );
    assert!(bad_type.is_err());
}

#[test]
fn organization_shipping_terms_check_allows_null_and_known_values_only() {
    let c = mk();
    c.execute(
        "INSERT INTO organizations (domain, shipping_terms, created_at, updated_at)
         VALUES ('a.test', NULL, datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO organizations (domain, shipping_terms, created_at, updated_at)
         VALUES ('b.test', 'porto_franco', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    let bad = c.execute(
        "INSERT INTO organizations (domain, shipping_terms, created_at, updated_at)
         VALUES ('c.test', 'gratis', datetime('now'), datetime('now'))",
        [],
    );
    assert!(bad.is_err());
}

#[test]
fn note_importance_check_holds() {
    let c = mk();
    let bad = c.execute(
        "INSERT INTO notes (topic, text, importance, created_at, updated_at)
         VALUES ('t', 'x', 'urgentissima', datetime('now'), datetime('now'))",
        [],
    );
    assert!(bad.is_err());
}

#[test]
fn workflow_execution_target_check_holds() {
    let c = mk();
    let bad = c.execute(
        "INSERT INTO workflows (name, graph_json, execution_target, created_at, updated_at)
         VALUES ('wf', '{}', 'cloud', datetime('now'), datetime('now'))",
        [],
    );
    assert!(bad.is_err(), "execution_target fuori enum accettato");
    for target in ["local", "server"] {
        c.execute(
            "INSERT INTO workflows (name, graph_json, execution_target, created_at, updated_at)
             VALUES (?1, '{}', ?2, datetime('now'), datetime('now'))",
            params![format!("wf_{target}"), target],
        )
        .unwrap();
    }
    let enabled_default: i64 = c
        .query_row(
            "SELECT enabled FROM workflows WHERE name = 'wf_local'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(enabled_default, 0, "un workflow nuovo deve nascere spento");
}

// ── UNIQUE ──────────────────────────────────────────────────────────────────

#[test]
fn duplicate_message_id_per_account_is_rejected_but_null_is_free() {
    let c = mk();
    seed_account(&c, "acc1");
    seed_message(&c, "acc1", 1, Some("<msg-1@acme.test>"));
    // Stesso message_id, stesso account: il dedup del sync engine.
    let dup = c.execute(
        "INSERT INTO messages (account_id, uid, message_id, created_at, updated_at)
         VALUES ('acc1', 2, '<msg-1@acme.test>', datetime('now'), datetime('now'))",
        [],
    );
    assert!(
        dup.is_err(),
        "message_id duplicato accettato: il sync duplicherebbe le mail"
    );

    // L'indice è parziale: due messaggi SENZA message_id devono convivere.
    seed_message(&c, "acc1", 3, None);
    seed_message(&c, "acc1", 4, None);
}

#[test]
fn account_email_and_folder_path_are_unique() {
    let c = mk();
    seed_account(&c, "acc1");
    let dup_mail = c.execute(
        "INSERT INTO accounts (id, display_name, email_address, imap_host, imap_port,
                               imap_username, smtp_host, smtp_port, smtp_username,
                               created_at, updated_at)
         VALUES ('acc2', 'X', 'acc1@test.local', 'h', 1, 'u', 'h', 1, 'u',
                 datetime('now'), datetime('now'))",
        [],
    );
    assert!(dup_mail.is_err());

    c.execute(
        "INSERT INTO folders (account_id, path, name) VALUES ('acc1', 'INBOX', 'Posta')",
        [],
    )
    .unwrap();
    let dup_path = c.execute(
        "INSERT INTO folders (account_id, path, name) VALUES ('acc1', 'INBOX', 'Doppione')",
        [],
    );
    assert!(dup_path.is_err());
}

// ── Cascade e integrità referenziale ────────────────────────────────────────

#[test]
fn deleting_an_account_cascades_to_folders_and_messages() {
    let c = mk();
    seed_account(&c, "acc1");
    c.execute(
        "INSERT INTO folders (account_id, path, name) VALUES ('acc1', 'INBOX', 'Posta')",
        [],
    )
    .unwrap();
    let msg = seed_message(&c, "acc1", 1, Some("<m@t>"));
    c.execute(
        "INSERT INTO message_labels (message_id, label) VALUES (?1, 'urgente')",
        params![msg],
    )
    .unwrap();
    c.execute(
        "INSERT INTO attachments (message_id, filename) VALUES (?1, 'fattura.pdf')",
        params![msg],
    )
    .unwrap();

    c.execute("DELETE FROM accounts WHERE id = 'acc1'", [])
        .unwrap();

    for table in ["folders", "messages", "message_labels", "attachments"] {
        let left: i64 = c
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "{table} non svuotata dalla cascade");
    }
    let orphans = c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_| Ok(()))
        .unwrap()
        .count();
    assert_eq!(orphans, 0, "righe orfane dopo la cascade");
}

#[test]
fn deleting_an_organization_releases_contacts_without_deleting_them() {
    let c = mk();
    c.execute(
        "INSERT INTO organizations (domain, created_at, updated_at)
         VALUES ('acme.test', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    let org = c.last_insert_rowid();
    c.execute(
        "INSERT INTO contacts (email_address, organization_id, created_at, updated_at)
         VALUES ('rossi@acme.test', ?1, datetime('now'), datetime('now'))",
        params![org],
    )
    .unwrap();

    c.execute("DELETE FROM organizations WHERE id = ?1", params![org])
        .unwrap();

    let (count, org_ref): (i64, Option<i64>) = c
        .query_row(
            "SELECT COUNT(*), MAX(organization_id) FROM contacts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        count, 1,
        "il contatto doveva sopravvivere (SET NULL, non CASCADE)"
    );
    assert_eq!(org_ref, None);
}

// ── FTS5: la ricerca vede ciò che succede a messages ────────────────────────

#[test]
fn fts_index_follows_insert_update_delete() {
    let c = mk();
    seed_account(&c, "acc1");
    let msg = seed_message(&c, "acc1", 1, Some("<m@t>"));
    assert_eq!(fts_hits(&c, "fattura"), 1, "insert non indicizzato");

    c.execute(
        "UPDATE messages SET subject = 'Preventivo aprile' WHERE id = ?1",
        params![msg],
    )
    .unwrap();
    assert_eq!(fts_hits(&c, "preventivo"), 1, "update non reindicizzato");

    c.execute("DELETE FROM messages WHERE id = ?1", params![msg])
        .unwrap();
    assert_eq!(fts_hits(&c, "preventivo"), 0, "delete rimasto nell'indice");
    assert_eq!(fts_hits(&c, "fattura"), 0);
}

#[test]
fn fts_search_ignores_diacritics() {
    let c = mk();
    seed_account(&c, "acc1");
    c.execute(
        "INSERT INTO messages (account_id, uid, subject, created_at, updated_at)
         VALUES ('acc1', 9, 'Novità sul contratto', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    assert_eq!(fts_hits(&c, "novita"), 1, "remove_diacritics 2 non attivo");
}
