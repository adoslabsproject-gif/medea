//! Il protocollo MCP di Medea: come i tool dell'assistente si presentano a un
//! client esterno e come rispondono alle sue chiamate.
//!
//! Il binario `medea_mcp` è solo il tubo — legge righe, scrive righe. La
//! logica sta qui perché la si possa provare senza avviare un processo.
//!
//! Chi chiama può essere di due specie, e la differenza è chi chiede il
//! permesso all'utente prima di una modifica:
//!
//!  - un client qualunque (Claude Desktop, Cursor, la CLI usata a mano) mostra
//!    la **sua** conferma prima di eseguire uno strumento;
//!  - la CLI lanciata **da Medea** gira senza nessuno davanti: non può
//!    chiedere niente a nessuno. Lì la conferma è dell'app, e uno strumento
//!    che modifica dati non viene eseguito: viene annunciato, e Medea lo
//!    esegue dopo il sì dell'utente.

use serde_json::{json, Value};

use crate::ai_tools;

pub const PROTOCOL_VERSION: &str = "2025-03-26";

/// L'argomento con cui Medea avvia il server quando la conferma è sua.
pub const ARG_CONSENSO_APP: &str = "--consenso-app";

/// Chi chiede il permesso all'utente prima di una modifica.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consenso {
    /// Il client MCP mostra la propria conferma.
    DelClient,
    /// Medea chiede dopo: qui gli strumenti sensibili non si eseguono.
    DellApp,
}

impl Consenso {
    /// Legge il modo dagli argomenti con cui il server è stato avviato.
    pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Self {
        if args.into_iter().any(|a| a == ARG_CONSENSO_APP) {
            Self::DellApp
        } else {
            Self::DelClient
        }
    }
}

pub fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "medea", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Tool di Medea: posta, agenda, appunti, anagrafiche, articoli, \
                         prezzi e documenti dell'utente. I tool che scrivono vanno usati \
                         solo su richiesta esplicita.",
    })
}

/// Vero se lo strumento è uno di quelli web di Medea.
///
/// Alla CLI lanciata da Medea non si offrono: Claude Code ha i suoi, con le
/// sue conferme. I nostri arriverebbero come doppioni, e — già permessi in
/// blocco insieme agli altri di Medea — aprirebbero pagine senza chiedere.
fn web_di_medea(name: &str) -> bool {
    name.starts_with("web_")
}

pub fn tools_list(consenso: Consenso) -> Value {
    let tools: Vec<Value> = ai_tools::registry()
        .into_iter()
        .filter(|t| !(consenso == Consenso::DellApp && web_di_medea(&t.name)))
        .map(|t| {
            let note = match (t.kind.as_str(), consenso) {
                ("sensitive", Consenso::DellApp) => {
                    " [MODIFICA DATI: l'utente conferma nell'app, lo strumento non viene \
                     eseguito subito]"
                }
                ("sensitive", Consenso::DelClient) => {
                    " [MODIFICA DATI: chiedi conferma all'utente prima di usarlo]"
                }
                ("proposal", _) => " [prepara una bozza: non invia né salva nulla da solo]",
                ("write", _) => " [scrive nel database locale]",
                _ => "",
            };
            json!({
                "name": t.name,
                "description": format!("{}{}", t.description, note),
                "inputSchema": t.params,
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// Di che specie è lo strumento, se esiste.
fn kind_of(name: &str) -> Option<String> {
    ai_tools::registry()
        .into_iter()
        .find(|t| t.name == name)
        .map(|t| t.kind)
}

/// Quello che il modello legge al posto dell'esecuzione di uno strumento
/// sensibile, quando la conferma è dell'app.
const CONSENSO_RICHIESTO: &str = "Questa azione modifica dati e NON è stata eseguita. \
     L'utente la vede nell'app e decide se confermarla. Non dire che è stata fatta e non \
     ripetere la chiamata: riassumi cosa hai proposto.";

/// Il risultato come deve leggerlo il modello: la resa a parole quando lo
/// strumento ne dà una, altrimenti i dati.
fn resa(result: &Value) -> String {
    result
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
        })
}

/// Una bozza, detta al modello in una riga.
///
/// Il contenuto non gli torna indietro: Medea lo mostra all'utente in una
/// scheda, e un documento intero rimesso nella conversazione verrebbe
/// ripetuto parola per parola nella risposta.
fn resa_bozza(result: &Value) -> String {
    let summary = result
        .get("summary")
        .and_then(|s| s.as_str())
        .unwrap_or("Bozza preparata");
    format!(
        "{summary}. La scheda è mostrata all'utente nell'app: l'azione NON è ancora \
         avvenuta, deve confermarla lui. Non ripetere il contenuto."
    )
}

fn contenuto(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

pub fn handle_call(consenso: Consenso, id: Option<Value>, params: &Value) -> Value {
    let id = id.unwrap_or(Value::Null);
    let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
        return error_response(id, -32602, "manca 'name'");
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let kind = kind_of(name);
    let dell_app = consenso == Consenso::DellApp;

    if dell_app && kind.as_deref() == Some("sensitive") {
        return ok(Some(id), contenuto(CONSENSO_RICHIESTO.to_string(), false));
    }
    if dell_app && web_di_medea(name) {
        return ok(
            Some(id),
            contenuto(
                "Per il web usa gli strumenti di Claude Code: WebSearch e WebFetch.".to_string(),
                true,
            ),
        );
    }

    match ai_tools::execute(name, &args) {
        Ok(result) => {
            let text = if dell_app && kind.as_deref() == Some("proposal") {
                resa_bozza(&result)
            } else {
                resa(&result)
            };
            ok(Some(id), contenuto(text, false))
        }
        // Un tool fallito non è un errore di protocollo: va restituito al
        // modello come contenuto, così può correggersi.
        Err(e) => ok(Some(id), contenuto(format!("Errore: {e}"), true)),
    }
}

/// Risponde a una riga del client. `None` quando non è dovuta risposta.
pub fn handle_line(consenso: Consenso, line: &str) -> Option<Value> {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return Some(error_response(
                Value::Null,
                -32700,
                &format!("parse error: {e}"),
            ))
        }
    };
    // Le notifiche (senza `id`) non vogliono risposta.
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "initialize" => Some(ok(id, initialize_result())),
        "tools/list" => Some(ok(id, tools_list(consenso))),
        "tools/call" => Some(handle_call(consenso, id, &params)),
        "ping" => Some(ok(id, json!({}))),
        // notifications/initialized e simili: nessuna risposta dovuta.
        _ if id.is_none() => None,
        _ => Some(error_response(
            id.unwrap_or(Value::Null),
            -32601,
            &format!("metodo non supportato: {method}"),
        )),
    }
}

fn ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests;
