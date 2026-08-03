//! Le query che servono alla rubrica per guardare la posta ricevuta.
//!
//! Sono deliberatamente diverse da quelle della sezione Posta. Lì si guarda
//! una cartella; qui si guarda **chi ha scritto**, e la domanda è un'altra:
//! quali indirizzi di questo dominio mi hanno mandato qualcosa, e cosa.
//!
//! Tre esclusioni valgono per tutte:
//!
//! - **quello che si è cancellato** (`is_local_deleted`), perché una rubrica
//!   che continua a mostrare ciò che si è buttato è una rubrica che non si
//!   può pulire;
//! - **il cestino e lo spam**, per lo stesso motivo, dal lato del server;
//! - **le bozze e la posta inviata**, perché la domanda è «cosa mi hanno
//!   scritto», non «cosa ho scritto io».

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// Un indirizzo che ha scritto, con quanto e quando.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MittenteRicevuto {
    pub address: String,
    /// Il nome con cui si è presentato l'ultima volta, se ne aveva uno.
    pub name: Option<String>,
    pub messages: i64,
    /// Quando è arrivata l'ultima, in ISO 8601.
    pub last_at: Option<String>,
}

/// Una email ricevuta, nella forma che serve all'elenco della rubrica.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailRicevuta {
    pub id: i64,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub internal_date: Option<String>,
    pub preview: Option<String>,
    pub has_attachments: bool,
    pub is_seen: bool,
}

/// La condizione che tiene fuori ciò che non è posta ricevuta viva.
const SOLO_RICEVUTE_VIVE: &str = "
    m.is_local_deleted = 0
    AND m.is_draft = 0
    AND (f.folder_type IS NULL OR f.folder_type NOT IN ('trash', 'spam', 'sent', 'drafts'))
";

/// Gli indirizzi di un dominio che hanno scritto almeno una volta.
///
/// Il confronto è sulla coda dell'indirizzo dopo la chiocciola, così
/// `mario@acme.it` e `info@acme.it` stanno insieme sotto `acme.it`.
pub fn mittenti_del_dominio(conn: &Connection, dominio: &str) -> Result<Vec<MittenteRicevuto>> {
    let coda = format!("%@{}", dominio.trim().trim_start_matches('@').to_lowercase());
    let sql = format!(
        "SELECT LOWER(m.from_address)                AS indirizzo,
                MAX(m.from_name)                     AS nome,
                COUNT(*)                             AS quante,
                MAX(m.internal_date)                 AS ultima
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE {SOLO_RICEVUTE_VIVE}
            AND m.from_address IS NOT NULL
            AND LOWER(m.from_address) LIKE ?1
          GROUP BY indirizzo
          ORDER BY ultima DESC"
    );

    let mut stmt = conn.prepare(&sql)?;
    let righe = stmt.query_map(params![coda], |r| {
        Ok(MittenteRicevuto {
            address: r.get(0)?,
            name: r.get(1)?,
            messages: r.get(2)?,
            last_at: r.get(3)?,
        })
    })?;
    Ok(righe.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Le email ricevute da un indirizzo, dalla più recente.
pub fn ricevute_da(conn: &Connection, indirizzo: &str, limite: u32) -> Result<Vec<EmailRicevuta>> {
    let sql = format!(
        "SELECT m.id, m.subject, m.from_name, m.from_address, m.internal_date,
                m.preview, m.has_attachments, m.is_seen
           FROM messages m
           LEFT JOIN folders f ON f.id = m.primary_folder_id
          WHERE {SOLO_RICEVUTE_VIVE}
            AND LOWER(m.from_address) = LOWER(?1)
          ORDER BY m.internal_date DESC, m.uid DESC
          LIMIT ?2"
    );

    let mut stmt = conn.prepare(&sql)?;
    let righe = stmt.query_map(params![indirizzo, limite], |r| {
        Ok(EmailRicevuta {
            id: r.get(0)?,
            subject: r.get(1)?,
            from_name: r.get(2)?,
            from_address: r.get(3)?,
            internal_date: r.get(4)?,
            preview: r.get(5)?,
            has_attachments: r.get::<_, i64>(6)? != 0,
            is_seen: r.get::<_, i64>(7)? != 0,
        })
    })?;
    Ok(righe.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// I domini da cui è arrivata posta, con quanti indirizzi e quanti messaggi.
///
/// Serve alla scheda delle aziende: l'elenco dei domini che hanno scritto
/// davvero, non quello delle anagrafiche registrate a mano.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DominioRicevuto {
    pub domain: String,
    pub addresses: i64,
    pub messages: i64,
    pub last_at: Option<String>,
}

pub fn domini_ricevuti(conn: &Connection, limite: u32) -> Result<Vec<DominioRicevuto>> {
    let sql = format!(
        "SELECT dominio, COUNT(DISTINCT indirizzo) AS indirizzi,
                SUM(quante) AS messaggi, MAX(ultima) AS ultima
           FROM (
             SELECT LOWER(SUBSTR(m.from_address, INSTR(m.from_address, '@') + 1)) AS dominio,
                    LOWER(m.from_address)  AS indirizzo,
                    COUNT(*)               AS quante,
                    MAX(m.internal_date)   AS ultima
               FROM messages m
               LEFT JOIN folders f ON f.id = m.primary_folder_id
              WHERE {SOLO_RICEVUTE_VIVE}
                AND m.from_address IS NOT NULL
                AND INSTR(m.from_address, '@') > 0
              GROUP BY indirizzo
           )
          GROUP BY dominio
          ORDER BY ultima DESC
          LIMIT ?1"
    );

    let mut stmt = conn.prepare(&sql)?;
    let righe = stmt.query_map(params![limite], |r| {
        Ok(DominioRicevuto {
            domain: r.get(0)?,
            addresses: r.get(1)?,
            messages: r.get(2)?,
            last_at: r.get(3)?,
        })
    })?;
    Ok(righe.collect::<rusqlite::Result<Vec<_>>>()?)
}
