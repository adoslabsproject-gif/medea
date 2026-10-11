//! La chiave con cui il motore cifra le credenziali nel suo database.
//!
//! Il motore non scrive mai una chiave API in chiaro: la cifra con una
//! password maestra, e in produzione **si rifiuta** di salvare se quella
//! password non c'è. Sul server gliela consegna chi lo ospita. Qui nessuno
//! gliela dava: ogni salvataggio di una credenziale rispondeva 400, e i nodi
//! AI dei workflow non potevano ricevere la chiave che l'utente aveva messo
//! in Impostazioni.
//!
//! La password nasce la prima volta, casuale, e resta nel portachiavi del
//! sistema: è l'unico posto dove un segreto di Medea può stare. Se cambiasse
//! a ogni avvio, quello che il motore ha cifrato ieri oggi non si aprirebbe.

use anyhow::{Context, Result};
use keyring::Entry;

const KEYCHAIN_SERVICE: &str = "Medea";
const KEYCHAIN_ACCOUNT: &str = "workflow-vault-master";

/// La variabile da cui il motore legge la password maestra.
///
/// Una variabile e non un file: il file sarebbe la password in chiaro su
/// disco, accanto al database che protegge.
pub const MASTER_ENV: &str = "MEDEA_MASTER_PASSWORD";

/// Quanti byte casuali: 32 sono 256 bit, la misura della chiave che ne deriva.
const MASTER_BYTES: usize = 32;

/// Una stringa esadecimale di `bytes` byte presi dal generatore del sistema.
fn random_hex(bytes: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).context("generatore casuale del sistema")?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}

/// La password maestra del motore, creandola la prima volta.
pub fn master_password() -> Result<String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).context("portachiavi di sistema")?;
    match entry.get_password() {
        Ok(existing) => Ok(existing),
        Err(_) => {
            let value = random_hex(MASTER_BYTES)?;
            entry
                .set_password(&value)
                .context("scrittura nel portachiavi")?;
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_password_ha_la_lunghezza_chiesta_ed_e_esadecimale() {
        let value = random_hex(MASTER_BYTES).expect("casualità del sistema");
        assert_eq!(value.len(), MASTER_BYTES * 2);
        assert!(value.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn due_password_non_sono_mai_uguali() {
        let a = random_hex(MASTER_BYTES).expect("casualità del sistema");
        let b = random_hex(MASTER_BYTES).expect("casualità del sistema");
        assert_ne!(a, b);
    }

    /// Il nome della variabile vive in due programmi diversi. Se il motore lo
    /// cambiasse, la password arriverebbe in una variabile che nessuno legge e
    /// ogni credenziale tornerebbe a essere rifiutata — in silenzio, fino al
    /// primo workflow con un nodo AI.
    #[test]
    fn il_motore_legge_proprio_questa_variabile() {
        let motore = include_str!("../../../../engine/src/lib/master-password.ts");
        assert!(
            motore.contains(&format!("process.env.{MASTER_ENV}")),
            "il motore non legge più {MASTER_ENV}"
        );
    }

    /// In produzione, senza password, il motore solleva un errore invece di
    /// cifrare con una chiave nota. È il comportamento che rende obbligatorio
    /// consegnargliela: se sparisse, questo modulo non servirebbe più e va
    /// riguardato.
    #[test]
    fn senza_password_il_motore_in_produzione_si_rifiuta() {
        let motore = include_str!("../../../../engine/src/lib/master-password.ts");
        assert!(motore.contains("process.env.NODE_ENV === 'production'"));
        assert!(motore.contains("Required in production"));
    }
}
