//! Test della catena di migrazioni — vivono qui (e non in `tests/`) perché
//! hanno bisogno dei DDL privati per costruire un database "vecchio" vero.
//!
//! La proprietà difesa è una sola: **un DB nato a v1 e migrato deve essere
//! indistinguibile da un DB nato oggi**. Ogni deriva fra i due è un bug che
//! in produzione si manifesta mesi dopo, sul database di un utente.

use super::*;
use std::collections::BTreeSet;

/// Un database come lo avrebbe creato la prima versione dell'app.
fn v1_db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(DDL_V1).unwrap();
    c.execute(
        "INSERT INTO schema_version(version, applied_at) VALUES (1, datetime('now'))",
        [],
    )
    .unwrap();
    c
}

fn fresh_db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    ensure_schema(&c).unwrap();
    c
}

fn current_version(c: &Connection) -> i32 {
    c.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
        .unwrap()
}

/// Tabelle reali: fuori le interne di SQLite e le shadow di FTS5.
fn table_names(c: &Connection) -> BTreeSet<String> {
    let mut stmt = c
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%'",
        )
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn column_names(c: &Connection, table: &str) -> Vec<String> {
    let mut stmt = c.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn upgrade_from_v1_reaches_current_version() {
    let c = v1_db();
    ensure_schema(&c).unwrap();
    assert_eq!(current_version(&c), SCHEMA_VERSION);
}

#[test]
fn migrated_db_is_identical_to_fresh_db() {
    let migrated = v1_db();
    ensure_schema(&migrated).unwrap();
    let fresh = fresh_db();

    let tables = table_names(&fresh);
    assert_eq!(table_names(&migrated), tables, "insieme di tabelle diverso");

    for table in &tables {
        assert_eq!(
            column_names(&migrated, table),
            column_names(&fresh, table),
            "colonne divergenti nella tabella {table}"
        );
    }
}

#[test]
fn ensure_schema_is_idempotent() {
    let c = fresh_db();
    let before = table_names(&c);
    ensure_schema(&c).unwrap();
    ensure_schema(&c).unwrap();
    assert_eq!(current_version(&c), SCHEMA_VERSION);
    assert_eq!(table_names(&c), before);
}

#[test]
fn rerunning_on_current_version_touches_nothing() {
    let c = fresh_db();
    let before: i64 = c
        .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
        .unwrap();
    ensure_schema(&c).unwrap();
    let after: i64 = c
        .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after, "il no-op ha scritto sul tracking");
}

#[test]
fn legacy_vertical_tables_are_dropped_by_migration() {
    let c = v1_db();
    c.execute_batch("CREATE TABLE vp_elettrovalvole (id INTEGER PRIMARY KEY)")
        .unwrap();
    ensure_schema(&c).unwrap();
    assert!(
        !table_names(&c).contains("vp_elettrovalvole"),
        "la v8 deve rimuovere il catalogo verticale legacy"
    );
}

#[test]
fn v1_backfill_flows_into_sale_price() {
    // Un articolo creato prima della v3 aveva solo base_price: la migrazione
    // deve travasarlo in sale_price, non lasciarlo orfano.
    let c = v1_db();
    c.execute(
        "INSERT INTO articles (code, description, base_price, created_at, updated_at)
         VALUES ('EV-1', 'Valvola', 42.5, datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    ensure_schema(&c).unwrap();
    let sale: f64 = c
        .query_row(
            "SELECT sale_price FROM articles WHERE code = 'EV-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!((sale - 42.5).abs() < f64::EPSILON);
}
