//! Un turno con la CLI, dall'avvio alla risposta.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::args::{self, Turno};
use super::events::{self, ClaudeCliTurn};
use super::locate::{self, Ambiente};
use super::workdir::{cartella_lavoro, FileDelTurno};

/// Dove stanno le cose di Medea che servono alla CLI.
pub struct Luoghi<'a> {
    /// La cartella dati dell'app: lì sta il database, e lì lavora la CLI.
    pub data_dir: &'a Path,
    /// Il binario del server MCP con i tool di Medea.
    pub mcp_bin: &'a Path,
}

/// Cosa si chiede alla CLI.
pub struct Richiesta<'a> {
    pub prompt: &'a str,
    pub system_prompt: Option<&'a str>,
    pub model: Option<&'a str>,
    /// Se la CLI può usare i tool di Medea.
    pub allow_tools: bool,
}

/// Gli ultimi caratteri di un testo: di un errore lungo conta la fine.
fn coda(testo: &str, caratteri: usize) -> String {
    let inizio = testo.chars().count().saturating_sub(caratteri);
    testo.chars().skip(inizio).collect()
}

/// Esegue il turno e lo restituisce letto. L'errore è una frase per l'utente.
pub fn esegui(luoghi: &Luoghi<'_>, richiesta: &Richiesta<'_>) -> Result<ClaudeCliTurn, String> {
    let bin = locate::locate()
        .ok_or_else(|| "CLI `claude` non trovata. Installala e fai `claude login`.".to_string())?;
    let dir = cartella_lavoro(luoghi.data_dir)
        .map_err(|e| format!("Cartella di lavoro della CLI non creabile: {e}"))?;

    let sistema = match richiesta.system_prompt.filter(|s| !s.trim().is_empty()) {
        Some(testo) => Some(
            FileDelTurno::scrivi(&dir, testo)
                .map_err(|e| format!("Prompt di sistema non scrivibile: {e}"))?,
        ),
        None => None,
    };

    let mcp_config = if richiesta.allow_tools {
        let path = dir.join("mcp-config.json");
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
        }))
        // Una cartella vuota e privata: la CLI carica istruzioni e
        // impostazioni dalla cartella in cui parte, e quella dell'app non è
        // un progetto.
        .current_dir(&dir)
        .env("PATH", Ambiente::corrente().path_esteso())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Avvio CLI fallito: {e}"))?;

    // Il prompt si scrive da un altro filo: se la CLI cominciasse a
    // rispondere prima di averlo letto tutto, i due resterebbero ad
    // aspettarsi a vicenda.
    let scrittore = child.stdin.take().map(|mut stdin| {
        let testo = richiesta.prompt.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(testo.as_bytes());
        })
    });

    let out = child
        .wait_with_output()
        .map_err(|e| format!("La CLI non ha risposto: {e}"))?;
    if let Some(filo) = scrittore {
        let _ = filo.join();
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    match events::parse(&stdout) {
        Ok(turno) => Ok(turno),
        // Uscita pulita ma illeggibile, oppure un errore che la CLI ha
        // spiegato nel suo esito: le parole giuste sono già quelle.
        Err(e) if out.status.success() || !stdout.trim().is_empty() => Err(e),
        Err(_) => Err(format!(
            "claude è uscita con codice {}: {}",
            out.status.code().unwrap_or(-1),
            coda(&String::from_utf8_lossy(&out.stderr), 800)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn la_coda_tiene_la_fine_e_non_spezza_i_caratteri() {
        assert_eq!(coda("abcdef", 3), "def");
        assert_eq!(coda("perché", 2), "hé");
        assert_eq!(coda("ab", 10), "ab");
    }

    /// La prova che conta: la CLI vera, l'abbonamento vero, il server MCP
    /// vero, su una cartella dati vuota.
    ///
    /// Non gira con gli altri test perché consuma un turno dell'abbonamento e
    /// vuole la CLI installata e autenticata. Si lancia a mano:
    ///
    ///   cargo build --bin medea_mcp
    ///   cargo test --lib claude_cli::run -- --ignored --nocapture
    #[test]
    #[ignore = "usa la CLI vera e un turno dell'abbonamento"]
    fn un_turno_vero_legge_prepara_una_bozza_e_non_modifica_niente_da_solo() {
        let radice = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mcp_bin = radice.join("target/debug/medea_mcp");
        assert!(mcp_bin.is_file(), "manca {}", mcp_bin.display());
        let data_dir = std::env::temp_dir().join(format!("medea-turno-{}", std::process::id()));
        std::fs::create_dir_all(&data_dir).expect("cartella dati di prova");

        let turno = esegui(
            &Luoghi {
                data_dir: &data_dir,
                mcp_bin: &mcp_bin,
            },
            &Richiesta {
                prompt: "Utente: fai tre cose, in ordine. 1) Leggi la data con lo strumento \
                         datetime. 2) Prepara con email_draft una bozza per prova@example.com, \
                         oggetto «Prova», testo «Ciao». 3) Chiama customer_update per il cliente \
                         con id 1 impostando il telefono a 000. Poi riassumi in tre righe.",
                system_prompt: Some("Sei l'assistente di Medea. Rispondi in italiano."),
                model: None,
                allow_tools: true,
            },
        )
        .expect("un turno");

        println!("{turno:#?}");
        let chiamata = |nome: &str| {
            turno
                .tool_calls
                .iter()
                .find(|c| c.name == nome)
                .unwrap_or_else(|| panic!("la CLI non ha chiamato {nome}"))
        };
        assert!(!turno.text.is_empty());
        assert!(!chiamata("datetime").is_error);
        assert!(chiamata("email_draft")
            .output
            .as_deref()
            .is_some_and(|o| o.contains("NON è ancora avvenuta")));
        assert!(chiamata("customer_update")
            .output
            .as_deref()
            .is_some_and(|o| o.contains("NON è stata eseguita")));
        assert!(turno.usage.is_some());

        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
