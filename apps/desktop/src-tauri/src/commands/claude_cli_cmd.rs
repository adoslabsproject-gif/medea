//! Provider "Claude in abbonamento": lancia la CLI `claude` già installata e
//! già autenticata sulla macchina, invece di chiamare l'API a consumo.
//!
//! L'autenticazione è interamente della CLI: se l'utente ha fatto
//! `claude login` con un piano Pro/Max, il turno consuma l'abbonamento e non
//! genera costi API. Medea non vede né conserva credenziali Anthropic.
//!
//! I tool di Medea arrivano alla CLI via **MCP**: le passiamo un file di
//! configurazione che punta al binario `medea-mcp`, quindi la CLI può leggere
//! la posta e usare l'anagrafica pur eseguendo il proprio loop agentico.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;

/// Percorsi tipici della CLI. Tauri eredita un PATH scarno, quindi la
/// ricerca per nome fallirebbe anche con la CLI installata.
fn candidate_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        PathBuf::from(format!("{home}/.local/bin/claude")),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from(format!("{home}/.claude/local/claude")),
        PathBuf::from(format!("{home}/.npm-global/bin/claude")),
        PathBuf::from(format!("{home}/.bun/bin/claude")),
    ]
}

fn locate_claude() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|p| p.is_file())
}

/// PATH allargato: la CLI può a sua volta invocare node/npx.
fn extended_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    let extra = [
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        format!("{home}/.cargo/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.npm-global/bin"),
    ];
    let mut parts: Vec<String> = extra.to_vec();
    parts.push(current);
    parts.join(":")
}

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
        let Some(bin) = locate_claude() else {
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
            .env("PATH", extended_path())
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

/// Scrive la config MCP che espone i tool di Medea alla CLI.
/// Ritorna il percorso del file temporaneo.
fn write_mcp_config() -> std::io::Result<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let mcp_bin = exe_dir.join(if cfg!(windows) {
        "medea_mcp.exe"
    } else {
        "medea_mcp"
    });

    let cfg = serde_json::json!({
        "mcpServers": {
            "medea": {
                "command": mcp_bin.display().to_string(),
                "args": [],
                "env": {},
            }
        }
    });
    let dir = std::env::temp_dir().join("medea-mcp");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("mcp-config.json");
    let mut f = std::fs::File::create(&path)?;
    f.write_all(serde_json::to_string_pretty(&cfg)?.as_bytes())?;
    Ok(path)
}

/// Esegue un turno con la CLI in modalità headless e ritorna il testo finale.
///
/// Non è streaming: la UI di Medea mostra comunque uno stato di attesa, e il
/// testo arriva in blocco. Lo streaming richiederebbe un canale di eventi
/// dedicato — si può aggiungere senza cambiare questa firma.
#[tauri::command]
pub async fn claude_cli_run(
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
    allow_tools: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let bin = locate_claude().ok_or_else(|| {
            "CLI `claude` non trovata. Installala e fai `claude login`.".to_string()
        })?;

        let mut cmd = Command::new(&bin);
        cmd.arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("text")
            // La CLI non deve toccare il filesystem: qui serve solo come
            // motore di ragionamento con i tool di Medea.
            .arg("--permission-mode")
            .arg("plan")
            .env("PATH", extended_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(sys) = system_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--append-system-prompt").arg(sys);
        }
        if let Some(m) = model
            .as_deref()
            .filter(|m| !m.trim().is_empty() && *m != "default")
        {
            cmd.arg("--model").arg(m);
        }
        if allow_tools {
            match write_mcp_config() {
                Ok(cfg) => {
                    cmd.arg("--mcp-config")
                        .arg(cfg)
                        .arg("--allowedTools")
                        .arg("mcp__medea__*");
                }
                Err(e) => {
                    tracing::warn!("config MCP non scritta, proseguo senza tool Medea: {e}");
                }
            }
        }

        let out = cmd
            .output()
            .map_err(|e| format!("Avvio CLI fallito: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail: String = err
                .chars()
                .rev()
                .take(800)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            return Err(format!(
                "claude è uscita con codice {}: {tail}",
                out.status.code().unwrap_or(-1)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
