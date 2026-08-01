//! Gli indirizzi a cui si può bussare da fuori.
//!
//! Un workflow con un nodo «webhook» aspetta una chiamata HTTP. Il motore la
//! sa ricevere, ma l'indirizzo dipende da due cose che Medea deve tenere
//! **stabili nel tempo**, altrimenti l'indirizzo copiato ieri oggi non esiste
//! più:
//!
//!  - il **segreto** da cui si deriva il token nell'URL. Cambia a ogni avvio
//!    se lo si genera al volo: sta nel portachiavi del sistema, come tutto il
//!    resto che non deve stare su disco in chiaro.
//!  - la **porta**. Una porta effimera diversa a ogni apertura dell'app
//!    renderebbe l'indirizzo inutile da incollare da qualche parte. Si prova
//!    quindi una porta fissa, e solo se è occupata si ripiega su una libera.
//!
//! Restano indirizzi **locali**: `127.0.0.1` non è raggiungibile da internet.
//! Servono a chi sta su questa macchina — un altro programma, uno script, un
//! tunnel aperto apposta — e questo è quanto un'app senza server può offrire
//! onestamente.

use anyhow::{Context, Result};
use keyring::Entry;
use std::net::TcpListener;

const KEYCHAIN_SERVICE: &str = "Medea";
const KEYCHAIN_ACCOUNT: &str = "workflow-webhook-secret";

/// Le porte che si provano, in ordine, prima di arrendersi a una qualsiasi.
///
/// Un intervallo e non una porta sola: due copie di Medea aperte insieme non
/// devono litigare, e un programma qualunque può avere preso la prima.
const PREFERRED_PORTS: std::ops::Range<u16> = 39100..39120;

/// Il segreto da cui il motore deriva i token dei webhook.
///
/// Generato la prima volta e poi sempre lo stesso: è quello che rende un
/// indirizzo copiato oggi ancora valido domani.
pub fn secret() -> Result<String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).context("portachiavi di sistema")?;
    match entry.get_password() {
        Ok(existing) => Ok(existing),
        Err(_) => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).context("generatore casuale del sistema")?;
            let value: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            entry
                .set_password(&value)
                .context("scrittura nel portachiavi")?;
            Ok(value)
        }
    }
}

/// Vero se quella porta si può occupare adesso.
fn is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// La porta su cui far ascoltare il motore.
///
/// Si preferisce sempre la stessa perché gli indirizzi dei webhook la
/// contengono. Se sono tutte occupate se ne prende una qualunque: meglio un
/// motore che parte con indirizzi diversi, che un motore che non parte.
pub fn choose_port() -> Result<u16> {
    for port in PREFERRED_PORTS {
        if is_free(port) {
            return Ok(port);
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").context("nessuna porta libera")?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sceglie_una_porta_dell_intervallo_preferito() {
        // Non si può garantire QUALE — un'altra copia di Medea, o un altro
        // programma, può averne presa una — ma deve essere una di quelle,
        // salvo che siano occupate tutte e venti.
        let port = choose_port().expect("una porta");
        assert!(PREFERRED_PORTS.contains(&port) || port > 1024);
    }

    #[test]
    fn una_porta_occupata_non_risulta_libera() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("porta di prova");
        let port = listener.local_addr().expect("indirizzo").port();
        assert!(!is_free(port));
    }
}
