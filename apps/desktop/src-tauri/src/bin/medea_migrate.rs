//! Applica le migrazioni schema al DB Medea (in caso l'app sia chiusa).
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let dir = std::path::PathBuf::from(home)
        .join("Library/Application Support/com.adoslabs.medea");
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("medea.db");
    println!("→ DB: {}", db_path.display());
    let conn = rusqlite::Connection::open(&db_path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    medea_desktop_lib::db::schema::ensure_schema(&conn)?;
    println!("✓ schema aggiornato");
    Ok(())
}
