//! Leggere quello che la CLI risponde.
//!
//! Con `--output-format json` la CLI stampa gli eventi del turno: i messaggi
//! del modello con le sue chiamate agli strumenti, i risultati di quelle
//! chiamate, e in fondo l'esito. Medea ne ricava tre cose: il testo da
//! mostrare, gli strumenti usati — per farli vedere e per chiedere le
//! conferme — e quanto è costato il turno.

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
}

/// Una chiamata a uno strumento di Medea fatta dalla CLI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolCall {
    pub id: String,
    /// Il nome di Medea, senza il prefisso che gli mette la CLI.
    pub name: String,
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

/// Il nome dello strumento come lo conosce Medea.
fn nome_medea(name: &str) -> String {
    name.strip_prefix(&format!("mcp__{SERVER_MCP}__"))
        .unwrap_or(name)
        .to_string()
}

/// Il testo di un risultato: la CLI lo dà come stringa o come blocchi.
fn testo_risultato(content: &Value) -> Option<String> {
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

/// Legge l'uscita della CLI. L'errore è una frase da mostrare all'utente.
pub fn parse(stdout: &str) -> Result<ClaudeCliTurn, String> {
    let radice: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        "La CLI `claude` ha risposto in un formato che Medea non riconosce. \
         Aggiornala con `claude update` e riprova."
            .to_string()
    })?;
    // Le versioni recenti stampano l'elenco degli eventi; le precedenti il
    // solo esito. Valgono entrambe.
    let eventi: Vec<Value> = match radice {
        Value::Array(eventi) => eventi,
        altro => vec![altro],
    };

    let mut tool_calls: Vec<CliToolCall> = Vec::new();
    for evento in &eventi {
        match evento["type"].as_str() {
            Some("assistant") => {
                for blocco in blocchi(evento).filter(|b| b["type"] == "tool_use") {
                    tool_calls.push(CliToolCall {
                        id: blocco["id"].as_str().unwrap_or_default().to_string(),
                        name: nome_medea(blocco["name"].as_str().unwrap_or_default()),
                        arguments: blocco.get("input").cloned().unwrap_or(Value::Null),
                        output: None,
                        is_error: false,
                    });
                }
            }
            Some("user") => {
                for blocco in blocchi(evento).filter(|b| b["type"] == "tool_result") {
                    let id = blocco["tool_use_id"].as_str().unwrap_or_default();
                    if let Some(call) = tool_calls.iter_mut().find(|c| c.id == id) {
                        call.output = testo_risultato(&blocco["content"]);
                        call.is_error = blocco["is_error"].as_bool().unwrap_or(false);
                    }
                }
            }
            _ => {}
        }
    }

    let risultato = eventi
        .iter()
        .rev()
        .find(|e| e["type"] == "result")
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
        tool_calls,
        usage: uso(risultato),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// La forma vera di un turno, presa dalla CLI 2.1.296 l'11 ottobre 2026 e
    /// ridotta ai campi che contano: una lettura riuscita, poi uno strumento
    /// negato dai permessi.
    fn turno_vero() -> String {
        json!([
            { "type": "system", "subtype": "init", "tools": ["mcp__medea__datetime"] },
            { "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_01", "name": "mcp__medea__datetime",
                  "input": {}, "caller": { "type": "direct" } }
            ] } },
            { "type": "user", "message": { "content": [
                { "tool_use_id": "toolu_01", "type": "tool_result",
                  "content": [{ "type": "text", "text": "{\"date\":\"2026-10-11\"}" }] }
            ] } },
            { "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_02", "name": "mcp__medea__note_add",
                  "input": { "text": "prova" }, "caller": { "type": "direct" } }
            ] } },
            { "type": "user", "message": { "content": [
                { "type": "tool_result", "content": "Permission to use mcp__medea__note_add has been denied",
                  "is_error": true, "tool_use_id": "toolu_02" }
            ] } },
            { "type": "rate_limit_event" },
            { "type": "assistant", "message": { "content": [
                { "type": "text", "text": "Oggi è l'11 ottobre." }
            ] } },
            { "type": "result", "subtype": "success", "is_error": false,
              "result": "Oggi è l'11 ottobre.\n",
              "usage": { "input_tokens": 4, "cache_creation_input_tokens": 472,
                         "cache_read_input_tokens": 27822, "output_tokens": 213 } }
        ])
        .to_string()
    }

    #[test]
    fn il_testo_e_quello_dell_esito() {
        let turno = parse(&turno_vero()).expect("un turno");
        assert_eq!(turno.text, "Oggi è l'11 ottobre.");
    }

    #[test]
    fn le_chiamate_portano_il_nome_di_medea_e_il_loro_risultato() {
        let turno = parse(&turno_vero()).expect("un turno");
        assert_eq!(turno.tool_calls.len(), 2);

        let lettura = &turno.tool_calls[0];
        assert_eq!(lettura.name, "datetime");
        assert_eq!(lettura.output.as_deref(), Some("{\"date\":\"2026-10-11\"}"));
        assert!(!lettura.is_error);

        let negata = &turno.tool_calls[1];
        assert_eq!(negata.name, "note_add");
        assert_eq!(negata.arguments, json!({ "text": "prova" }));
        assert!(negata.is_error);
    }

    #[test]
    fn il_costo_conta_anche_i_token_presi_dalla_cache() {
        let turno = parse(&turno_vero()).expect("un turno");
        assert_eq!(
            turno.usage,
            Some(CliUsage {
                input: 4 + 472 + 27822,
                output: 213
            })
        );
    }

    #[test]
    fn un_esito_di_errore_diventa_un_errore_con_le_parole_della_cli() {
        let uscita = json!([{ "type": "result", "subtype": "error_during_execution",
                              "is_error": true, "result": "Please run /login" }])
        .to_string();
        let errore = parse(&uscita).expect_err("un errore");
        assert!(errore.contains("Please run /login"));
    }

    #[test]
    fn un_errore_senza_parole_dice_almeno_di_che_tipo() {
        let uscita = json!([{ "type": "result", "subtype": "error_max_turns", "is_error": true }])
            .to_string();
        let errore = parse(&uscita).expect_err("un errore");
        assert!(errore.contains("error_max_turns"));
    }

    #[test]
    fn vale_anche_il_solo_esito_delle_versioni_precedenti() {
        let uscita = json!({ "type": "result", "is_error": false, "result": "Ciao" }).to_string();
        let turno = parse(&uscita).expect("un turno");
        assert_eq!(turno.text, "Ciao");
        assert!(turno.tool_calls.is_empty());
        assert_eq!(turno.usage, None);
    }

    #[test]
    fn un_uscita_che_non_e_json_suggerisce_di_aggiornare_la_cli() {
        let errore = parse("Ciao, sono testo libero").expect_err("un errore");
        assert!(errore.contains("claude update"));
    }

    #[test]
    fn un_elenco_senza_esito_e_un_errore() {
        let uscita = json!([{ "type": "system", "subtype": "init" }]).to_string();
        assert!(parse(&uscita).is_err());
    }

    #[test]
    fn uno_strumento_che_non_e_di_medea_tiene_il_suo_nome() {
        let uscita = json!([
            { "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "t1", "name": "AltroStrumento", "input": {} }
            ] } },
            { "type": "result", "is_error": false, "result": "ok" }
        ])
        .to_string();
        let turno = parse(&uscita).expect("un turno");
        assert_eq!(turno.tool_calls[0].name, "AltroStrumento");
        assert_eq!(turno.tool_calls[0].output, None);
    }
}
