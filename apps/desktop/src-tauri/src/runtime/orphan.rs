//! Il motore non deve sopravvivere all'app.
//!
//! Alla chiusura ordinata ci pensa `Drop`: il processo figlio viene ucciso
//! insieme al padre. Ma una chiusura ordinata non è garantita — un crash, un
//! `kill -9`, il ricompilatore che stacca la sessione di sviluppo — e in quel
//! caso il processo Node resta vivo, tiene la sua porta e continua a eseguire
//! i workflow di un'app che non c'è più.
//!
//! Visto succedere davvero, con l'app terminata e il figlio ancora in elenco.
//!
//! Il rimedio è un biglietto lasciato sul disco: all'avvio si guarda se c'è un
//! processo di un giro precedente e lo si chiude. Prima di uccidere si
//! **verifica che sia davvero il nostro**: i numeri di processo si riciclano,
//! e uccidere alla cieca il pid scritto ieri significherebbe, prima o poi,
//! chiudere un programma di qualcun altro.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Il biglietto con il numero del processo dell'ultimo avvio.
fn pid_file(runtime_data: &Path) -> PathBuf {
    runtime_data.join("runtime.pid")
}

/// Come si riconosce un nostro processo fra i tanti.
const SIGNATURE: &str = "runtime/dist/main.js";

/// La riga di comando di un processo, se esiste ancora.
#[cfg(unix)]
fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("wmic")
        .args([
            "process",
            "where",
            &format!("ProcessId={pid}"),
            "get",
            "CommandLine",
        ])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

#[cfg(unix)]
fn terminate(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

#[cfg(windows)]
fn terminate(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();
}

/// Vero se quel processo è un motore dei workflow, e non un pid riciclato.
fn is_ours(pid: u32) -> bool {
    command_line(pid).is_some_and(|line| line.contains(SIGNATURE))
}

/// Chiude il motore rimasto in piedi da un avvio precedente, se c'è.
///
/// Silenzioso di proposito: il caso normale è che non ci sia niente da fare,
/// e un avviso a ogni apertura per una condizione che non è un problema
/// insegnerebbe solo a ignorare gli avvisi.
pub fn kill_stale(runtime_data: &Path) {
    let file = pid_file(runtime_data);
    let Ok(text) = std::fs::read_to_string(&file) else {
        return;
    };
    let _ = std::fs::remove_file(&file);

    let Ok(pid) = text.trim().parse::<u32>() else {
        return;
    };
    if !is_ours(pid) {
        return;
    }

    tracing::info!("Chiudo il motore dei workflow rimasto da un avvio precedente (pid {pid})");
    terminate(pid);
}

/// Lascia il biglietto per il prossimo avvio.
pub fn remember(runtime_data: &Path, pid: u32) {
    if let Err(e) = std::fs::write(pid_file(runtime_data), pid.to_string()) {
        // Non è un motivo per non partire: al massimo, un giorno, resterà un
        // processo orfano — che è esattamente la situazione di prima.
        tracing::warn!("Non sono riuscito a segnare il pid del motore: {e}");
    }
}

/// Toglie il biglietto: la chiusura è avvenuta come si deve.
pub fn forget(runtime_data: &Path) {
    let _ = std::fs::remove_file(pid_file(runtime_data));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Il pid di un processo che non è il nostro non si tocca.
    ///
    /// È la parte che conta: i numeri di processo si riciclano, e uccidere
    /// alla cieca il pid scritto ieri significherebbe, prima o poi, chiudere
    /// un programma di qualcun altro.
    #[test]
    fn non_riconosce_un_processo_estraneo() {
        // Il processo di prova stesso: esiste di sicuro, e non è un motore.
        assert!(!is_ours(std::process::id()));
    }

    #[test]
    fn un_pid_inesistente_non_e_nostro() {
        // Numero altissimo: non corrisponde a niente.
        assert!(!is_ours(4_294_000_000));
    }

    #[test]
    fn il_biglietto_si_scrive_e_si_toglie() {
        let dir = std::env::temp_dir().join(format!("medea-orphan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("cartella di prova");

        remember(&dir, 4242);
        assert_eq!(
            std::fs::read_to_string(pid_file(&dir)).expect("biglietto"),
            "4242"
        );

        forget(&dir);
        assert!(!pid_file(&dir).exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Senza biglietto non succede niente, e non si lamenta.
    #[test]
    fn senza_biglietto_non_fa_niente() {
        let dir = std::env::temp_dir().join("medea-orphan-vuota");
        std::fs::create_dir_all(&dir).expect("cartella di prova");
        kill_stale(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Un biglietto illeggibile viene buttato, non fa esplodere l'avvio.
    #[test]
    fn un_biglietto_illeggibile_viene_buttato() {
        let dir = std::env::temp_dir().join(format!("medea-orphan-rotto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("cartella di prova");
        std::fs::write(pid_file(&dir), "non un numero").expect("scrittura");

        kill_stale(&dir);
        assert!(!pid_file(&dir).exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
