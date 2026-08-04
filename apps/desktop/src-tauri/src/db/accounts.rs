//! Repository accounts: persiste un account email dopo il primo login OK.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
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

/// Scrive l'account e restituisce l'id con cui è **davvero** registrato.
///
/// Non sempre è quello passato. `email_address` è unica: se lo stesso
/// indirizzo viene riconfigurato — cosa che capita ogni volta che gli account
/// non si riescono a rileggere e l'utente li reinserisce — arriva con un id
/// nuovo, mentre nel database c'è già la riga vecchia. L'inserimento veniva
/// rifiutato, e siccome l'esito non lo guardava nessuno l'app proseguiva con
/// un id che nessuna riga aveva: la prima cartella salvata falliva con
/// «FOREIGN KEY constraint failed», e la posta non caricava più.
///
/// La riga esistente si aggiorna e si tiene il suo id, che è quello a cui
/// sono appese cartelle e messaggi già scaricati. Cancellarla e rifarla
/// significherebbe buttare la posta locale per un problema di anagrafica.
/// Chi chiama deve **adottare l'id restituito**.
pub fn upsert(conn: &Connection, a: &StoredAccount) -> Result<String> {
    let now = Utc::now().to_rfc3339();

    let esistente: Option<String> = conn
        .query_row(
            "SELECT id FROM accounts WHERE email_address = ?1 AND id <> ?2",
            params![a.email_address, a.id],
            |r| r.get(0),
        )
        .optional()?;

    if let Some(id_vero) = esistente {
        conn.execute(
            "UPDATE accounts SET
                display_name=?1, imap_host=?2, imap_port=?3, imap_username=?4,
                smtp_host=?5, smtp_port=?6, smtp_username=?7, smtp_implicit_tls=?8,
                updated_at=?9
             WHERE id=?10",
            params![
                a.display_name,
                a.imap_host,
                a.imap_port,
                a.imap_username,
                a.smtp_host,
                a.smtp_port,
                a.smtp_username,
                a.smtp_implicit_tls as i32,
                now,
                id_vero,
            ],
        )?;
        return Ok(id_vero);
    }

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
    Ok(a.id.clone())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::ensure_schema;

    fn mk() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_schema(&c).unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        c
    }

    fn acc(id: &str, email: &str) -> StoredAccount {
        StoredAccount {
            id: id.to_string(),
            display_name: "Prova".into(),
            email_address: email.to_string(),
            imap_host: "mail.esempio.it".into(),
            imap_port: 993,
            imap_username: "utente".into(),
            smtp_host: "smtp.esempio.it".into(),
            smtp_port: 587,
            smtp_username: "utente".into(),
            smtp_implicit_tls: false,
            last_full_sync: None,
        }
    }

    #[test]
    fn un_account_nuovo_tiene_il_suo_id() {
        let c = mk();
        assert_eq!(upsert(&c, &acc("acc-1", "info@zeli.it")).unwrap(), "acc-1");
    }

    #[test]
    fn lo_stesso_id_si_aggiorna_senza_duplicare() {
        let c = mk();
        upsert(&c, &acc("acc-1", "info@zeli.it")).unwrap();
        let mut modificato = acc("acc-1", "info@zeli.it");
        modificato.imap_host = "nuovo.esempio.it".into();
        assert_eq!(upsert(&c, &modificato).unwrap(), "acc-1");
        assert_eq!(list(&c).unwrap().len(), 1);
        assert_eq!(list(&c).unwrap()[0].imap_host, "nuovo.esempio.it");
    }

    #[test]
    fn lo_stesso_indirizzo_con_un_id_nuovo_riusa_la_riga_esistente() {
        // Il caso vero del 2026-08-04: gli account non si rileggevano, l'utente
        // li ha reinseriti, e la schermata di setup ha coniato un id nuovo per
        // un indirizzo che c'era già.
        let c = mk();
        upsert(&c, &acc("acc-vecchio", "info@zeli.it")).unwrap();
        let id = upsert(&c, &acc("acc-nuovo", "info@zeli.it")).unwrap();

        assert_eq!(
            id, "acc-vecchio",
            "l'id vero è quello a cui è appesa la posta"
        );
        assert_eq!(list(&c).unwrap().len(), 1, "nessuna riga in più");
    }

    #[test]
    fn riconfigurare_non_butta_via_la_posta_gia_scaricata() {
        // Cancellare e reinserire sarebbe stato più semplice da scrivere, e
        // avrebbe buttato cartelle e messaggi per un problema di anagrafica:
        // ON DELETE CASCADE non fa distinzioni.
        let c = mk();
        upsert(&c, &acc("acc-vecchio", "info@zeli.it")).unwrap();
        c.execute(
            "INSERT INTO folders (account_id, path, name, folder_type)
             VALUES ('acc-vecchio', 'INBOX', 'INBOX', 'inbox')",
            [],
        )
        .unwrap();

        let mut riconfigurato = acc("acc-nuovo", "info@zeli.it");
        riconfigurato.imap_host = "mail.orion.it".into();
        let id = upsert(&c, &riconfigurato).unwrap();

        let cartelle: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM folders WHERE account_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cartelle, 1, "la cartella era già lì e deve restarci");
        assert_eq!(list(&c).unwrap()[0].imap_host, "mail.orion.it");
    }

    #[test]
    fn con_l_id_adottato_le_cartelle_si_salvano() {
        // Il guasto vero era qui: si proseguiva con l'id inventato e la prima
        // cartella falliva con «FOREIGN KEY constraint failed».
        let c = mk();
        upsert(&c, &acc("acc-vecchio", "info@zeli.it")).unwrap();
        let id = upsert(&c, &acc("acc-nuovo", "info@zeli.it")).unwrap();

        let esito = c.execute(
            "INSERT INTO folders (account_id, path, name, folder_type)
             VALUES (?1, 'Sent', 'Sent', 'sent')",
            params![id],
        );
        assert!(
            esito.is_ok(),
            "con l'id adottato la cartella entra: {esito:?}"
        );

        let orfana = c.execute(
            "INSERT INTO folders (account_id, path, name, folder_type)
             VALUES ('acc-nuovo', 'Drafts', 'Drafts', 'drafts')",
            [],
        );
        assert!(
            orfana.is_err(),
            "con l'id inventato deve fallire, ed è quello che succedeva"
        );
    }

    #[test]
    fn due_indirizzi_diversi_restano_due_account() {
        let c = mk();
        upsert(&c, &acc("acc-1", "info@zeli.it")).unwrap();
        upsert(&c, &acc("acc-2", "altro@zeli.it")).unwrap();
        assert_eq!(list(&c).unwrap().len(), 2);
    }
}
