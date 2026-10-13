//! Un turno con la CLI, dall'avvio alla risposta, raccontato mentre accade.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::OnceCell;
use serde_json::Value;

use super::args::{self, Turno};
use super::events::{ClaudeCliTurn, Collettore};
use super::locate::{self, Ambiente};
use super::protocol::{self, Evento, Traduttore};
use super::workdir::{cartella_lavoro, FileDelTurno};

/// Dove stanno le cose di Medea che servono alla CLI.
pub struct Luoghi<'a> {
    /// La cartella dati dell'app: lì sta il database, e lì lavora la CLI
    /// quando l'utente non ha scelto una cartella sua.
    pub data_dir: &'a Path,
    /// Il binario del server MCP con i tool di Medea.
    pub mcp_bin: &'a Path,
}

/// Cosa si chiede alla CLI.
pub struct Richiesta<'a> {
    /// Il nome del turno: serve a rispondergli e a fermarlo mentre gira.
    pub turn_id: &'a str,
    pub prompt: &'a str,
    pub system_prompt: Option<&'a str>,
    pub model: Option<&'a str>,
    /// La sessione da riprendere, se la conversazione è già cominciata.
    pub resume: Option<&'a str>,
    /// La cartella scelta dall'utente. Da lì dipende cosa la CLI può leggere
    /// e modificare.
    pub cwd: Option<&'a Path>,
    /// Se la CLI può usare i tool di Medea.
    pub allow_tools: bool,
}

/// Un turno in corso: quello che serve per parlargli e per fermarlo.
struct TurnoVivo {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    fermato: Arc<AtomicBool>,
}

static TURNI: OnceCell<Mutex<HashMap<String, TurnoVivo>>> = OnceCell::new();

fn turni() -> std::sync::MutexGuard<'static, HashMap<String, TurnoVivo>> {
    TURNI
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn scrivi(stdin: &Mutex<ChildStdin>, riga: &str) -> std::io::Result<()> {
    let mut stdin = stdin
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    stdin.write_all(riga.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

/// Risponde a una richiesta di permesso di un turno in corso.
pub fn rispondi_permesso(
    turn_id: &str,
    request_id: &str,
    consenti: bool,
    input: &Value,
) -> Result<(), String> {
    let stdin = turni()
        .get(turn_id)
        .map(|t| Arc::clone(&t.stdin))
        .ok_or_else(|| "Il turno è già finito.".to_string())?;
    scrivi(
        &stdin,
        &protocol::risposta_permesso(request_id, consenti, input),
    )
    .map_err(|e| format!("La CLI non ascolta più: {e}"))
}

/// Ferma un turno in corso. Restituisce `false` se era già finito.
pub fn ferma(turn_id: &str) -> bool {
    let Some((child, fermato)) = turni()
        .get(turn_id)
        .map(|t| (Arc::clone(&t.child), Arc::clone(&t.fermato)))
    else {
        return false;
    };
    fermato.store(true, Ordering::SeqCst);
    let _ = child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .kill();
    true
}

/// Gli ultimi caratteri di un testo: di un errore lungo conta la fine.
fn coda(testo: &str, caratteri: usize) -> String {
    let inizio = testo.chars().count().saturating_sub(caratteri);
    testo.chars().skip(inizio).collect()
}

/// La cartella in cui far lavorare la CLI.
fn cartella(luoghi: &Luoghi<'_>, scelta: Option<&Path>) -> Result<PathBuf, String> {
    match scelta {
        Some(dir) if dir.is_dir() => Ok(dir.to_path_buf()),
        Some(dir) => Err(format!(
            "La cartella di lavoro «{}» non esiste più: scegline un'altra.",
            dir.display()
        )),
        // Una cartella vuota e privata: senza una scelta dell'utente la CLI
        // non deve trovarsi davanti i suoi file.
        None => cartella_lavoro(luoghi.data_dir)
            .map_err(|e| format!("Cartella di lavoro della CLI non creabile: {e}")),
    }
}

/// Esegue il turno. `invia` riceve gli eventi man mano; il valore di ritorno
/// è il turno intero, o una frase per l'utente.
pub fn esegui(
    luoghi: &Luoghi<'_>,
    richiesta: &Richiesta<'_>,
    mut invia: impl FnMut(Evento),
) -> Result<ClaudeCliTurn, String> {
    let bin = locate::locate()
        .ok_or_else(|| "CLI `claude` non trovata. Installala e fai `claude login`.".to_string())?;
    let privata = cartella_lavoro(luoghi.data_dir)
        .map_err(|e| format!("Cartella di lavoro della CLI non creabile: {e}"))?;
    let dove = cartella(luoghi, richiesta.cwd)?;

    let sistema = match richiesta.system_prompt.filter(|s| !s.trim().is_empty()) {
        Some(testo) => Some(
            FileDelTurno::scrivi(&privata, testo)
                .map_err(|e| format!("Istruzioni di Medea non scrivibili: {e}"))?,
        ),
        None => None,
    };
    let mcp_config = if richiesta.allow_tools {
        let path = privata.join("mcp-config.json");
        let config = args::mcp_config(luoghi.mcp_bin, luoghi.data_dir);
        match std::fs::write(&path, config.to_string()) {
            Ok(()) => Some(path),
            Err(e) => {
                tracing::warn!("config MCP non scritta, proseguo senza tool Medea: {e}");
                None
            }
        }
    } else {
        None
    };

    let mut child = Command::new(&bin)
        .args(args::build(&Turno {
            system_prompt_file: sistema.as_ref().map(FileDelTurno::path),
            model: richiesta.model,
            mcp_config: mcp_config.as_deref(),
            resume: richiesta.resume,
        }))
        .current_dir(&dove)
        .env("PATH", Ambiente::corrente().path_esteso())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Avvio CLI fallito: {e}"))?;

    let (Some(stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Err("La CLI è partita senza i suoi canali.".to_string());
    };
    let stdin = Arc::new(Mutex::new(stdin));
    let child = Arc::new(Mutex::new(child));
    let fermato = Arc::new(AtomicBool::new(false));
    turni().insert(
        richiesta.turn_id.to_string(),
        TurnoVivo {
            stdin: Arc::clone(&stdin),
            child: Arc::clone(&child),
            fermato: Arc::clone(&fermato),
        },
    );

    // Gli errori si leggono da un altro filo: se la CLI ne scrivesse tanti
    // mentre nessuno li legge, si fermerebbe ad aspettare.
    let errori = std::thread::spawn(move || {
        let mut testo = String::new();
        let _ = stderr.read_to_string(&mut testo);
        testo
    });

    let mut collettore = Collettore::default();
    let mut traduttore = Traduttore::default();
    let scritto = scrivi(&stdin, &protocol::messaggio_utente(richiesta.prompt));
    if scritto.is_ok() {
        for riga in BufReader::new(stdout).lines() {
            let Ok(riga) = riga else { break };
            let Ok(evento) = serde_json::from_str::<Value>(riga.trim()) else {
                continue;
            };
            collettore.evento(&evento);
            // Una domanda che non sappiamo fare all'utente va comunque
            // chiusa: la CLI resterebbe ferma ad aspettarla.
            if evento["type"] == "control_request" && evento["request"]["subtype"] != "can_use_tool"
            {
                let id = evento["request_id"].as_str().unwrap_or_default();
                let _ = scrivi(&stdin, &protocol::risposta_non_gestita(id));
            }
            for e in traduttore.traduci(&evento) {
                invia(e);
            }
            if collettore.finito() {
                break;
            }
        }
    }

    // Tolto dal registro e chiuso l'ingresso, la CLI esce da sola.
    turni().remove(richiesta.turn_id);
    drop(stdin);
    let _ = child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .wait();
    let errori = errori.join().unwrap_or_default();

    if fermato.load(Ordering::SeqCst) {
        return Err("Interrotto.".to_string());
    }
    if let Err(e) = scritto {
        return Err(format!("La CLI non ha accettato il messaggio: {e}"));
    }
    let finito = collettore.finito();
    collettore
        .fine()
        .map_err(|e| errore_del_turno(&e, finito, &errori))
}

/// L'errore da mostrare, con quello che la CLI ha scritto fra gli errori.
///
/// Certi fallimenti la CLI li spiega solo lì: una sessione da riprendere che
/// non esiste più dà un esito «errore» senza parole, e la frase «No
/// conversation found» sta nello standard error. Senza, il pannello non
/// saprebbe che può ricominciare da capo.
fn errore_del_turno(esito: &str, finito: bool, errori: &str) -> String {
    let errori = errori.trim();
    if errori.is_empty() {
        return esito.to_string();
    }
    let dettaglio = coda(errori, 800);
    if finito {
        format!("{esito} {dettaglio}")
    } else {
        format!("La CLI si è chiusa con un errore: {dettaglio}")
    }
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
