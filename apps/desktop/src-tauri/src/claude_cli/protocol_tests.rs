//! Il dialogo con la CLI, provato sulle forme vere dei suoi messaggi.

use serde_json::{json, Value};

use super::*;

#[test]
fn una_domanda_non_gestita_riceve_comunque_una_risposta() {
    let v: Value = serde_json::from_str(&risposta_non_gestita("r9")).expect("json");
    assert_eq!(v["type"], json!("control_response"));
    assert_eq!(v["response"]["subtype"], json!("error"));
    assert_eq!(v["response"]["request_id"], json!("r9"));
}

fn delta(testo: &str) -> Value {
    json!({ "type": "stream_event", "event": {
        "type": "content_block_delta", "delta": { "type": "text_delta", "text": testo } } })
}

fn inizio_blocco(tipo: &str) -> Value {
    json!({ "type": "stream_event", "event": {
        "type": "content_block_start", "content_block": { "type": tipo } } })
}

#[test]
fn l_avvio_porta_sessione_modello_e_comandi() {
    let mut t = Traduttore::default();
    let eventi = t.traduci(&json!({
        "type": "system", "subtype": "init", "session_id": "s1",
        "model": "claude-sonnet-5-5", "slash_commands": ["compact", "context"],
    }));
    assert_eq!(
        eventi,
        vec![Evento::Avvio {
            session_id: "s1".into(),
            model: "claude-sonnet-5-5".into(),
            slash_commands: vec!["compact".into(), "context".into()],
        }]
    );
}

#[test]
fn il_testo_arriva_a_pezzi_nell_ordine_in_cui_viene_scritto() {
    let mut t = Traduttore::default();
    let mut testo = String::new();
    for riga in [inizio_blocco("text"), delta("Ciao"), delta(", come va?")] {
        for e in t.traduci(&riga) {
            if let Evento::Testo { delta } = e {
                testo.push_str(&delta);
            }
        }
    }
    assert_eq!(testo, "Ciao, come va?");
}

/// Dopo uno strumento il modello riprende a scrivere in un messaggio
/// nuovo: senza stacco «Controllo.» e «Fatto.» diventerebbero
/// «Controllo.Fatto.».
#[test]
fn fra_due_messaggi_c_e_uno_stacco_ma_non_prima_del_primo() {
    let mut t = Traduttore::default();
    let mut testo = String::new();
    for riga in [
        inizio_blocco("text"),
        delta("Controllo."),
        inizio_blocco("tool_use"),
        inizio_blocco("text"),
        delta("Fatto."),
    ] {
        for e in t.traduci(&riga) {
            if let Evento::Testo { delta } = e {
                testo.push_str(&delta);
            }
        }
    }
    assert_eq!(testo, "Controllo.\n\nFatto.");
}

#[test]
fn il_ragionamento_e_i_contatori_non_arrivano_al_pannello() {
    let mut t = Traduttore::default();
    for riga in [
        json!({ "type": "stream_event", "event": { "type": "content_block_delta",
                "delta": { "type": "thinking_delta", "thinking": "penso" } } }),
        json!({ "type": "stream_event", "event": { "type": "message_delta" } }),
        json!({ "type": "system", "subtype": "status" }),
        json!({ "type": "rate_limit_event" }),
        json!({ "type": "result", "result": "x" }),
    ] {
        assert!(t.traduci(&riga).is_empty(), "{riga}");
    }
}

#[test]
fn uno_strumento_di_medea_si_riconosce_da_uno_di_claude_code() {
    let mut t = Traduttore::default();
    let eventi = t.traduci(&json!({ "type": "assistant", "message": { "content": [
        { "type": "text", "text": "ecco" },
        { "type": "tool_use", "id": "a", "name": "mcp__medea__email_recent", "input": { "count": 3 } },
        { "type": "tool_use", "id": "b", "name": "Bash", "input": { "command": "ls" } },
    ] } }));
    assert_eq!(
        eventi,
        vec![
            Evento::Strumento {
                id: "a".into(),
                name: "email_recent".into(),
                di_medea: true,
                input: json!({ "count": 3 }),
            },
            Evento::Strumento {
                id: "b".into(),
                name: "Bash".into(),
                di_medea: false,
                input: json!({ "command": "ls" }),
            },
        ]
    );
}

#[test]
fn l_esito_di_uno_strumento_porta_il_suo_identificativo() {
    let mut t = Traduttore::default();
    let eventi = t.traduci(&json!({ "type": "user", "message": { "content": [
        { "type": "tool_result", "tool_use_id": "b", "content": "negato", "is_error": true }
    ] } }));
    assert_eq!(
        eventi,
        vec![Evento::EsitoStrumento {
            id: "b".into(),
            output: Some("negato".into()),
            is_error: true,
        }]
    );
}

/// La forma vera della richiesta, presa dalla CLI.
#[test]
fn una_richiesta_di_permesso_arriva_con_cosa_sta_per_fare() {
    let mut t = Traduttore::default();
    let eventi = t.traduci(&json!({
        "type": "control_request", "request_id": "r1",
        "request": { "subtype": "can_use_tool", "tool_name": "Bash",
                     "input": { "command": "echo ciao > prova.txt" },
                     "description": "Write ciao into prova.txt", "tool_use_id": "t1" },
    }));
    assert_eq!(
        eventi,
        vec![Evento::Permesso {
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            input: json!({ "command": "echo ciao > prova.txt" }),
            descrizione: Some("Write ciao into prova.txt".into()),
        }]
    );
}

#[test]
fn una_richiesta_di_controllo_di_altro_genere_non_e_un_permesso() {
    let mut t = Traduttore::default();
    assert!(t
        .traduci(&json!({ "type": "control_request", "request_id": "r",
                          "request": { "subtype": "altro" } }))
        .is_empty());
}

#[test]
fn gli_eventi_viaggiano_verso_il_pannello_con_un_tipo_e_nomi_in_camel_case() {
    let json = serde_json::to_value(Evento::Permesso {
        request_id: "r1".into(),
        tool_name: "Bash".into(),
        input: json!({}),
        descrizione: None,
    })
    .expect("json");
    assert_eq!(json["tipo"], json!("permesso"));
    assert_eq!(json["requestId"], json!("r1"));
    assert_eq!(json["toolName"], json!("Bash"));
    let esito = serde_json::to_value(Evento::EsitoStrumento {
        id: "x".into(),
        output: None,
        is_error: true,
    })
    .expect("json");
    assert_eq!(esito["tipo"], json!("esitoStrumento"));
    assert_eq!(esito["isError"], json!(true));
}

#[test]
fn il_messaggio_dell_utente_e_una_riga_sola_anche_con_gli_a_capo() {
    let riga = messaggio_utente("prima\nseconda \"citata\"");
    assert!(!riga.contains('\n'));
    let v: Value = serde_json::from_str(&riga).expect("json");
    assert_eq!(v["type"], json!("user"));
    assert_eq!(
        v["message"]["content"][0]["text"],
        json!("prima\nseconda \"citata\"")
    );
}

#[test]
fn il_si_rimanda_l_input_e_il_no_porta_un_messaggio() {
    let si: Value =
        serde_json::from_str(&risposta_permesso("r1", true, &json!({ "command": "ls" })))
            .expect("json");
    assert_eq!(si["type"], json!("control_response"));
    assert_eq!(si["response"]["request_id"], json!("r1"));
    assert_eq!(si["response"]["response"]["behavior"], json!("allow"));
    assert_eq!(
        si["response"]["response"]["updatedInput"],
        json!({ "command": "ls" })
    );

    let no: Value =
        serde_json::from_str(&risposta_permesso("r2", false, &json!({}))).expect("json");
    assert_eq!(no["response"]["response"]["behavior"], json!("deny"));
    assert!(no["response"]["response"].get("updatedInput").is_none());
}
