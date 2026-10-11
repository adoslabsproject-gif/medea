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
//! Qui c'è solo il tubo: cosa rispondere lo decide `medea_desktop_lib::mcp`.
//!
//! Uso:
//!   medea-mcp                       # letto da un client MCP via stdio
//!   medea-mcp --consenso-app        # avviato da Medea: le modifiche le
//!                                   # conferma l'utente nell'app
//!   claude --mcp-config <file.json> # config che punta a questo binario

use std::io::{BufRead, Write};

use medea_desktop_lib::db;
use medea_desktop_lib::mcp::{handle_line, Consenso};

fn main() {
    let consenso = Consenso::from_args(std::env::args());

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
        if let Some(response) = handle_line(consenso, trimmed) {
            let _ = writeln!(stdout, "{response}");
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
