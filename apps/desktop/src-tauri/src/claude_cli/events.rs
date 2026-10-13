//! Tenere il conto di un turno mentre la CLI lo racconta.
//!
//! La CLI stampa un evento per riga: i messaggi del modello con le sue
//! chiamate agli strumenti, i risultati di quelle chiamate, e in fondo
//! l'esito. Il [`Collettore`] li riceve uno alla volta e alla fine restituisce
//! il turno intero: il testo, gli strumenti usati — per farli vedere, per le
//! bozze e per le conferme — quanto è costato, e la sessione da riprendere.

use serde::Serialize;
use serde_json::Value;

use super::args::SERVER_MCP;

/// Il turno come lo riceve l'interfaccia.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliTurn {
    pub text: String,
    pub tool_calls: Vec<CliToolCall>,
    pub usage: Option<CliUsage>,
    /// La sessione della CLI: passandola al turno dopo, la conversazione
    /// prosegue senza rimandare tutto da capo.
    pub session_id: Option<String>,
}

/// Una chiamata a uno strumento fatta dalla CLI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolCall {
    pub id: String,
    /// Il nome di Medea senza il prefisso che gli mette la CLI; per gli
    /// strumenti di Claude Code, il loro nome.
    pub name: String,
    /// Vero se lo strumento è di Medea e non di Claude Code.
    pub di_medea: bool,
    pub arguments: Value,
    /// Quello che lo strumento ha risposto, se ha risposto.
    pub output: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUsage {
    pub input: u64,
    pub output: u64,
}

/// Il nome dello strumento come lo conosce Medea, e se è suo.
pub fn nome_strumento(name: &str) -> (String, bool) {
    match name.strip_prefix(&format!("mcp__{SERVER_MCP}__")) {
        Some(medea) => (medea.to_string(), true),
        None => (name.to_string(), false),
    }
}

/// Il testo di un risultato: la CLI lo dà come stringa o come blocchi.
pub fn testo_risultato(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocchi) => {
            let parti: Vec<&str> = blocchi
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect();
            (!parti.is_empty()).then(|| parti.join("\n"))
        }
        _ => None,
    }
}

fn blocchi(evento: &Value) -> impl Iterator<Item = &Value> {
    evento["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
}

fn uso(risultato: &Value) -> Option<CliUsage> {
    let usage = risultato.get("usage")?;
    let n = |campo: &str| usage[campo].as_u64().unwrap_or(0);
    Some(CliUsage {
        // Anche i token letti dalla cache sono entrati nel modello: lasciarli
        // fuori farebbe sembrare gratuito un turno con un contesto enorme.
        input: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
        output: n("output_tokens"),
    })
}

/// Riceve gli eventi di un turno e ne tiene il conto.
#[derive(Debug, Default)]
pub struct Collettore {
    tool_calls: Vec<CliToolCall>,
    session_id: Option<String>,
    risultato: Option<Value>,
}

impl Collettore {
    pub fn evento(&mut self, evento: &Value) {
        if let Some(id) = evento["session_id"].as_str().filter(|s| !s.is_empty()) {
            self.session_id = Some(id.to_string());
        }
        match evento["type"].as_str() {
            Some("assistant") => {
                for blocco in blocchi(evento).filter(|b| b["type"] == "tool_use") {
                    let (name, di_medea) =
                        nome_strumento(blocco["name"].as_str().unwrap_or_default());
                    self.tool_calls.push(CliToolCall {
                        id: blocco["id"].as_str().unwrap_or_default().to_string(),
                        name,
                        di_medea,
                        arguments: blocco.get("input").cloned().unwrap_or(Value::Null),
                        output: None,
                        is_error: false,
                    });
                }
            }
            Some("user") => {
                for blocco in blocchi(evento).filter(|b| b["type"] == "tool_result") {
                    let id = blocco["tool_use_id"].as_str().unwrap_or_default();
                    if let Some(call) = self.tool_calls.iter_mut().find(|c| c.id == id) {
                        call.output = testo_risultato(&blocco["content"]);
                        call.is_error = blocco["is_error"].as_bool().unwrap_or(false);
                    }
                }
            }
            Some("result") => self.risultato = Some(evento.clone()),
            _ => {}
        }
    }

    /// Vero quando la CLI ha dato l'esito: il turno è finito.
    pub fn finito(&self) -> bool {
        self.risultato.is_some()
    }

    /// Il turno intero. L'errore è una frase da mostrare all'utente.
    pub fn fine(self) -> Result<ClaudeCliTurn, String> {
        let risultato = self
            .risultato
            .ok_or_else(|| "La CLI `claude` si è chiusa senza dare un esito.".to_string())?;
        let text = risultato["result"].as_str().unwrap_or_default().trim();

        if risultato["is_error"].as_bool().unwrap_or(false) {
            return Err(if text.is_empty() {
                format!(
                    "La CLI `claude` ha segnalato un errore ({}).",
                    risultato["subtype"].as_str().unwrap_or("sconosciuto")
                )
            } else {
                format!("La CLI `claude` ha segnalato un errore: {text}")
            });
        }

        Ok(ClaudeCliTurn {
            text: text.to_string(),
            tool_calls: self.tool_calls,
            usage: uso(&risultato),
            session_id: self.session_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raccogli(eventi: &[Value]) -> Result<ClaudeCliTurn, String> {
        let mut c = Collettore::default();
        for e in eventi {
            c.evento(e);
        }
        c.fine()
    }

    /// La forma vera di un turno, presa dalla CLI 2.1.296 e ridotta ai campi
    /// che contano: uno strumento di Medea, uno di Claude Code negato.
    fn turno_vero() -> Vec<Value> {
        vec![
            json!({ "type": "system", "subtype": "init", "session_id": "sess-1" }),
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_01", "name": "mcp__medea__datetime", "input": {} }
            ] } }),
            json!({ "type": "user", "message": { "content": [
                { "tool_use_id": "toolu_01", "type": "tool_result",
                  "content": [{ "type": "text", "text": "{\"date\":\"2026-10-11\"}" }] }
            ] } }),
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_02", "name": "Bash",
                  "input": { "command": "echo x > due.txt" } }
            ] } }),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "content": "L'utente ha negato il permesso.",
                  "is_error": true, "tool_use_id": "toolu_02" }
            ] } }),
            json!({ "type": "rate_limit_event" }),
            json!({ "type": "result", "subtype": "success", "is_error": false,
                    "session_id": "sess-1", "result": "Oggi è l'11 ottobre.\n",
                    "usage": { "input_tokens": 4, "cache_creation_input_tokens": 472,
                               "cache_read_input_tokens": 27822, "output_tokens": 213 } }),
        ]
    }

    #[test]
    fn il_testo_e_quello_dell_esito() {
        assert_eq!(
            raccogli(&turno_vero()).expect("un turno").text,
            "Oggi è l'11 ottobre."
        );
    }

    #[test]
    fn le_chiamate_dicono_di_chi_e_lo_strumento_e_cosa_ha_risposto() {
        let turno = raccogli(&turno_vero()).expect("un turno");
        assert_eq!(turno.tool_calls.len(), 2);

        let medea = &turno.tool_calls[0];
        assert_eq!(medea.name, "datetime");
        assert!(medea.di_medea);
        assert_eq!(medea.output.as_deref(), Some("{\"date\":\"2026-10-11\"}"));
        assert!(!medea.is_error);

        let bash = &turno.tool_calls[1];
        assert_eq!(bash.name, "Bash");
        assert!(!bash.di_medea);
        assert_eq!(bash.arguments, json!({ "command": "echo x > due.txt" }));
        assert!(bash.is_error);
    }

    #[test]
    fn la_sessione_torna_indietro_per_poterla_riprendere() {
        let turno = raccogli(&turno_vero()).expect("un turno");
        assert_eq!(turno.session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn il_costo_conta_anche_i_token_presi_dalla_cache() {
        let turno = raccogli(&turno_vero()).expect("un turno");
        assert_eq!(
            turno.usage,
            Some(CliUsage {
                input: 4 + 472 + 27822,
                output: 213
            })
        );
    }

    #[test]
    fn il_turno_e_finito_solo_quando_arriva_l_esito() {
        let eventi = turno_vero();
        let mut c = Collettore::default();
        for e in &eventi[..eventi.len() - 1] {
            c.evento(e);
            assert!(!c.finito());
        }
        c.evento(&eventi[eventi.len() - 1]);
        assert!(c.finito());
    }

    #[test]
    fn un_esito_di_errore_diventa_un_errore_con_le_parole_della_cli() {
        let errore = raccogli(&[
            json!({ "type": "result", "subtype": "error_during_execution",
                                        "is_error": true, "result": "Please run /login" }),
        ])
        .expect_err("un errore");
        assert!(errore.contains("Please run /login"));
    }

    #[test]
    fn un_errore_senza_parole_dice_almeno_di_che_tipo() {
        let errore = raccogli(&[
            json!({ "type": "result", "subtype": "error_max_turns", "is_error": true }),
        ])
        .expect_err("un errore");
        assert!(errore.contains("error_max_turns"));
    }

    #[test]
    fn senza_esito_il_turno_e_un_errore() {
        assert!(raccogli(&[json!({ "type": "system", "subtype": "init" })]).is_err());
    }

    #[test]
    fn un_risultato_puo_essere_una_stringa_o_dei_blocchi() {
        assert_eq!(testo_risultato(&json!("ciao")).as_deref(), Some("ciao"));
        assert_eq!(
            testo_risultato(
                &json!([{ "type": "text", "text": "a" }, { "type": "image" },
                                    { "type": "text", "text": "b" }])
            )
            .as_deref(),
            Some("a\nb")
        );
        assert_eq!(testo_risultato(&json!(null)), None);
    }
}
