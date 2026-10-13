//! Con quali opzioni Medea avvia la CLI, e perché ognuna.
//!
//! Dentro Medea la CLI è Claude Code per intero: i suoi strumenti, i suoi
//! comandi, le impostazioni dell'utente. Quello che cambia rispetto al
//! terminale è chi le sta davanti — il pannello di Medea al posto di una
//! persona alla tastiera — e le opzioni servono a questo: farla parlare a
//! righe, farle chiedere i permessi al pannello, darle gli strumenti di
//! Medea.

use std::ffi::OsString;
use std::path::Path;

use serde_json::{json, Value};

use crate::mcp::ARG_CONSENSO_APP;

/// Il nome con cui il server di Medea compare alla CLI. Entra nel nome di
/// ogni strumento: `mcp__medea__email_recent`.
pub const SERVER_MCP: &str = "medea";

/// Un turno da far eseguire alla CLI.
#[derive(Debug, Default)]
pub struct Turno<'a> {
    /// Il file con le istruzioni di Medea, da aggiungere a quelle della CLI.
    pub system_prompt_file: Option<&'a Path>,
    /// Il modello, se l'utente ne ha scelto uno.
    pub model: Option<&'a str>,
    /// La configurazione MCP con i tool di Medea, se il turno li usa.
    pub mcp_config: Option<&'a Path>,
    /// La sessione da riprendere, se la conversazione è già cominciata.
    pub resume: Option<&'a str>,
}

/// Gli argomenti della CLI per quel turno. Il messaggio dell'utente non è fra
/// questi: va scritto sullo standard input.
pub fn build(turno: &Turno<'_>) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        // A righe JSON in entrambi i versi: è il solo modo in cui la CLI può
        // fare domande a chi la pilota mentre lavora.
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        // Senza, il formato a righe non parte e quello a blocco dà il solo
        // esito finale.
        "--verbose",
        // Il testo man mano che viene scritto, non a messaggio finito.
        "--include-partial-messages",
        // I permessi li chiede a noi, sullo stesso canale: il pannello li
        // mostra e l'utente decide. Quello che la CLI considera lettura parte
        // da solo; comandi, scritture e modifiche passano da qui.
        "--permission-prompt-tool",
        "stdio",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();

    if let Some(file) = turno.system_prompt_file {
        // Si aggiunge, non sostituisce: gli strumenti di Claude Code hanno
        // bisogno delle istruzioni di Claude Code.
        args.push("--append-system-prompt-file".into());
        args.push(file.into());
    }
    if let Some(model) = turno
        .model
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "default")
    {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(sessione) = turno.resume.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(sessione.into());
    }

    // La ricerca sul web parte da sola; aprire una pagina no, e passa dalla
    // richiesta di permesso come ogni altra azione che esce dal computer.
    let mut permessi = vec!["WebSearch".to_string()];
    if let Some(config) = turno.mcp_config {
        args.push("--mcp-config".into());
        args.push(config.into());
        // Tutti gli strumenti di Medea: quelli che modificano dati non
        // vengono eseguiti dal server ma annunciati, e li conferma l'utente.
        permessi.push(format!("mcp__{SERVER_MCP}"));
    }
    args.push("--allowedTools".into());
    args.push(permessi.join(",").into());
    args
}

/// La configurazione MCP che presenta alla CLI il server di Medea.
///
/// `data_dir` viaggia nell'ambiente del server: deve aprire lo stesso
/// database dell'app, e ricavarlo da solo dalla cartella dell'utente
/// vorrebbe dire sperare che i due conti tornino uguali.
pub fn mcp_config(mcp_bin: &Path, data_dir: &Path) -> Value {
    json!({
        "mcpServers": {
            SERVER_MCP: {
                "command": mcp_bin.to_string_lossy(),
                "args": [ARG_CONSENSO_APP],
                "env": { "MEDEA_DATA_DIR": data_dir.to_string_lossy() },
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::Consenso;

    fn testo(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// Il valore che segue un'opzione, se l'opzione c'è.
    fn valore<'a>(args: &'a [String], opzione: &str) -> Option<&'a str> {
        let i = args.iter().position(|a| a == opzione)?;
        args.get(i + 1).map(String::as_str)
    }

    #[test]
    fn parla_e_ascolta_a_righe_con_il_testo_a_pezzi() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(args[0], "-p");
        assert_eq!(valore(&args, "--input-format"), Some("stream-json"));
        assert_eq!(valore(&args, "--output-format"), Some("stream-json"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(args.iter().any(|a| a == "--include-partial-messages"));
    }

    /// È questa opzione a portare nel pannello le domande «posso?». Senza,
    /// in modalità non interattiva la CLI nega tutto quello che chiederebbe.
    #[test]
    fn i_permessi_li_chiede_a_medea() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(valore(&args, "--permission-prompt-tool"), Some("stdio"));
    }

    /// Nessuna di queste opzioni deve tornare: toglierebbero a Claude Code i
    /// suoi strumenti, le impostazioni dell'utente, o le conferme.
    #[test]
    fn claude_code_resta_intero_e_chiede_sempre() {
        let args = testo(&build(&Turno {
            mcp_config: Some(Path::new("/dati/mcp.json")),
            ..Turno::default()
        }));
        for vietata in [
            "--tools",
            "--strict-mcp-config",
            "--setting-sources",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--dangerously-skip-permissions",
            "--permission-mode",
        ] {
            assert!(!args.iter().any(|a| a == vietata), "{vietata} è tornata");
        }
    }

    #[test]
    fn da_sola_parte_la_ricerca_ma_non_l_apertura_di_pagine() {
        let args = testo(&build(&Turno::default()));
        let permessi = valore(&args, "--allowedTools").expect("permessi");
        assert_eq!(permessi, "WebSearch");
        assert!(!permessi.contains("WebFetch"));
        assert!(!permessi.contains("Bash"));
    }

    #[test]
    fn con_gli_strumenti_di_medea_passa_il_suo_server_e_lo_permette() {
        let args = testo(&build(&Turno {
            mcp_config: Some(Path::new("/dati/mcp.json")),
            ..Turno::default()
        }));
        assert_eq!(valore(&args, "--mcp-config"), Some("/dati/mcp.json"));
        assert_eq!(
            valore(&args, "--allowedTools"),
            Some("WebSearch,mcp__medea")
        );
    }

    #[test]
    fn le_istruzioni_di_medea_si_aggiungono_a_quelle_di_claude_code() {
        let args = testo(&build(&Turno {
            system_prompt_file: Some(Path::new("/dati/sistema.txt")),
            ..Turno::default()
        }));
        assert_eq!(
            valore(&args, "--append-system-prompt-file"),
            Some("/dati/sistema.txt")
        );
        assert!(!args.iter().any(|a| a == "--system-prompt-file"));
    }

    #[test]
    fn il_modello_si_passa_solo_se_e_stato_scelto() {
        let con = |model| {
            testo(&build(&Turno {
                model,
                ..Turno::default()
            }))
        };
        assert_eq!(valore(&con(Some("sonnet")), "--model"), Some("sonnet"));
        assert!(!con(Some("default")).iter().any(|a| a == "--model"));
        assert!(!con(Some("  ")).iter().any(|a| a == "--model"));
        assert!(!con(None).iter().any(|a| a == "--model"));
    }

    #[test]
    fn una_conversazione_cominciata_riprende_la_sua_sessione() {
        let con = |resume| {
            testo(&build(&Turno {
                resume,
                ..Turno::default()
            }))
        };
        assert_eq!(valore(&con(Some("abc-123")), "--resume"), Some("abc-123"));
        assert!(!con(None).iter().any(|a| a == "--resume"));
        assert!(!con(Some(" ")).iter().any(|a| a == "--resume"));
    }

    /// È questo argomento a dire al server che le modifiche le conferma
    /// l'utente nell'app. Se mancasse, uno strumento di Medea che modifica
    /// dati partirebbe da solo: per la CLI è già permesso.
    #[test]
    fn il_server_viene_avviato_con_il_consenso_dell_app() {
        let config = mcp_config(Path::new("/app/medea_mcp"), Path::new("/dati"));
        let server = &config["mcpServers"][SERVER_MCP];
        let args: Vec<String> = server["args"]
            .as_array()
            .expect("argomenti")
            .iter()
            .map(|a| a.as_str().expect("testo").to_string())
            .collect();
        assert_eq!(Consenso::from_args(args), Consenso::DellApp);
        assert_eq!(server["command"], json!("/app/medea_mcp"));
        assert_eq!(server["env"]["MEDEA_DATA_DIR"], json!("/dati"));
    }
}
