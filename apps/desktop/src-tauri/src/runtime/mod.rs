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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use serde::Serialize;

mod orphan;
pub mod session;
mod webhook;

/// Quanto si aspetta che il runtime risponda prima di dichiararlo non partito.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Il file dove il motore tiene workflow, esecuzioni e credenziali.
const DATABASE_FILE: &str = "medea.sqlite";

/// Come si chiamava fino alla 0.3.0, quando il motore portava ancora il nome
/// del progetto da cui deriva.
const LEGACY_DATABASE_FILE: &str = "flowforge.sqlite";

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
    /// Dove sta il biglietto col numero del processo, da togliere alla fine.
    data: PathBuf,
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        // Un runtime orfano continuerebbe a eseguire workflow con l'app
        // chiusa: si spegne insieme a lei.
        let _ = self.child.kill();
        let _ = self.child.wait();
        orphan::forget(&self.data);
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

/// La variabile con cui puntare a un runtime diverso da quello impacchettato.
/// Serve in sviluppo, dove il bundle si ricostruisce di continuo.
const RUNTIME_PATH_ENV: &str = "MEDEA_WORKFLOW_RUNTIME";

/// Dove sta il runtime.
///
/// Nell'app installata sta accanto alle risorse. In sviluppo lo si indica con
/// `MEDEA_WORKFLOW_RUNTIME`, **non** con un percorso scritto nel codice: un
/// percorso che esiste su una macchina sola è una bugia che funziona finché
/// non la si prova altrove.
fn bundle_entry(resource_dir: &Path) -> Result<PathBuf> {
    // Due cose insieme. `main.js` sta dentro `dist/` perché importa i suoi
    // fratelli con percorsi relativi, e spostarlo di una cartella li
    // spezzerebbe tutti. E Tauri conserva il percorso dichiarato in
    // `bundle.resources`, quindi la cartella arriva sotto `resources/` —
    // provato: in sviluppo finisce in `target/debug/resources/runtime`.
    for candidate in [
        "resources/runtime/dist/main.js",
        "runtime/dist/main.js",
        "runtime/main.js",
    ] {
        let packaged = resource_dir.join(candidate);
        if packaged.exists() {
            return Ok(packaged);
        }
    }

    if let Ok(custom) = std::env::var(RUNTIME_PATH_ENV) {
        let path = PathBuf::from(&custom);
        if path.exists() {
            return Ok(path);
        }
        anyhow::bail!("{RUNTIME_PATH_ENV} punta a «{custom}», che non esiste");
    }

    anyhow::bail!(
        "il motore dei workflow non è installato con questa copia di Medea. \
         In sviluppo, indica il bundle con {RUNTIME_PATH_ENV}=/percorso/a/flowforge-runtime/dist/main.js"
    )
}

/// L'eseguibile Node da usare. Nell'app installata sarà quello impacchettato;
/// in sviluppo quello di sistema.
fn node_binary(resource_dir: &Path) -> PathBuf {
    // Su Windows l'eseguibile si chiama `node.exe`: cercare solo `node`
    // significherebbe non trovarlo mai lì, ricadere su quello di sistema — che
    // su un computer qualunque non c'è — e avere un'app che non esegue niente
    // proprio dove l'abbiamo appena impacchettata.
    let names: [&str; 2] = if cfg!(windows) {
        ["resources/runtime/node.exe", "runtime/node.exe"]
    } else {
        ["resources/runtime/node", "runtime/node"]
    };
    for candidate in names {
        let bundled = resource_dir.join(candidate);
        if bundled.exists() {
            return bundled;
        }
    }
    // In sviluppo, senza pacchetto, si usa quello di sistema.
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
    let entry = bundle_entry(resource_dir)?;
    let node = node_binary(resource_dir);
    // Una porta stabile, così gli indirizzi dei webhook restano validi fra
    // un'apertura e l'altra dell'app.
    let port = webhook::choose_port()?;

    // I dati del runtime stanno accanto a quelli di Medea, non in una
    // cartella di sistema: disinstallare l'app deve portarsi via tutto.
    let runtime_data = data_dir.join("workflow-runtime");
    std::fs::create_dir_all(&runtime_data).context("cartella dati del runtime")?;

    // Un motore rimasto in piedi da una chiusura brusca terrebbe la sua porta
    // e continuerebbe a eseguire i workflow di un'app che non c'è più.
    orphan::kill_stale(&runtime_data);

    // Chi arriva da una versione precedente ha i workflow dentro un file che
    // portava il nome del motore di provenienza: va portato al nome nuovo,
    // altrimenti il motore ne creerebbe uno vuoto e la sua roba sparirebbe.
    rename_legacy_database(&runtime_data);

    // Se il portachiavi non risponde si parte lo stesso: i webhook non
    // funzioneranno, tutto il resto sì. Un motore che non parte per colpa di
    // una funzione che l'utente magari non usa sarebbe sproporzionato.
    let webhook_secret = webhook::secret().unwrap_or_else(|e| {
        tracing::warn!("Segreto dei webhook non disponibile: {e}");
        String::new()
    });

    tracing::info!("Avvio runtime workflow: {} (porta {port})", entry.display());

    // Quello che il motore ha da dire, scritto da qualche parte invece che
    // buttato.
    //
    // Prima `stdout` e `stderr` andavano entrambi in `Stdio::null()`: il motore
    // registrava diligentemente ogni richiesta, ogni URL e ogni errore, e
    // nessuno poteva leggerne una riga. Quando il 2026-08-05 la generazione ha
    // cominciato a fallire con «fetch failed», l'indirizzo che aveva provato lo
    // sapeva soltanto lui — e per ricostruirlo è servito andare a leggere la
    // configurazione di nginx sul server. Un processo che parla in una stanza
    // vuota costa più di quanto risparmi in disco.
    //
    // Se il file non si apre si riparte da capo con l'uscita scartata: senza
    // log il motore funziona lo stesso, e rifiutarsi di avviarlo per un file di
    // diagnostica sarebbe sproporzionato.
    let log_path = runtime_data.join("runtime.log");
    let (out, err) = match std::fs::File::create(&log_path) {
        Ok(file) => match file.try_clone() {
            Ok(copia) => {
                tracing::info!("Log del runtime: {}", log_path.display());
                (Stdio::from(file), Stdio::from(copia))
            }
            Err(e) => {
                tracing::warn!("Log del runtime non duplicabile ({e}): uscita scartata");
                (Stdio::null(), Stdio::null())
            }
        },
        Err(e) => {
            tracing::warn!("Log del runtime non apribile ({e}): uscita scartata");
            (Stdio::null(), Stdio::null())
        }
    };

    let child = Command::new(&node)
        .arg(&entry)
        .env("NODE_ENV", "production")
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("LOG_LEVEL", "info")
        .env("MEDEA_DATA_DIR", &runtime_data)
        .env("MEDEA_DB_PATH", runtime_data.join(DATABASE_FILE))
        // Nessun portale, nessuna licenza: qui non c'è un tenant remoto a cui
        // rispondere.
        .env("CORS_ORIGINS", "http://localhost:1420,tauri://localhost")
        // Da qui il motore deriva i token dei webhook e compone gli indirizzi
        // da mostrare. Senza il segreto risponderebbe «token non derivabile»,
        // e senza l'indirizzo darebbe un percorso senza sapere dove attaccarlo.
        .env("MEDEA_SSO_SECRET", &webhook_secret)
        // Un nodo «subworkflow» chiama il motore per far partire un altro
        // workflow, e senza queste due variabili chiamerebbe `127.0.0.1:3100`
        // — la porta di FlowForge sul server, dove qui non c'è niente — con
        // una richiesta che verrebbe comunque rifiutata perché non
        // autenticata. Il segreto è lo stesso dei webhook: è un canale interno
        // fra il motore e sé stesso, non esce dalla macchina.
        .env("MEDEA_RUNTIME_URL", format!("http://127.0.0.1:{port}"))
        .env("MEDEA_INTERNAL_TOKEN", &webhook_secret)
        .env("MEDEA_PUBLIC_BASE_URL", format!("http://127.0.0.1:{port}"))
        // Dove sta Liara. Senza, il motore usa il proprio default —
        // `http://172.17.0.1:3006/api/v1/llm`, l'host visto da dentro un
        // container Docker sul server — che qui non esiste: la connessione
        // resta appesa dieci secondi e muore con «fetch failed». È ciò che ha
        // tenuto fermo il wizard il 2026-08-05, mentre la stessa chiamata dal
        // desktop funzionava: il desktop l'indirizzo giusto ce l'aveva, il
        // motore no, e nessuno glielo diceva.
        .env(
            "MEDEA_LIARA_BASE_URL",
            crate::commands::ai_cmd::LIARA_BASE_URL,
        )
        // Dove sta la rubrica. Il motore gira sulla stessa macchina e con lo
        // stesso utente, quindi può leggerla direttamente invece di tenerne una
        // copia che comincerebbe subito a divergere. La apre in sola lettura.
        .env("MEDEA_APP_DB_PATH", data_dir.join("medea.db"))
        // `warn` teneva zitto proprio il livello che serve a capire dove va una
        // richiesta. Ora che l'uscita finisce in un file, `info` costa un file
        // che cresce piano e vale ogni riga.
        .stdout(out)
        .stderr(err)
        .spawn()
        .with_context(|| format!("impossibile avviare {}", node.display()))?;

    orphan::remember(&runtime_data, child.id());
    let mut process = RuntimeProcess {
        child,
        port,
        data: runtime_data.clone(),
    };

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

/// Riavvia il runtime, e restituisce lo stato risultante.
///
/// Serve per far riprendere la pianificazione: `SchedulerService` carica i
/// cron **una volta sola all'avvio** e non li ricarica quando un workflow
/// viene attivato. In produzione non si nota perché i cron li pianifica il
/// portal centrale; in self-hosted il portal non c'è, quindi attivare un
/// workflow non lo aggiungerebbe mai alla pianificazione.
///
/// Il runtime è nostro e riparte in circa un secondo: riavviarlo è un modo
/// legittimo di ricaricare, e non richiede di modificare FlowForge.
pub fn restart(resource_dir: &Path, data_dir: &Path) -> RuntimeStatus {
    stop();
    start(resource_dir, data_dir)
}

/// Porta il database dal nome vecchio a quello nuovo, una volta sola.
///
/// SQLite non tiene i dati in un file solo: accanto al database vivono il
/// journal (`-wal`) e la memoria condivisa (`-shm`). Spostare solo il primo
/// lascerebbe indietro le scritture non ancora consolidate, cioè l'ultima
/// sessione di lavoro dell'utente.
///
/// Se qualcosa non si lascia rinominare non si interrompe l'avvio: il motore
/// partirà sul database vecchio, che è comunque il comportamento di prima.
fn rename_legacy_database(runtime_data: &Path) {
    let legacy = runtime_data.join(LEGACY_DATABASE_FILE);
    let current = runtime_data.join(DATABASE_FILE);

    // Niente da portare, oppure il nuovo c'è già: in entrambi i casi il file
    // vecchio non va toccato — sovrascrivere sarebbe perdere dati.
    if !legacy.exists() || current.exists() {
        return;
    }

    for suffix in ["", "-wal", "-shm"] {
        let from = runtime_data.join(format!("{LEGACY_DATABASE_FILE}{suffix}"));
        if !from.exists() {
            continue;
        }
        let to = runtime_data.join(format!("{DATABASE_FILE}{suffix}"));
        if let Err(e) = std::fs::rename(&from, &to) {
            tracing::warn!("Database: {} non rinominato: {e}", from.display());
            return;
        }
    }

    tracing::info!(
        "Database portato da {LEGACY_DATABASE_FILE} a {DATABASE_FILE}: i workflow esistenti restano al loro posto"
    );
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
