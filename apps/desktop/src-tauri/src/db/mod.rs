//! Database locale di Medea (SQLite + FTS5).
//!
//! Singletone in-process: `DB::global()` ritorna una connessione condivisa
//! protetta da `parking_lot::Mutex`. SQLite supporta concorrenza con WAL e
//! noi serializziamo lato app per semplicità + zero overhead.
//!
//! Schema in `schema.rs`. Repository per dominio in `accounts.rs`,
//! `messages.rs`, `contacts.rs`.

pub mod accounts;
pub mod anag;
pub mod contacts;
pub mod crud;
pub mod messages;
pub mod notes;
pub mod pricing;
pub mod reminders;
pub mod rubrica;
pub mod schema;
pub mod settings;
pub mod studio;
pub mod templates;
pub mod workflow_runs;
pub mod workflows;

use anyhow::{Context, Result};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;

static DB: OnceCell<Mutex<Connection>> = OnceCell::new();

/// Inizializza il DB nella cartella applicazione fornita da Tauri.
/// Da chiamare una volta sola al boot (setup hook).
pub fn init(app_data_dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&app_data_dir).context("creating app data dir")?;
    let db_path = app_data_dir.join("medea.db");
    tracing::info!("DB path: {}", db_path.display());

    let conn = Connection::open(&db_path).context("opening sqlite db")?;

    // PRAGMA per performance e correttezza enterprise.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA mmap_size = 268435456;
         PRAGMA cache_size = -16384;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
    .context("applying pragmas")?;

    schema::ensure_schema(&conn).context("applying schema")?;

    DB.set(Mutex::new(conn))
        .map_err(|_| anyhow::anyhow!("DB already initialized"))?;
    Ok(())
}

/// Accesso al DB. Lock breve, niente await mentre tenuto.
pub fn with_db<R>(f: impl FnOnce(&mut Connection) -> Result<R>) -> Result<R> {
    let mtx = DB
        .get()
        .ok_or_else(|| anyhow::anyhow!("DB non inizializzato"))?;
    let mut conn = mtx.lock();
    f(&mut conn)
}
