//! Il runtime dei workflow, avviato come processo figlio.
//!
//! È **lo stesso runtime che gira sul server**: stesso codice, stessi 145
//! nodi, stessa sandbox. Non una reimplementazione — reimplementare 145
//! esecutori significherebbe inseguire per sempre, e un workflow che funziona
//! là dovrebbe funzionare qui senza distinguo.
//!
//! Vive dentro Medea: porta effimera su `127.0.0.1`, database SQLite nella
//! cartella dati dell'applicazione, e muore quando muore l'app. Non è un
//! servizio da amministrare: è un dettaglio di come Medea esegue.

use anyhow::{Context, Result};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use serde::Serialize;

pub mod session;

/// Quanto si aspetta che il runtime risponda prima di dichiararlo non partito.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Lo stato del processo figlio, per la UI.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// L'indirizzo a cui parlare, quando è vivo.
    pub base_url: Option<String>,
    /// Perché non è partito, quando non è partito.
    pub error: Option<String>,
}

struct RuntimeProcess {
    child: Child,
    port: u16,
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        // Un runtime orfano continuerebbe a eseguire workflow con l'app
        // chiusa: si spegne insieme a lei.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static PROCESS: OnceCell<Mutex<Option<RuntimeProcess>>> = OnceCell::new();
static LAST_ERROR: OnceCell<Mutex<Option<String>>> = OnceCell::new();

fn slot() -> &'static Mutex<Option<RuntimeProcess>> {
    PROCESS.get_or_init(|| Mutex::new(None))
}

fn last_error() -> &'static Mutex<Option<String>> {
    LAST_ERROR.get_or_init(|| Mutex::new(None))
}

/// Una porta libera scelta dal sistema: due Medea aperte non devono
/// litigare, e una porta fissa prima o poi è occupata da qualcun altro.
fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("nessuna porta libera")?;
    Ok(listener.local_addr()?.port())
}

/// Dove sta il runtime impacchettato.
///
/// In sviluppo si usa quello del repository di FlowForge, così non serve
/// ricostruire il pacchetto a ogni modifica; nell'app installata sta accanto
/// alle risorse.
fn bundle_entry(resource_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        resource_dir.join("runtime/main.js"),
        // Sviluppo: il bundle prodotto da `tsup` nel repository FlowForge.
        PathBuf::from("/Users/zelistore/zeliAI/apps/flowforge-runtime/dist/main.js"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// L'eseguibile Node da usare. Nell'app installata sarà quello impacchettato;
/// in sviluppo quello di sistema.
fn node_binary(resource_dir: &Path) -> PathBuf {
    let bundled = resource_dir.join("runtime/node");
    if bundled.exists() {
        return bundled;
    }
    PathBuf::from("node")
}

fn is_healthy(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    matches!(
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(800))
            .build()
            .and_then(|c| c.get(&url).send()),
        Ok(r) if r.status().is_success()
    )
}

/// Avvia il runtime, se non è già in piedi. Restituisce lo stato risultante.
pub fn start(resource_dir: &Path, data_dir: &Path) -> RuntimeStatus {
    {
        let guard = slot().lock().expect("runtime slot avvelenato");
        if let Some(p) = guard.as_ref() {
            if is_healthy(p.port) {
                return running(p.port);
            }
        }
    }

    match spawn(resource_dir, data_dir) {
        Ok(port) => {
            *last_error().lock().expect("errore avvelenato") = None;
            running(port)
        }
        Err(e) => {
            let message = e.to_string();
            tracing::warn!("Runtime workflow non avviato: {message}");
            *last_error().lock().expect("errore avvelenato") = Some(message.clone());
            RuntimeStatus {
                running: false,
                port: None,
                base_url: None,
                error: Some(message),
            }
        }
    }
}

fn running(port: u16) -> RuntimeStatus {
    RuntimeStatus {
        running: true,
        port: Some(port),
        base_url: Some(format!("http://127.0.0.1:{port}")),
        error: None,
    }
}

fn spawn(resource_dir: &Path, data_dir: &Path) -> Result<u16> {
    let entry = bundle_entry(resource_dir)
        .context("il runtime dei workflow non è installato con questa copia di Medea")?;
    let node = node_binary(resource_dir);
    let port = free_port()?;

    // I dati del runtime stanno accanto a quelli di Medea, non in una
    // cartella di sistema: disinstallare l'app deve portarsi via tutto.
    let runtime_data = data_dir.join("workflow-runtime");
    std::fs::create_dir_all(&runtime_data).context("cartella dati del runtime")?;

    tracing::info!("Avvio runtime workflow: {} (porta {port})", entry.display());

    let child = Command::new(&node)
        .arg(&entry)
        .env("NODE_ENV", "production")
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("LOG_LEVEL", "warn")
        .env("FLOWFORGE_DATA_DIR", &runtime_data)
        .env("FLOWFORGE_DB_PATH", runtime_data.join("flowforge.sqlite"))
        // Nessun portale, nessuna licenza: qui non c'è un tenant remoto a cui
        // rispondere.
        .env("CORS_ORIGINS", "http://localhost:1420,tauri://localhost")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("impossibile avviare {}", node.display()))?;

    let mut process = RuntimeProcess { child, port };

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if is_healthy(port) {
            *slot().lock().expect("runtime slot avvelenato") = Some(process);
            tracing::info!("Runtime workflow pronto sulla porta {port}");
            return Ok(port);
        }
        // Se è già morto, aspettare il timeout non serve a niente.
        if let Ok(Some(status)) = process.child.try_wait() {
            anyhow::bail!("il runtime si è chiuso subito ({status})");
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    anyhow::bail!("il runtime non ha risposto entro {STARTUP_TIMEOUT:?}")
}

/// Ferma il runtime. Idempotente.
pub fn stop() {
    *slot().lock().expect("runtime slot avvelenato") = None;
}

pub fn status() -> RuntimeStatus {
    let guard = slot().lock().expect("runtime slot avvelenato");
    match guard.as_ref() {
        Some(p) if is_healthy(p.port) => running(p.port),
        _ => RuntimeStatus {
            running: false,
            port: None,
            base_url: None,
            error: last_error().lock().expect("errore avvelenato").clone(),
        },
    }
}
