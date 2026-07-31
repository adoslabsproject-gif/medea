//! L'utente locale del runtime, provvisto in automatico.
//!
//! Il runtime nasce multi-tenant e pretende un'identità: senza, ogni chiamata
//! risponde 401. Ma qui non c'è nessuno a cui registrarsi — Medea gira sul
//! computer dell'utente, e chiedergli di inventarsi una password per parlare
//! con un processo figlio sarebbe assurdo.
//!
//! Quindi l'identità **si autoprovvede**: al primo avvio Medea registra un
//! proprietario con una password casuale lunga, la mette nel portachiavi di
//! sistema, e da lì in poi la usa in silenzio. La password non compare mai a
//! schermo perché non serve a nessuno: serve al programma per parlare con sé
//! stesso.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::time::Duration;

use keyring::Entry;

/// Il servizio con cui Medea registra i propri segreti nel portachiavi: lo
/// stesso delle chiavi API e delle credenziali di posta.
const KEYCHAIN_SERVICE: &str = "Medea";
/// Il nome con cui la password del runtime sta nel portachiavi.
const KEYCHAIN_ACCOUNT: &str = "workflow-runtime";
/// L'indirizzo dell'utente locale: non è una email vera e non deve esserlo.
const LOCAL_EMAIL: &str = "medea@localhost.local";
const LOCAL_NAME: &str = "Medea";

#[derive(Deserialize)]
struct LoginResponse {
    token: String,
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("client HTTP")
}

/// Una password che nessuno dovrà mai digitare, quindi lunga e casuale.
///
/// La casualità viene dal sistema operativo tramite `getrandom`, che è quello
/// che sta sotto a qualunque generatore serio: 48 byte, scritti in
/// esadecimale.
fn random_password() -> Result<String> {
    let mut bytes = [0u8; 48];
    getrandom::fill(&mut bytes).context("generatore casuale del sistema")?;
    let body: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // Il runtime pretende almeno una maiuscola, una cifra e un simbolo.
    Ok(format!("M{body}9!"))
}

fn entry() -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).context("portachiavi di sistema")
}

/// La password dell'utente locale, creandola la prima volta.
fn ensure_password() -> Result<String> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(existing) => Ok(existing),
        Err(_) => {
            let password = random_password()?;
            entry
                .set_password(&password)
                .context("scrittura nel portachiavi")?;
            Ok(password)
        }
    }
}

/// Registra l'utente locale. Se esiste già, va bene così: è la condizione
/// normale a ogni avvio successivo al primo.
fn register(base_url: &str, password: &str) -> Result<()> {
    let response = client()?
        .post(format!("{base_url}/api/v1/auth/register"))
        .json(&serde_json::json!({
            "email": LOCAL_EMAIL,
            "password": password,
            "displayName": LOCAL_NAME,
        }))
        .send()
        .context("registrazione dell'utente locale")?;

    if response.status().is_success() {
        tracing::info!("Utente locale del runtime creato");
    }
    Ok(())
}

fn login(base_url: &str, password: &str) -> Result<String> {
    let response = client()?
        .post(format!("{base_url}/api/v1/auth/login"))
        .json(&serde_json::json!({ "email": LOCAL_EMAIL, "password": password }))
        .send()
        .context("accesso al runtime locale")?;

    if !response.status().is_success() {
        anyhow::bail!("il runtime ha rifiutato l'accesso ({})", response.status());
    }
    Ok(response
        .json::<LoginResponse>()
        .context("risposta di accesso illeggibile")?
        .token)
}

/// Il token con cui parlare al runtime. Registra l'utente se serve, accede, e
/// restituisce la sessione.
///
/// Non si conserva il token: dura poche ore e riprenderlo costa una chiamata
/// locale. Conservare qualcosa che scade significa doversi ricordare di
/// buttarlo.
pub fn authenticate(base_url: &str) -> Result<String> {
    let password = ensure_password()?;

    match login(base_url, &password) {
        Ok(token) => Ok(token),
        Err(_) => {
            // Primo avvio, oppure il database del runtime è stato cancellato
            // mentre la password è rimasta: si registra e si riprova.
            register(base_url, &password)?;
            login(base_url, &password)
        }
    }
}

/// Dimentica le credenziali locali: serve quando il database del runtime
/// viene azzerato e la password salvata non corrisponde più a niente.
pub fn forget() -> Result<()> {
    // Una password che non c'è è esattamente il risultato voluto.
    let _ = entry()?.delete_credential();
    Ok(())
}
