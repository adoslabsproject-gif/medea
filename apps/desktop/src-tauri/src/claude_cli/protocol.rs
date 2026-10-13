//! Il dialogo con la CLI: cosa le si scrive, e cosa di ciò che dice interessa
//! al pannello.
//!
//! La CLI parla e ascolta a righe JSON. Di quello che dice, al pannello
//! servono poche cose: il testo man mano che arriva, gli strumenti che usa,
//! e le domande «posso?». Tutto il resto — contatori, stati interni, firme
//! del ragionamento — resta qui.
//!
//! Il formato è stato letto dal vivo dalla CLI 2.1.296 (13 ottobre 2026): è
//! lo stesso che usano gli SDK ufficiali per pilotarla.

use serde::Serialize;
use serde_json::{json, Value};

use super::events::{nome_strumento, testo_risultato};

/// Quello che il pannello riceve mentre il turno è in corso.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "tipo", rename_all = "camelCase")]
pub enum Evento {
    /// La CLI è partita: con quale modello, e quali comandi `/` conosce.
    #[serde(rename_all = "camelCase")]
    Avvio {
        session_id: String,
        model: String,
        slash_commands: Vec<String>,
    },
    /// Un pezzo di risposta.
    Testo { delta: String },
    /// Il modello sta usando uno strumento.
    #[serde(rename_all = "camelCase")]
    Strumento {
        id: String,
        name: String,
        di_medea: bool,
        input: Value,
    },
    /// Uno strumento ha risposto.
    #[serde(rename_all = "camelCase")]
    EsitoStrumento {
        id: String,
        output: Option<String>,
        is_error: bool,
    },
    /// La CLI chiede se può usare uno strumento. Resta ferma finché non le si
    /// risponde.
    #[serde(rename_all = "camelCase")]
    Permesso {
        request_id: String,
        tool_name: String,
        input: Value,
        /// Cosa sta per fare, a parole, quando la CLI lo dice.
        descrizione: Option<String>,
    },
}

/// Traduce gli eventi della CLI per il pannello, ricordando quel poco che
/// serve per separare un messaggio dal successivo.
#[derive(Debug, Default)]
pub struct Traduttore {
    ha_scritto: bool,
}

impl Traduttore {
    /// Gli eventi per il pannello che corrispondono a una riga della CLI.
    pub fn traduci(&mut self, riga: &Value) -> Vec<Evento> {
        match riga["type"].as_str() {
            Some("system") if riga["subtype"] == "init" => vec![Evento::Avvio {
                session_id: riga["session_id"].as_str().unwrap_or_default().to_string(),
                model: riga["model"].as_str().unwrap_or_default().to_string(),
                slash_commands: riga["slash_commands"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.as_str().map(str::to_string))
                    .collect(),
            }],
            Some("stream_event") => self.flusso(&riga["event"]),
            Some("assistant") => riga["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_use")
                .map(|b| {
                    let (name, di_medea) = nome_strumento(b["name"].as_str().unwrap_or_default());
                    Evento::Strumento {
                        id: b["id"].as_str().unwrap_or_default().to_string(),
                        name,
                        di_medea,
                        input: b.get("input").cloned().unwrap_or(Value::Null),
                    }
                })
                .collect(),
            Some("user") => riga["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_result")
                .map(|b| Evento::EsitoStrumento {
                    id: b["tool_use_id"].as_str().unwrap_or_default().to_string(),
                    output: testo_risultato(&b["content"]),
                    is_error: b["is_error"].as_bool().unwrap_or(false),
                })
                .collect(),
            Some("control_request") if riga["request"]["subtype"] == "can_use_tool" => {
                let richiesta = &riga["request"];
                vec![Evento::Permesso {
                    request_id: riga["request_id"].as_str().unwrap_or_default().to_string(),
                    tool_name: richiesta["tool_name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    input: richiesta.get("input").cloned().unwrap_or(Value::Null),
                    descrizione: richiesta["description"]
                        .as_str()
                        .map(str::to_string)
                        .filter(|d| !d.is_empty()),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn flusso(&mut self, evento: &Value) -> Vec<Evento> {
        match evento["type"].as_str() {
            // Fra un messaggio e il successivo c'è stato l'uso di uno
            // strumento: senza uno stacco le due frasi si attaccherebbero.
            Some("content_block_start")
                if evento["content_block"]["type"] == "text" && self.ha_scritto =>
            {
                vec![Evento::Testo {
                    delta: "\n\n".to_string(),
                }]
            }
            Some("content_block_delta") if evento["delta"]["type"] == "text_delta" => {
                match evento["delta"]["text"].as_str().filter(|t| !t.is_empty()) {
                    Some(testo) => {
                        self.ha_scritto = true;
                        vec![Evento::Testo {
                            delta: testo.to_string(),
                        }]
                    }
                    None => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }
}

/// Il messaggio dell'utente, come riga per la CLI.
pub fn messaggio_utente(testo: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": testo }] },
    })
    .to_string()
}

/// La risposta a una richiesta di permesso, come riga per la CLI.
///
/// Con il sì si rimanda l'input: la CLI esegue quello, non quello che aveva
/// chiesto, ed è così che un host può correggere un comando prima di
/// lasciarlo partire. Qui lo si rimanda uguale.
pub fn risposta_permesso(request_id: &str, consenti: bool, input: &Value) -> String {
    let risposta = if consenti {
        json!({ "behavior": "allow", "updatedInput": input })
    } else {
        json!({ "behavior": "deny", "message": "L'utente ha negato il permesso." })
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": risposta },
    })
    .to_string()
}

/// La risposta a una domanda della CLI che Medea non sa porre all'utente.
///
/// Va data comunque: la CLI resta ferma finché ogni sua domanda non ha una
/// risposta, e un turno bloccato per sempre è peggio di un «no».
pub fn risposta_non_gestita(request_id: &str) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": request_id,
            "error": "Medea non gestisce questa richiesta.",
        },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
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
}
