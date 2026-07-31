//! Repository accounts: persiste un account email dopo il primo login OK.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_implicit_tls: bool,
    pub last_full_sync: Option<String>,
}

pub fn upsert(conn: &Connection, a: &StoredAccount) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO accounts (
            id, display_name, email_address,
            imap_host, imap_port, imap_username,
            smtp_host, smtp_port, smtp_username, smtp_implicit_tls,
            last_full_sync, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
            display_name=excluded.display_name,
            email_address=excluded.email_address,
            imap_host=excluded.imap_host,
            imap_port=excluded.imap_port,
            imap_username=excluded.imap_username,
            smtp_host=excluded.smtp_host,
            smtp_port=excluded.smtp_port,
            smtp_username=excluded.smtp_username,
            smtp_implicit_tls=excluded.smtp_implicit_tls,
            updated_at=excluded.updated_at",
        params![
            a.id,
            a.display_name,
            a.email_address,
            a.imap_host,
            a.imap_port,
            a.imap_username,
            a.smtp_host,
            a.smtp_port,
            a.smtp_username,
            a.smtp_implicit_tls as i32,
            a.last_full_sync,
            now,
            now,
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<StoredAccount>> {
    let mut stmt = conn.prepare(
        "SELECT id, display_name, email_address,
                imap_host, imap_port, imap_username,
                smtp_host, smtp_port, smtp_username, smtp_implicit_tls,
                last_full_sync
           FROM accounts ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StoredAccount {
                id: r.get(0)?,
                display_name: r.get(1)?,
                email_address: r.get(2)?,
                imap_host: r.get(3)?,
                imap_port: r.get::<_, i64>(4)? as u16,
                imap_username: r.get(5)?,
                smtp_host: r.get(6)?,
                smtp_port: r.get::<_, i64>(7)? as u16,
                smtp_username: r.get(8)?,
                smtp_implicit_tls: r.get::<_, i64>(9)? != 0,
                last_full_sync: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn set_last_full_sync(conn: &Connection, account_id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET last_full_sync = ?1, updated_at = ?2 WHERE id = ?3",
        params![ts, Utc::now().to_rfc3339(), account_id],
    )?;
    Ok(())
}
