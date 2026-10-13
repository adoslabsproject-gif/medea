//! Provider "Claude in abbonamento": Claude Code dentro il pannello di Medea.
//!
//! Lancia la CLI `claude` già installata e già autenticata sulla macchina,
//! invece di chiamare l'API a consumo. L'autenticazione è interamente della
//! CLI: se l'utente ha fatto `claude login` con un piano Pro/Max, il turno
//! consuma l'abbonamento. Medea non vede né conserva credenziali Anthropic.
//!
//! La CLI lavora con tutti i suoi strumenti e in più con quelli di Medea, che
//! le arrivano via **MCP** dal binario `medea_mcp`. Il testo scorre nel
//! pannello mentre viene scritto, e ogni azione che tocca il computer passa
//! da una conferma dell'utente.
//!
//! Qui ci sono solo i comandi: dove sta la CLI, con quali opzioni parte, come
//! si esegue un turno e come si legge quello che dice sono in
//! `crate::claude_cli`.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::claude_cli::events::ClaudeCliTurn;
use crate::claude_cli::locate::{self, Ambiente};
use crate::claude_cli::protocol::Evento;
use crate::claude_cli::run::{self, Luoghi, Richiesta};

/// Il canale su cui il pannello ascolta gli eventi dei turni.
pub const CANALE_EVENTI: &str = "claude-code:evento";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

/// Verifica se la CLI è installata e raggiungibile.
#[tauri::command]
pub async fn claude_cli_status() -> Result<ClaudeCliStatus, String> {
    tokio::task::spawn_blocking(|| {
        let Some(bin) = locate::locate() else {
            return ClaudeCliStatus {
                available: false,
                path: None,
                version: None,
                message: "CLI `claude` non trovata. Installala da https://claude.com/claude-code \
                          ed esegui `claude login` con il tuo piano Pro/Max."
                    .into(),
            };
        };
        let out = Command::new(&bin)
            .arg("--version")
            .env("PATH", Ambiente::corrente().path_esteso())
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                ClaudeCliStatus {
                    available: true,
                    path: Some(bin.display().to_string()),
                    version: Some(v),
                    message: "CLI pronta: i turni useranno il tuo abbonamento.".into(),
                }
            }
            Ok(o) => ClaudeCliStatus {
                available: false,
                path: Some(bin.display().to_string()),
                version: None,
                message: format!(
                    "CLI trovata ma non eseguibile: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ),
            },
            Err(e) => ClaudeCliStatus {
                available: false,
                path: Some(bin.display().to_string()),
                version: None,
                message: format!("CLI non avviabile: {e}"),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Il binario del server MCP, che sta accanto a quello dell'app.
fn mcp_binary() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join(if cfg!(windows) {
        "medea_mcp.exe"
    } else {
        "medea_mcp"
    })
}

/// Un evento di un turno, come lo riceve il pannello.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventoDelTurno {
    turn_id: String,
    #[serde(flatten)]
    evento: Evento,
}

/// Cosa chiede il pannello per un turno.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnoRichiesto {
    /// Lo sceglie il pannello: serve a rispondere ai permessi e a fermare.
    pub turn_id: String,
    pub prompt: String,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    /// La sessione della CLI da riprendere, dal turno precedente.
    pub session_id: Option<String>,
    /// La cartella di lavoro scelta dall'utente.
    pub cwd: Option<String>,
    pub allow_tools: bool,
}

/// Esegue un turno di Claude Code.
///
/// Mentre gira, gli eventi arrivano al pannello sul canale
/// [`CANALE_EVENTI`]; alla fine torna il turno intero.
#[tauri::command]
pub async fn claude_code_turno(
    app: tauri::AppHandle,
    richiesta: TurnoRichiesto,
) -> Result<ClaudeCliTurn, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cartella dati dell'app non disponibile: {e}"))?;
    tokio::task::spawn_blocking(move || {
        let cwd = richiesta
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(PathBuf::from);
        let turn_id = richiesta.turn_id.clone();
        run::esegui(
            &Luoghi {
                data_dir: &data_dir,
                mcp_bin: &mcp_binary(),
            },
            &Richiesta {
                turn_id: &richiesta.turn_id,
                prompt: &richiesta.prompt,
                system_prompt: richiesta.system_prompt.as_deref(),
                model: richiesta.model.as_deref(),
                resume: richiesta.session_id.as_deref(),
                cwd: cwd.as_deref(),
                allow_tools: richiesta.allow_tools,
            },
            |evento| {
                let _ = app.emit(
                    CANALE_EVENTI,
                    EventoDelTurno {
                        turn_id: turn_id.clone(),
                        evento,
                    },
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// La risposta dell'utente a una richiesta di permesso.
#[tauri::command]
pub fn claude_code_permesso(
    turn_id: String,
    request_id: String,
    consenti: bool,
    input: Value,
) -> Result<(), String> {
    run::rispondi_permesso(&turn_id, &request_id, consenti, &input)
}

/// Ferma un turno in corso. Fermarne uno già finito non è un errore.
#[tauri::command]
pub fn claude_code_ferma(turn_id: String) -> bool {
    run::ferma(&turn_id)
}

/// Fa scegliere all'utente la cartella in cui Claude Code lavora.
///
/// La finestra la apre Rust: il frontend riceve solo il percorso scelto, e
/// non ha nessun permesso per sfogliare il disco.
#[tauri::command]
pub async fn claude_code_scegli_cartella(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Cartella di lavoro di Claude Code")
            .blocking_pick_folder()
            .and_then(|scelta| scelta.into_path().ok())
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Il pannello distingue i turni dal loro nome e gli eventi dal `tipo`:
    /// le due cose viaggiano nello stesso oggetto, senza annidamenti.
    #[test]
    fn un_evento_arriva_al_pannello_piatto_con_il_nome_del_turno() {
        let v = serde_json::to_value(EventoDelTurno {
            turn_id: "t1".into(),
            evento: Evento::Testo {
                delta: "ciao".into(),
            },
        })
        .expect("json");
        assert_eq!(
            v,
            json!({ "turnId": "t1", "tipo": "testo", "delta": "ciao" })
        );
    }

    #[test]
    fn la_richiesta_del_pannello_si_legge_in_camel_case() {
        let r: TurnoRichiesto = serde_json::from_value(json!({
            "turnId": "t1", "prompt": "ciao", "allowTools": true,
            "sessionId": "s1", "cwd": "/progetti/x", "model": "sonnet",
        }))
        .expect("richiesta");
        assert_eq!(r.turn_id, "t1");
        assert_eq!(r.session_id.as_deref(), Some("s1"));
        assert_eq!(r.cwd.as_deref(), Some("/progetti/x"));
        assert!(r.system_prompt.is_none());
    }
}
