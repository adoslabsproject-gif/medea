//! Il comportamento del protocollo MCP di Medea, senza avviare un processo e
//! senza aprire il database.

use serde_json::{json, Value};

use super::*;

fn chiama(consenso: Consenso, name: &str) -> Value {
    handle_call(
        consenso,
        Some(json!(1)),
        &json!({ "name": name, "arguments": {} }),
    )
}

fn testo(risposta: &Value) -> String {
    risposta["result"]["content"][0]["text"]
        .as_str()
        .expect("un testo")
        .to_string()
}

fn sensibili() -> Vec<String> {
    ai_tools::registry()
        .into_iter()
        .filter(|t| t.kind == "sensitive")
        .map(|t| t.name)
        .collect()
}

/// Nessuno strumento che modifica dati parte da solo quando è Medea a
/// lanciare la CLI: lì non c'è nessuno a cui il client possa chiedere.
///
/// Il database in questo test non è aperto: se uno strumento venisse
/// eseguito risponderebbe con un errore, non con la richiesta di conferma.
#[test]
fn con_il_consenso_dell_app_nessuno_strumento_sensibile_viene_eseguito() {
    let nomi = sensibili();
    assert!(!nomi.is_empty(), "il registro non ha strumenti sensibili");
    for nome in nomi {
        let risposta = chiama(Consenso::DellApp, &nome);
        assert_eq!(risposta["result"]["isError"], json!(false), "{nome}");
        assert!(
            testo(&risposta).contains("NON è stata eseguita"),
            "{nome}: {}",
            testo(&risposta)
        );
    }
}

#[test]
fn una_lettura_risponde_allo_stesso_modo_a_chiunque() {
    let app = testo(&chiama(Consenso::DellApp, "datetime"));
    let client = testo(&chiama(Consenso::DelClient, "datetime"));
    assert!(app.contains("\"date\""));
    assert!(client.contains("\"date\""));
}

fn bozza(consenso: Consenso) -> String {
    testo(&handle_call(
        consenso,
        Some(json!(1)),
        &json!({
            "name": "email_draft",
            "arguments": {
                "to": ["a@example.com"],
                "subject": "Prova",
                "body": "CORPO-DELLA-BOZZA",
            },
        }),
    ))
}

/// Il contenuto di una bozza lo mostra Medea in una scheda. Rimesso nella
/// conversazione il modello lo ripeterebbe per intero, e senza l'avviso
/// direbbe all'utente di averla già spedita.
#[test]
fn con_il_consenso_dell_app_una_bozza_torna_al_modello_come_riepilogo() {
    let risposta = bozza(Consenso::DellApp);
    assert!(risposta.contains("a@example.com"), "{risposta}");
    assert!(risposta.contains("NON è ancora avvenuta"), "{risposta}");
    assert!(!risposta.contains("CORPO-DELLA-BOZZA"), "{risposta}");
}

/// A un client esterno non si promette una scheda che non ha.
#[test]
fn a_un_client_esterno_non_si_parla_della_scheda_di_medea() {
    assert!(!bozza(Consenso::DelClient).contains("scheda"));
}

#[test]
fn l_elenco_dice_al_modello_chi_conferma() {
    let nome = sensibili().remove(0);
    let descrizione = |consenso| {
        tools_list(consenso)["tools"]
            .as_array()
            .expect("elenco")
            .iter()
            .find(|t| t["name"] == json!(nome))
            .expect("lo strumento")["description"]
            .as_str()
            .expect("descrizione")
            .to_string()
    };
    assert!(descrizione(Consenso::DellApp).contains("conferma nell'app"));
    assert!(descrizione(Consenso::DelClient).contains("chiedi conferma all'utente"));
}

#[test]
fn il_modo_si_legge_dagli_argomenti() {
    let con = vec!["medea_mcp".to_string(), ARG_CONSENSO_APP.to_string()];
    let senza = vec!["medea_mcp".to_string()];
    assert_eq!(Consenso::from_args(con), Consenso::DellApp);
    assert_eq!(Consenso::from_args(senza), Consenso::DelClient);
}

#[test]
fn uno_strumento_inesistente_torna_come_errore_al_modello() {
    let risposta = chiama(Consenso::DellApp, "strumento_che_non_esiste");
    assert_eq!(risposta["result"]["isError"], json!(true));
}

#[test]
fn una_notifica_non_riceve_risposta() {
    let riga = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
    assert!(handle_line(Consenso::DelClient, riga).is_none());
}

#[test]
fn un_metodo_sconosciuto_e_una_riga_illeggibile_sono_errori_di_protocollo() {
    let sconosciuto = handle_line(
        Consenso::DelClient,
        r#"{"jsonrpc":"2.0","id":7,"method":"boh"}"#,
    )
    .expect("una risposta");
    assert_eq!(sconosciuto["error"]["code"], json!(-32601));
    assert_eq!(sconosciuto["id"], json!(7));

    let illeggibile = handle_line(Consenso::DelClient, "{non json").expect("una risposta");
    assert_eq!(illeggibile["error"]["code"], json!(-32700));
}
