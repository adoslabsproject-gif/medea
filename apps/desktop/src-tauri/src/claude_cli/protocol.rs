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
#[path = "protocol_tests.rs"]
mod tests;
