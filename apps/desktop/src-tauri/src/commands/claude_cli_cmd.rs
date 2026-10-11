//! Provider "Claude in abbonamento": lancia la CLI `claude` già installata e
//! già autenticata sulla macchina, invece di chiamare l'API a consumo.
//!
//! L'autenticazione è interamente della CLI: se l'utente ha fatto
//! `claude login` con un piano Pro/Max, il turno consuma l'abbonamento e non
//! genera costi API. Medea non vede né conserva credenziali Anthropic.
//!
//! I tool di Medea arrivano alla CLI via **MCP**: le passiamo un file di
//! configurazione che punta al binario `medea_mcp`, quindi la CLI può leggere
//! la posta e usare l'anagrafica pur eseguendo il proprio loop agentico.
//!
//! Qui ci sono solo i comandi: dove sta la CLI, con quali opzioni parte, come
//! si esegue un turno e come si legge la risposta sono in `crate::claude_cli`.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::Manager;

use crate::claude_cli::events::ClaudeCliTurn;
use crate::claude_cli::locate::{self, Ambiente};
use crate::claude_cli::run::{esegui, Luoghi, Richiesta};

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

/// Esegue un turno con la CLI in modalità headless.
///
/// Non è streaming: la UI di Medea mostra comunque uno stato di attesa, e il
/// turno arriva in blocco — il testo finale insieme agli strumenti usati.
#[tauri::command]
pub async fn claude_cli_run(
    app: tauri::AppHandle,
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
    allow_tools: bool,
) -> Result<ClaudeCliTurn, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cartella dati dell'app non disponibile: {e}"))?;
    tokio::task::spawn_blocking(move || {
        esegui(
            &Luoghi {
                data_dir: &data_dir,
                mcp_bin: &mcp_binary(),
            },
            &Richiesta {
                prompt: &prompt,
                system_prompt: system_prompt.as_deref(),
                model: model.as_deref(),
                allow_tools,
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
