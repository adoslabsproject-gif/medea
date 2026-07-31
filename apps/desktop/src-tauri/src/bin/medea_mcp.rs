//! Server MCP di Medea — espone i tool dell'assistente (email, agenda,
//! anagrafiche, documenti…) a qualunque client MCP: Claude Code CLI, Claude
//! Desktop, Cursor.
//!
//! Perché esiste: la CLI `claude` in abbonamento esegue i PROPRI tool
//! (Read/Edit/Bash) e non conosce quelli di Medea. MCP è il ponte: con questo
//! server la stessa CLI, autenticata col tuo piano Pro/Max, può leggere la
//! posta e usare l'anagrafica senza consumare crediti API.
//!
//! Trasporto: stdio, JSON-RPC 2.0 su righe (`Content-Length` non usato, un
//! messaggio per riga come da convenzione dei server MCP a stdio).
//!
//! Uso:
//!   medea-mcp                       # letto da un client MCP via stdio
//!   claude --mcp-config <file.json> # config che punta a questo binario

use std::io::{BufRead, Write};

use medea_desktop_lib::{ai_tools, db};
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2025-03-26";

fn main() {
    // Il DB è lo stesso dell'app: stessa cartella dati, stesse migrazioni.
    let data_dir = app_data_dir();
    if let Err(e) = db::init(data_dir) {
        eprintln!("medea-mcp: init DB fallito: {e}");
        std::process::exit(1);
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    error_response(Value::Null, -32700, &format!("parse error: {e}"))
                );
                let _ = stdout.flush();
                continue;
            }
        };
        // Le notifiche (senza `id`) non vogliono risposta.
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

        let response = match method {
            "initialize" => Some(ok(id.clone(), initialize_result())),
            "tools/list" => Some(ok(id.clone(), tools_list())),
            "tools/call" => Some(handle_call(id.clone(), &params)),
            "ping" => Some(ok(id.clone(), json!({}))),
            // notifications/initialized e simili: nessuna risposta dovuta.
            _ if id.is_none() => None,
            _ => Some(error_response(
                id.clone().unwrap_or(Value::Null),
                -32601,
                &format!("metodo non supportato: {method}"),
            )),
        };
        if let Some(resp) = response {
            let _ = writeln!(stdout, "{resp}");
            let _ = stdout.flush();
        }
    }
}

/// Cartella dati dell'app: deve coincidere con quella usata da Tauri,
/// altrimenti il server leggerebbe un DB diverso da quello della UI.
fn app_data_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("MEDEA_DATA_DIR") {
        return std::path::PathBuf::from(dir);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    let base = std::path::PathBuf::from(home);
    if cfg!(target_os = "macos") {
        base.join("Library/Application Support/com.adoslabs.medea")
    } else if cfg!(target_os = "windows") {
        base.join("AppData/Roaming/com.adoslabs.medea")
    } else {
        base.join(".local/share/com.adoslabs.medea")
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "medea", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Tool di Medea: posta, agenda, appunti, anagrafiche, articoli, \
                         prezzi e documenti dell'utente. I tool che scrivono vanno usati \
                         solo su richiesta esplicita.",
    })
}

fn tools_list() -> Value {
    let tools: Vec<Value> = ai_tools::registry()
        .into_iter()
        .map(|t| {
            // `sensitive` e `proposal` restano annotati nella descrizione: il
            // client MCP mostrerà comunque la sua conferma prima di eseguirli.
            let note = match t.kind.as_str() {
                "sensitive" => " [MODIFICA DATI: chiedi conferma all'utente prima di usarlo]",
                "proposal" => " [prepara una bozza: non invia né salva nulla da solo]",
                "write" => " [scrive nel database locale]",
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

fn handle_call(id: Option<Value>, params: &Value) -> Value {
    let id = id.unwrap_or(Value::Null);
    let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
        return error_response(id, -32602, "manca 'name'");
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match ai_tools::execute(name, &args) {
        Ok(result) => {
            // I tool ritornano un campo `text` in italiano quando esiste una
            // resa naturale; altrimenti si serializza il JSON.
            let text = result
                .get("text")
                .and_then(|t| t.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string())
                });
            ok(
                Some(id),
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": false,
                }),
            )
        }
        // Un tool fallito non è un errore di protocollo: va restituito al
        // modello come contenuto, così può correggersi.
        Err(e) => ok(
            Some(id),
            json!({
                "content": [{ "type": "text", "text": format!("Errore: {e}") }],
                "isError": true,
            }),
        ),
    }
}

fn ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
