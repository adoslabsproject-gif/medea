//! Le prove del turno. Quella vera usa la CLI e l'abbonamento, e si lancia a
//! mano.

use std::path::PathBuf;

use serde_json::json;

use super::*;

#[test]
fn la_coda_tiene_la_fine_e_non_spezza_i_caratteri() {
    assert_eq!(coda("abcdef", 3), "def");
    assert_eq!(coda("perché", 2), "hé");
    assert_eq!(coda("ab", 10), "ab");
}

fn cartella_di_prova(nome: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("medea-{nome}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("cartella di prova");
    dir
}

#[test]
fn senza_una_scelta_la_cli_lavora_nella_cartella_privata_di_medea() {
    let dati = cartella_di_prova("cwd-privata");
    let luoghi = Luoghi {
        data_dir: &dati,
        mcp_bin: Path::new("medea_mcp"),
    };
    let dove = cartella(&luoghi, None).expect("cartella");
    assert!(dove.starts_with(&dati));
    assert_ne!(dove, dati);
    let _ = std::fs::remove_dir_all(&dati);
}

#[test]
fn la_cartella_scelta_dall_utente_viene_rispettata() {
    let dati = cartella_di_prova("cwd-dati");
    let scelta = cartella_di_prova("cwd-scelta");
    let luoghi = Luoghi {
        data_dir: &dati,
        mcp_bin: Path::new("medea_mcp"),
    };
    assert_eq!(cartella(&luoghi, Some(&scelta)).expect("cartella"), scelta);
    let _ = std::fs::remove_dir_all(&dati);
    let _ = std::fs::remove_dir_all(&scelta);
}

/// Una cartella cancellata dopo essere stata scelta non deve far ripiegare
/// in silenzio su un'altra: l'utente crederebbe di lavorare sul suo progetto.
#[test]
fn una_cartella_scelta_che_non_esiste_piu_e_un_errore_detto_in_chiaro() {
    let dati = cartella_di_prova("cwd-sparita");
    let luoghi = Luoghi {
        data_dir: &dati,
        mcp_bin: Path::new("medea_mcp"),
    };
    let sparita = dati.join("non-esiste");
    let errore = cartella(&luoghi, Some(&sparita)).expect_err("un errore");
    assert!(errore.contains("non esiste più"), "{errore}");
    let _ = std::fs::remove_dir_all(&dati);
}

#[test]
fn rispondere_o_fermare_un_turno_gia_finito_non_fa_danni() {
    assert!(rispondi_permesso("turno-che-non-c-e", "r1", true, &json!({})).is_err());
    assert!(!ferma("turno-che-non-c-e"));
}

/// La prova che conta: la CLI vera, l'abbonamento vero, il server MCP vero,
/// su cartelle vuote.
///
/// Non gira con gli altri test perché consuma un turno dell'abbonamento e
/// vuole la CLI installata e autenticata. Si lancia a mano:
///
///   cargo build --bin medea_mcp
///   cargo test --lib claude_cli::run -- --ignored --nocapture
#[test]
#[ignore = "usa la CLI vera e un turno dell'abbonamento"]
fn un_turno_vero_scorre_chiede_i_permessi_e_non_modifica_niente_da_solo() {
    let radice = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mcp_bin = radice.join("target/debug").join(if cfg!(windows) {
        "medea_mcp.exe"
    } else {
        "medea_mcp"
    });
    assert!(mcp_bin.is_file(), "manca {}", mcp_bin.display());
    let dati = cartella_di_prova("turno-dati");
    let lavoro = cartella_di_prova("turno-lavoro");
    let turn_id = "prova-vera";

    let mut eventi: Vec<Evento> = Vec::new();
    let turno = esegui(
        &Luoghi {
            data_dir: &dati,
            mcp_bin: &mcp_bin,
        },
        &Richiesta {
            turn_id,
            prompt: "Fai quattro cose, in ordine. 1) Leggi la data con lo strumento datetime di \
                     Medea. 2) Prepara con email_draft una bozza per prova@example.com, oggetto \
                     «Prova», testo «Ciao». 3) Chiama customer_update per il cliente con id 1 \
                     impostando il telefono a 000. 4) Con Bash esegui: echo ciao > creato.txt. \
                     Poi riassumi in quattro righe cosa è riuscito e cosa no.",
            system_prompt: Some("Sei l'assistente di Medea. Rispondi in italiano."),
            model: None,
            resume: None,
            cwd: Some(&lavoro),
            allow_tools: true,
        },
        |evento| {
            // Chi sta davanti al pannello dice di no a tutto.
            if let Evento::Permesso {
                request_id, input, ..
            } = &evento
            {
                rispondi_permesso(turn_id, request_id, false, input).expect("risposta");
            }
            eventi.push(evento);
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
    assert!(turno.session_id.is_some());
    assert!(turno.usage.is_some());
    assert!(chiamata("datetime").di_medea && !chiamata("datetime").is_error);
    assert!(chiamata("email_draft")
        .output
        .as_deref()
        .is_some_and(|o| o.contains("NON è ancora avvenuta")));
    assert!(chiamata("customer_update")
        .output
        .as_deref()
        .is_some_and(|o| o.contains("NON è stata eseguita")));

    // Il comando è passato dalla richiesta di permesso, ha ricevuto un no, e
    // il file non esiste.
    assert!(!chiamata("Bash").di_medea && chiamata("Bash").is_error);
    assert!(eventi
        .iter()
        .any(|e| matches!(e, Evento::Permesso { tool_name, .. } if tool_name == "Bash")));
    assert!(
        !lavoro.join("creato.txt").exists(),
        "il comando è partito lo stesso"
    );

    // Il testo è arrivato a pezzi, e l'avvio ha detto sessione e comandi.
    let pezzi = eventi
        .iter()
        .filter(|e| matches!(e, Evento::Testo { .. }))
        .count();
    assert!(pezzi > 1, "il testo non è arrivato a pezzi ({pezzi})");
    assert!(eventi
        .iter()
        .any(|e| matches!(e, Evento::Avvio { slash_commands, .. } if !slash_commands.is_empty())));

    let _ = std::fs::remove_dir_all(&dati);
    let _ = std::fs::remove_dir_all(&lavoro);
}

/// La forma vera, letta dalla CLI: esito «errore» senza parole, e la
/// spiegazione solo fra gli errori.
#[test]
fn l_errore_porta_con_se_quello_che_la_cli_ha_scritto_fra_gli_errori() {
    let errore = errore_del_turno(
        "La CLI `claude` ha segnalato un errore (error_during_execution).",
        true,
        "No conversation found with session ID: 1111\n",
    );
    assert!(errore.contains("error_during_execution"));
    assert!(errore.contains("No conversation found with session ID"));
}

#[test]
fn senza_niente_fra_gli_errori_resta_l_esito_com_e() {
    assert_eq!(errore_del_turno("Esito.", true, "  \n"), "Esito.");
    assert_eq!(errore_del_turno("Esito.", false, ""), "Esito.");
}

#[test]
fn una_cli_morta_senza_esito_dice_perche() {
    let errore = errore_del_turno("senza esito", false, "unknown option --boh");
    assert!(errore.contains("unknown option --boh"));
    assert!(!errore.contains("senza esito"));
}
