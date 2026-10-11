//! Con quali opzioni Medea avvia la CLI, e perché ognuna.
//!
//! La CLI nasce per scrivere codice in un terminale, con una persona davanti.
//! Qui serve altro: un modello che ragiona sulla posta dell'utente, senza
//! nessuno a cui chiedere un permesso e senza toccare il computer. Ogni
//! opzione toglie un pezzo del primo mestiere o regola il secondo.

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
    /// Il file con il prompt di sistema, se ce n'è uno.
    pub system_prompt_file: Option<&'a Path>,
    /// Il modello, se l'utente ne ha chiesto uno preciso.
    pub model: Option<&'a str>,
    /// La configurazione MCP con i tool di Medea, se il turno li usa.
    pub mcp_config: Option<&'a Path>,
}

/// Gli argomenti della CLI per quel turno. Il prompt non è fra questi: va
/// scritto sullo standard input.
///
/// Passarlo come argomento lo esporrebbe a due limiti — la lunghezza massima
/// di una riga di comando, che su Windows è di 32 mila caratteri e una
/// conversazione con qualche email la supera, e un testo che comincia per
/// `-` letto come un'opzione.
pub fn build(turno: &Turno<'_>) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        // Gli eventi del turno, non il solo testo: servono le chiamate agli
        // strumenti per mostrarle e per chiedere le conferme.
        "--output-format",
        "json",
        // Senza `--verbose` il formato json dà il solo esito finale, e le
        // chiamate agli strumenti spariscono: niente schede delle bozze,
        // nessuna conferma. Chi ha `verbose` nelle proprie impostazioni della
        // CLI non se ne accorge — per questo il difetto non si vedeva sulla
        // macchina di sviluppo ed è emerso solo su un Windows pulito.
        "--verbose",
        // Nessuno strumento suo: né shell, né file, né web. La CLI qui legge
        // la posta attraverso Medea e basta.
        "--tools",
        "",
        // Solo il server che le passa Medea, non quelli che l'utente ha
        // configurato per il proprio lavoro col terminale.
        "--strict-mcp-config",
        // Quello che non è permesso esplicitamente è negato, senza domande:
        // non c'è nessuno a cui farle.
        //
        // NON «plan»: quella modalità blocca ogni strumento esterno, lettura
        // compresa, e la CLI rispondeva di non poter guardare la posta.
        "--permission-mode",
        "dontAsk",
        // Niente impostazioni, istruzioni e comandi personali dell'utente:
        // sono scritti per il suo lavoro di sviluppo e qui finirebbero dentro
        // una conversazione sulla posta.
        "--setting-sources",
        "",
        "--disable-slash-commands",
        // Le conversazioni contengono email: non devono restare in chiaro
        // fra le sessioni della CLI.
        "--no-session-persistence",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();

    if let Some(file) = turno.system_prompt_file {
        // Sostituisce il prompt della CLI invece di aggiungersi: quello parla
        // di codice e di terminale, e qui non c'entra.
        args.push("--system-prompt-file".into());
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
    if let Some(config) = turno.mcp_config {
        args.push("--mcp-config".into());
        args.push(config.into());
        // Tutti gli strumenti di Medea: quelli che modificano dati non
        // vengono eseguiti dal server ma annunciati, e li conferma l'utente.
        args.push("--allowedTools".into());
        args.push(format!("mcp__{SERVER_MCP}").into());
    }
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

    /// Provato dal vivo l'11 ottobre 2026 con la CLI 2.1.296: in modalità
    /// «plan» ogni strumento di Medea veniva bloccato, lettura compresa, e
    /// l'assistente rispondeva di non poter guardare la posta.
    #[test]
    fn non_usa_la_modalita_che_blocca_gli_strumenti_di_medea() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(valore(&args, "--permission-mode"), Some("dontAsk"));
        assert!(!args.iter().any(|a| a == "plan"));
    }

    #[test]
    fn la_cli_non_ha_strumenti_suoi_ne_server_dell_utente() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(valore(&args, "--tools"), Some(""));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
    }

    #[test]
    fn l_ambiente_personale_dell_utente_resta_fuori() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(valore(&args, "--setting-sources"), Some(""));
        assert!(args.iter().any(|a| a == "--disable-slash-commands"));
        assert!(args.iter().any(|a| a == "--no-session-persistence"));
    }

    #[test]
    fn il_prompt_non_viaggia_fra_gli_argomenti() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(args[0], "-p");
        // Dopo `-p` viene subito un'opzione, non un testo.
        assert!(args[1].starts_with("--"));
    }

    /// Provato il 12 ottobre 2026 su Windows 11 con la CLI 2.1.296: senza
    /// `--verbose` l'uscita json è il solo esito, e Medea non vedeva nessuna
    /// chiamata agli strumenti.
    #[test]
    fn chiede_gli_eventi_del_turno_e_non_il_solo_esito() {
        let args = testo(&build(&Turno::default()));
        assert_eq!(valore(&args, "--output-format"), Some("json"));
        assert!(args.iter().any(|a| a == "--verbose"));
    }

    #[test]
    fn senza_strumenti_non_passa_nessun_server() {
        let args = testo(&build(&Turno::default()));
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        assert!(!args.iter().any(|a| a == "--allowedTools"));
    }

    #[test]
    fn con_gli_strumenti_permette_quelli_di_medea_e_solo_quelli() {
        let config = Path::new("/dati/mcp-config.json");
        let args = testo(&build(&Turno {
            mcp_config: Some(config),
            ..Turno::default()
        }));
        assert_eq!(valore(&args, "--mcp-config"), Some("/dati/mcp-config.json"));
        assert_eq!(valore(&args, "--allowedTools"), Some("mcp__medea"));
    }

    #[test]
    fn il_prompt_di_sistema_sostituisce_quello_della_cli() {
        let file = Path::new("/dati/sistema.txt");
        let args = testo(&build(&Turno {
            system_prompt_file: Some(file),
            ..Turno::default()
        }));
        assert_eq!(
            valore(&args, "--system-prompt-file"),
            Some("/dati/sistema.txt")
        );
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
    }

    #[test]
    fn il_modello_si_passa_solo_se_e_stato_chiesto() {
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

    /// È questo argomento a dire al server che le modifiche le conferma
    /// l'utente nell'app. Se mancasse, uno strumento che modifica dati
    /// partirebbe da solo: la CLI qui non chiede niente a nessuno.
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
